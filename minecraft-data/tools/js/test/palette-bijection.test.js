/* eslint-env mocha */

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const MC_DATA_ROOT = path.resolve(__dirname, '../../../')
const PALETTE_PATH = path.join(MC_DATA_ROOT, 'tools', 'palette-261.json')
const PROTOCOL_JSON_PATH = path.join(MC_DATA_ROOT, 'data', 'pc', '26.1', 'protocol.json')

const dictionaries = [
  { direction: 'playToClient', protocolSection: ['play', 'toClient'] },
  { direction: 'playToServer', protocolSection: ['play', 'toServer'] },
  { direction: 'configurationToClient', protocolSection: ['configuration', 'toClient'] },
  { direction: 'configurationToServer', protocolSection: ['configuration', 'toServer'] }
]

function fmtHex (id) {
  return `0x${id.toString(16).toUpperCase().padStart(2, '0')}`
}

function extractProtocolMappings (protocol, sectionPath) {
  let cursor = protocol
  for (const key of sectionPath) cursor = cursor[key]

  const packet = cursor.types.packet
  assert.ok(Array.isArray(packet) && packet[0] === 'container')
  const nameField = packet[1].find(field => field && field.name === 'name')
  assert.strictEqual(nameField.type[0], 'mapper')

  return new Map(Object.entries(nameField.type[1].mappings).map(([id, name]) => [parseInt(id, 16), name]))
}

function fixtureMappings (fixture, direction) {
  const entries = fixture[direction]
  assert.ok(Array.isArray(entries), `palette fixture must contain ${direction}`)
  return new Map(entries.flatMap((name, id) => name === null ? [] : [[id, name]]))
}

describe('26.1 packet palette fixture', function () {
  const fixture = JSON.parse(fs.readFileSync(PALETTE_PATH, 'utf8'))
  const protocol = JSON.parse(fs.readFileSync(PROTOCOL_JSON_PATH, 'utf8'))

  dictionaries.forEach(function ({ direction, protocolSection }) {
    it(`${direction} matches the frozen packet palette`, function () {
      const expected = fixtureMappings(fixture, direction)
      const actual = extractProtocolMappings(protocol, protocolSection)

      assert.strictEqual(actual.size, expected.size)
      assert.deepStrictEqual([...actual], [...expected])
      assert.strictEqual(new Set(actual.values()).size, actual.size, `${direction} has duplicate packet names`)
    })
  })

  it('preserves the expected dense clientbound spaces', function () {
    for (const { direction, protocolSection, lastId } of [
      { direction: 'playToClient', protocolSection: ['play', 'toClient'], lastId: 0x8c },
      { direction: 'configurationToClient', protocolSection: ['configuration', 'toClient'], lastId: 0x13 },
      { direction: 'configurationToServer', protocolSection: ['configuration', 'toServer'], lastId: 0x09 }
    ]) {
      const ids = [...extractProtocolMappings(protocol, protocolSection).keys()]
      assert.strictEqual(ids.length, lastId + 1, `${direction} has the wrong packet count`)
      ids.forEach((id, index) => assert.strictEqual(id, index, `${direction} is missing ${fmtHex(index)}`))
    }
  })

  it('preserves the intentional play.toServer gap at 0x3E', function () {
    const ids = fixtureMappings(fixture, 'playToServer')
    assert.ok(!ids.has(0x3e))
    assert.deepStrictEqual(
      [...extractProtocolMappings(protocol, ['play', 'toServer']).keys()],
      [...ids.keys()]
    )
  })
})
