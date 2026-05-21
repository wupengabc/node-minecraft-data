/* eslint-env mocha */
//
// Task 3.5 — Palette ↔ protocol.json bijection.
//
// Property 1: PacketPalette261 ↔ protocol.json bijection
//
// For each csharpName in the four PacketPalette261 dictionaries
// (typeIn, typeOut, configurationTypesIn, configurationTypesOut),
// data/pc/26.1/protocol.json must contain exactly one packet at the
// matching id and with the matching snake_case name (looked up via
// tools/palette-name-map.json). And vice versa: every packet declared
// in protocol.json must correspond to exactly one csharpName.
//
// Additional structural invariants:
//   * play.toClient ids are dense [0x00, 0x8C] (141 entries, no gaps,
//     no duplicates). Requirement 6.7 / 2.3.
//   * configuration.toClient ids are dense [0x00, 0x13]. Requirement 3.3.
//   * configuration.toServer ids are dense [0x00, 0x09]. Requirement 3.4.
//   * play.toServer ids match the palette dictionary id-set exactly,
//     including MCC's intentional hole at 0x3E. Requirement 2.4.
//   * No id or packet name is duplicated within a direction in
//     protocol.json. Requirement 6.1, 6.2.
//
// Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.2, 3.3,
//            3.4, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 7.1, 8.4
//
// The input domain is finite (every entry in the palette and every
// entry in protocol.json), so this is a structural property test
// expressed with mocha + assert — no fast-check is needed: each
// `it(...)` iterates over the entire domain.
//
// The C# palette is parsed with the same regex strategy that
// tools/verify-palette-261.js uses. We duplicate the regex inline
// here (rather than `require`-ing verify-palette-261.js) because that
// script invokes main() unconditionally at module load time and would
// call process.exit(0) on a clean repo, terminating the test runner.

const assert = require('assert')
const fs = require('fs')
const path = require('path')

// --- Path resolution -------------------------------------------------------

const TOOLS_JS_DIR = __dirname // .../minecraft-data/tools/js/test
const MC_DATA_ROOT = path.resolve(TOOLS_JS_DIR, '../../../') // .../minecraft-data
const WORKSPACE_ROOT = path.resolve(MC_DATA_ROOT, '../') // .../mineflayer_myself

const PALETTE_CS_PATH = path.join(
  WORKSPACE_ROOT,
  'Minecraft-Console-Client',
  'MinecraftClient',
  'Protocol',
  'Handlers',
  'PacketPalettes',
  'PacketPalette261.cs'
)
const NAME_MAP_PATH = path.join(MC_DATA_ROOT, 'tools', 'palette-name-map.json')
const PROTOCOL_JSON_PATH = path.join(
  MC_DATA_ROOT,
  'data',
  'pc',
  '26.1',
  'protocol.json'
)

// --- Dictionary descriptors ------------------------------------------------
//
// (kept in lockstep with tools/verify-palette-261.js)

const DICTIONARIES = [
  {
    direction: 'playToClient',
    csharpField: 'typeIn',
    enumPrefix: 'PacketTypesIn',
    protocolSection: ['play', 'toClient']
  },
  {
    direction: 'playToServer',
    csharpField: 'typeOut',
    enumPrefix: 'PacketTypesOut',
    protocolSection: ['play', 'toServer']
  },
  {
    direction: 'configurationToClient',
    csharpField: 'configurationTypesIn',
    enumPrefix: 'ConfigurationPacketTypesIn',
    protocolSection: ['configuration', 'toClient']
  },
  {
    direction: 'configurationToServer',
    csharpField: 'configurationTypesOut',
    enumPrefix: 'ConfigurationPacketTypesOut',
    protocolSection: ['configuration', 'toServer']
  }
]

// --- Inline C# dictionary parser (duplicated from verify-palette-261.js) ---

/**
 * Locate one dictionary block inside PacketPalette261.cs by csharp field
 * name. Walks the source counting braces (and skipping comments / string
 * literals) to find the matching closing brace.
 */
function locateDictionaryBlock (source, csharpField) {
  const headerRe = new RegExp(
    '\\b' + csharpField + '\\s*=\\s*new\\s*\\(\\s*\\)',
    'm'
  )
  const m = headerRe.exec(source)
  if (!m) return null

  let i = m.index + m[0].length
  while (i < source.length && source[i] !== '{') i++
  if (i >= source.length) return null

  let depth = 0
  const start = i
  for (; i < source.length; i++) {
    const c = source[i]
    const next = source[i + 1]

    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (
        i < source.length - 1 &&
        !(source[i] === '*' && source[i + 1] === '/')
      ) {
        i++
      }
      i++
      continue
    }
    if (c === '"' || c === '\'') {
      const quote = c
      i++
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++
        i++
      }
      continue
    }

    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        return source.slice(start, i + 1)
      }
    }
  }
  return null
}

/**
 * Parse all `{ 0xNN, EnumPrefix.Member }` entries inside a dictionary block.
 * Returns Map<number, csharpName>. Throws on duplicate id within the block.
 */
function parseEntries (block, enumPrefix) {
  const entryRe = new RegExp(
    '\\{\\s*0x([0-9A-Fa-f]+)\\s*,\\s*' +
      enumPrefix +
      '\\.(\\w+)\\s*\\}',
    'g'
  )
  const map = new Map()
  let m
  while ((m = entryRe.exec(block)) !== null) {
    const id = parseInt(m[1], 16)
    const name = m[2]
    if (map.has(id)) {
      throw new Error(
        `duplicate id 0x${id
          .toString(16)
          .toUpperCase()
          .padStart(2, '0')} in ${enumPrefix} (csharpName=${name}, previous=${map.get(id)})`
      )
    }
    map.set(id, name)
  }
  return map
}

function fmtHex (id) {
  return '0x' + id.toString(16).toUpperCase().padStart(2, '0')
}

// --- protocol.json mapping extraction --------------------------------------

/**
 * Walk into protocol[section[0]][section[1]].types.packet, then pull out
 * the id -> packet-name mappings from the "name" field's mapper.
 *
 * Returns Map<number, string>. Throws if the structure isn't the expected
 * protodef container/mapper shape.
 */
function extractProtocolMappings (protocol, sectionPath) {
  let cursor = protocol
  for (const key of sectionPath) {
    assert.ok(
      cursor && Object.prototype.hasOwnProperty.call(cursor, key),
      `protocol.json: missing key "${key}" while walking [${sectionPath.join(
        ','
      )}]`
    )
    cursor = cursor[key]
  }

  const types = cursor && cursor.types
  assert.ok(
    types && typeof types === 'object',
    `protocol.json: ${sectionPath.join('.')}.types must be an object`
  )
  const packet = types.packet
  assert.ok(
    Array.isArray(packet) && packet[0] === 'container' && Array.isArray(packet[1]),
    `protocol.json: ${sectionPath.join('.')}.types.packet must be a protodef container`
  )

  const nameField = packet[1].find((f) => f && f.name === 'name')
  assert.ok(
    nameField && Array.isArray(nameField.type) && nameField.type[0] === 'mapper',
    `protocol.json: ${sectionPath.join('.')} must declare a "name" field whose type is a mapper`
  )
  const mappings = nameField.type[1] && nameField.type[1].mappings
  assert.ok(
    mappings && typeof mappings === 'object',
    `protocol.json: ${sectionPath.join('.')} "name" mapper must declare mappings`
  )

  const idToName = new Map()
  for (const [hex, name] of Object.entries(mappings)) {
    const id = parseInt(hex, 16)
    assert.ok(
      !Number.isNaN(id),
      `protocol.json: ${sectionPath.join('.')} mapping key "${hex}" is not a hex integer`
    )
    assert.ok(
      typeof name === 'string' && name.length > 0,
      `protocol.json: ${sectionPath.join('.')} mapping for ${hex} must be a non-empty string`
    )
    assert.ok(
      !idToName.has(id),
      `protocol.json: ${sectionPath.join('.')} declares id ${fmtHex(id)} more than once`
    )
    idToName.set(id, String(name))
  }
  return idToName
}

// --- Test fixture (loaded once, shared across cases) -----------------------

let csharpSource
let nameMap
let protocol
const palette = {} // direction -> Map<id, csharpName>

before(function () {
  csharpSource = fs.readFileSync(PALETTE_CS_PATH, 'utf8')
  nameMap = JSON.parse(fs.readFileSync(NAME_MAP_PATH, 'utf8'))
  protocol = JSON.parse(fs.readFileSync(PROTOCOL_JSON_PATH, 'utf8'))

  for (const dict of DICTIONARIES) {
    const block = locateDictionaryBlock(csharpSource, dict.csharpField)
    assert.ok(
      block !== null,
      `failed to locate dictionary block "${dict.csharpField}" in PacketPalette261.cs`
    )
    const entries = parseEntries(block, dict.enumPrefix)
    assert.ok(
      entries.size > 0,
      `regex matched zero entries in PacketPalette261.cs ${dict.csharpField}`
    )
    palette[dict.direction] = entries
  }
})

// --- Test cases ------------------------------------------------------------

describe('PacketPalette261 ↔ data/pc/26.1/protocol.json bijection', function () {
  this.timeout(15 * 1000)

  describe('palette → protocol.json (every csharpName has a unique snake_case match)', function () {
    DICTIONARIES.forEach(function (dict) {
      it(`${dict.direction}: every csharpName resolves to a single protocol.json entry at the same id`, function () {
        const paletteEntries = palette[dict.direction]
        const directionNameTable = nameMap[dict.direction] || {}
        const protocolMappings = extractProtocolMappings(
          protocol,
          dict.protocolSection
        )

        for (const [id, csharpName] of paletteEntries) {
          const snakeName = directionNameTable[csharpName]
          assert.ok(
            typeof snakeName === 'string' && snakeName.length > 0,
            `palette-name-map.json[${dict.direction}] is missing csharpName "${csharpName}" (id ${fmtHex(id)})`
          )

          assert.ok(
            protocolMappings.has(id),
            `protocol.json[${dict.protocolSection.join(
              '.'
            )}] is missing id ${fmtHex(id)} (csharpName=${csharpName}, snakeName=${snakeName})`
          )

          const protoName = protocolMappings.get(id)
          assert.strictEqual(
            protoName,
            snakeName,
            `protocol.json[${dict.protocolSection.join(
              '.'
            )}] declares id ${fmtHex(id)} as "${protoName}", but palette-name-map.json maps csharpName "${csharpName}" to "${snakeName}"`
          )
        }
      })
    })
  })

  describe('protocol.json → palette (every protocol.json entry has exactly one csharpName)', function () {
    DICTIONARIES.forEach(function (dict) {
      it(`${dict.direction}: every protocol.json mapping is backed by exactly one PacketPalette261 csharpName`, function () {
        const paletteEntries = palette[dict.direction]
        const directionNameTable = nameMap[dict.direction] || {}
        const protocolMappings = extractProtocolMappings(
          protocol,
          dict.protocolSection
        )

        // Build reverse map snakeName -> csharpName, asserting uniqueness.
        const reverse = new Map()
        for (const [csharpName, snakeName] of Object.entries(directionNameTable)) {
          assert.ok(
            !reverse.has(snakeName),
            `palette-name-map.json[${dict.direction}] maps multiple csharpNames to the same snake_case "${snakeName}" (e.g. "${reverse.get(snakeName)}" and "${csharpName}")`
          )
          reverse.set(snakeName, csharpName)
        }

        for (const [id, snakeName] of protocolMappings) {
          // (1) Some csharpName must own this snake_case name.
          const csharpName = reverse.get(snakeName)
          assert.ok(
            typeof csharpName === 'string',
            `protocol.json[${dict.protocolSection.join(
              '.'
            )}] declares "${snakeName}" at id ${fmtHex(id)}, but palette-name-map.json[${dict.direction}] has no csharpName mapped to it`
          )

          // (2) That csharpName must appear in the palette dictionary at the
          //     same id (palette is the source of truth).
          assert.ok(
            paletteEntries.has(id),
            `protocol.json[${dict.protocolSection.join(
              '.'
            )}] declares id ${fmtHex(id)} (${snakeName}), but PacketPalette261 ${dict.csharpField} has no entry at that id`
          )
          const paletteCsharp = paletteEntries.get(id)
          assert.strictEqual(
            paletteCsharp,
            csharpName,
            `id ${fmtHex(id)}: protocol.json says "${snakeName}" → "${csharpName}", but PacketPalette261 ${dict.csharpField} has csharpName "${paletteCsharp}"`
          )
        }
      })
    })
  })

  describe('protocol.json structural invariants per direction', function () {
    DICTIONARIES.forEach(function (dict) {
      it(`${dict.direction}: protocol.json mapping ids and names are each unique`, function () {
        const protocolMappings = extractProtocolMappings(
          protocol,
          dict.protocolSection
        )
        // id-uniqueness already enforced inside extractProtocolMappings
        // (Map throws via the assertion when a duplicate hex key shows up).
        const seenNames = new Map() // name -> id where it first appeared
        for (const [id, name] of protocolMappings) {
          if (seenNames.has(name)) {
            assert.fail(
              `protocol.json[${dict.protocolSection.join(
                '.'
              )}] declares packet name "${name}" at both ${fmtHex(seenNames.get(name))} and ${fmtHex(id)}`
            )
          }
          seenNames.set(name, id)
        }
      })

      it(`${dict.direction}: protocol.json size equals PacketPalette261 ${dict.csharpField} size`, function () {
        const protocolMappings = extractProtocolMappings(
          protocol,
          dict.protocolSection
        )
        const paletteEntries = palette[dict.direction]
        assert.strictEqual(
          protocolMappings.size,
          paletteEntries.size,
          `${dict.direction}: protocol.json has ${protocolMappings.size} entries, PacketPalette261 ${dict.csharpField} has ${paletteEntries.size}`
        )
      })
    })
  })

  describe('id-space shape (denseness, holes)', function () {
    it('play.toClient is dense [0x00, 0x8C] in protocol.json (Requirement 6.7)', function () {
      const protocolMappings = extractProtocolMappings(protocol, ['play', 'toClient'])
      const ids = Array.from(protocolMappings.keys()).sort((a, b) => a - b)

      assert.strictEqual(
        ids.length,
        0x8c - 0x00 + 1,
        `play.toClient should have ${0x8c + 1} entries (dense [0x00, 0x8C]), found ${ids.length}`
      )
      assert.strictEqual(ids[0], 0x00, `play.toClient first id should be 0x00, got ${fmtHex(ids[0])}`)
      assert.strictEqual(
        ids[ids.length - 1],
        0x8c,
        `play.toClient last id should be 0x8C, got ${fmtHex(ids[ids.length - 1])}`
      )

      for (let i = 0; i < ids.length; i++) {
        assert.strictEqual(
          ids[i],
          i,
          `play.toClient id at index ${i} should be ${fmtHex(i)}, got ${fmtHex(ids[i])} (gap or duplicate detected)`
        )
      }
    })

    it('configuration.toClient is dense [0x00, 0x13] in protocol.json (Requirement 3.3)', function () {
      const protocolMappings = extractProtocolMappings(protocol, [
        'configuration',
        'toClient'
      ])
      const ids = Array.from(protocolMappings.keys()).sort((a, b) => a - b)
      assert.strictEqual(ids.length, 0x13 - 0x00 + 1, 'configuration.toClient must be dense [0x00, 0x13]')
      for (let i = 0; i < ids.length; i++) {
        assert.strictEqual(ids[i], i, `configuration.toClient id at index ${i} should be ${fmtHex(i)}, got ${fmtHex(ids[i])}`)
      }
    })

    it('configuration.toServer is dense [0x00, 0x09] in protocol.json (Requirement 3.4)', function () {
      const protocolMappings = extractProtocolMappings(protocol, [
        'configuration',
        'toServer'
      ])
      const ids = Array.from(protocolMappings.keys()).sort((a, b) => a - b)
      assert.strictEqual(ids.length, 0x09 - 0x00 + 1, 'configuration.toServer must be dense [0x00, 0x09]')
      for (let i = 0; i < ids.length; i++) {
        assert.strictEqual(ids[i], i, `configuration.toServer id at index ${i} should be ${fmtHex(i)}, got ${fmtHex(ids[i])}`)
      }
    })

    it('play.toServer id-set in protocol.json equals PacketPalette261.typeOut id-set (preserves any holes such as 0x3E)', function () {
      const protocolMappings = extractProtocolMappings(protocol, ['play', 'toServer'])
      const protoIds = new Set(protocolMappings.keys())
      const paletteIds = new Set(palette.playToServer.keys())

      const onlyInProtocol = [...protoIds].filter((id) => !paletteIds.has(id)).sort((a, b) => a - b)
      const onlyInPalette = [...paletteIds].filter((id) => !protoIds.has(id)).sort((a, b) => a - b)

      assert.deepStrictEqual(
        onlyInProtocol,
        [],
        `play.toServer has ids in protocol.json that are absent from PacketPalette261.typeOut: ${onlyInProtocol.map(fmtHex).join(', ')}`
      )
      assert.deepStrictEqual(
        onlyInPalette,
        [],
        `play.toServer has ids in PacketPalette261.typeOut that are absent from protocol.json: ${onlyInPalette.map(fmtHex).join(', ')}`
      )
    })
  })
})
