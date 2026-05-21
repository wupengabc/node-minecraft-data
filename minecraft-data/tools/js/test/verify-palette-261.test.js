/* eslint-env mocha */
//
// Task 2.4 — Property-style exit-code semantics for verify-palette-261.js.
//
// Validates: Requirements 7.2, 7.3, 7.4, 7.5
//
// Exit-code contract under test (see tools/verify-palette-261.js header):
//   0  Palettes are equivalent (no drift).
//   1  Palette drift detected (entries missing-from / extra-in protocol.json).
//   2  Failed to regex-parse one or more dictionaries from PacketPalette261.cs.
//   3  palette-name-map.json is missing one or more csharpName entries.
//
// We use plain mocha + assert here because tools/js does not depend on
// fast-check. Each parameterised case mutates a *temporary copy* of the
// relevant source file, runs the script, and restores the original — all
// inside a try/finally with an `after` safety net so a hard test failure
// can never leave the repo in a polluted state.
//
// Exit code 2 (regex parse failure) is intentionally not exercised: it
// would require modifying PacketPalette261.cs, which lives under
// Minecraft-Console-Client/ and is treated as read-only by this spec.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const MC_DATA_ROOT = path.resolve(__dirname, '../../../')
const SCRIPT_PATH = path.join(MC_DATA_ROOT, 'tools', 'verify-palette-261.js')
const NAME_MAP_PATH = path.join(MC_DATA_ROOT, 'tools', 'palette-name-map.json')
const PROTOCOL_JSON_PATH = path.join(MC_DATA_ROOT, 'data', 'pc', '26.1', 'protocol.json')

// --- Helpers ---------------------------------------------------------------

// Track files we've backed up so the `after` safety net can always restore them.
const backups = new Map() // filePath -> original utf8 contents

function backupAndOverwrite (filePath, newContents) {
  if (!backups.has(filePath)) {
    backups.set(filePath, fs.readFileSync(filePath, 'utf8'))
  }
  fs.writeFileSync(filePath, newContents)
}

function restore (filePath) {
  if (backups.has(filePath)) {
    fs.writeFileSync(filePath, backups.get(filePath))
    backups.delete(filePath)
  }
}

function restoreAll () {
  for (const [filePath, original] of backups) {
    try {
      fs.writeFileSync(filePath, original)
    } catch (_) {
      // best-effort restore; we still want to clear the map
    }
  }
  backups.clear()
}

function runScript () {
  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd: MC_DATA_ROOT,
    encoding: 'utf8'
  })
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  }
}

// --- Tests -----------------------------------------------------------------

describe('verify-palette-261.js exit-code semantics', function () {
  this.timeout(15 * 1000)

  // Final safety net: if any test left a backup behind, undo it now.
  after(function () {
    restoreAll()
  })

  it('exits 0 when palette and protocol.json are in sync (clean state)', function () {
    const { status, stdout } = runScript()
    assert.strictEqual(
      status,
      0,
      `expected exit 0 in clean state, got ${status}\nstdout:\n${stdout}`
    )
    assert.match(stdout, /\bOK\b/, 'clean run should print "OK" before exiting')
  })

  it('exits 3 when palette-name-map.json is missing a csharpName', function () {
    const original = fs.readFileSync(NAME_MAP_PATH, 'utf8')
    const parsed = JSON.parse(original)

    // Pick any one entry from playToClient and remove it. The exact key
    // doesn't matter — the contract is "any missing csharpName -> exit 3".
    const directionTable = parsed.playToClient
    const keys = Object.keys(directionTable)
    assert.ok(keys.length > 0, 'palette-name-map.json playToClient must have entries')
    const removedKey = keys[0]
    delete directionTable[removedKey]

    try {
      backupAndOverwrite(NAME_MAP_PATH, JSON.stringify(parsed, null, 2))
      const { status, stdout, stderr } = runScript()
      assert.strictEqual(
        status,
        3,
        `expected exit 3 when "${removedKey}" is missing from palette-name-map.json, got ${status}\n` +
          `stdout:\n${stdout}\nstderr:\n${stderr}`
      )
      // The script writes its "missing entries" message to stderr (via die()).
      // Tolerate either stream for portability.
      const combined = stdout + stderr
      assert.ok(
        combined.includes(removedKey),
        `expected output to mention removed csharpName "${removedKey}"\n` +
          `stdout:\n${stdout}\nstderr:\n${stderr}`
      )
    } finally {
      restore(NAME_MAP_PATH)
    }
  })

  it('exits 1 when protocol.json is missing a mapping (drift)', function () {
    const originalRaw = fs.readFileSync(PROTOCOL_JSON_PATH, 'utf8')
    const protocol = JSON.parse(originalRaw)

    // Walk into play.toClient.types.packet[1] and find the "name" field's
    // mapper, which holds the id -> packet-name mappings. Remove a single
    // mapping; the script must report drift and exit 1.
    const packetDef = protocol.play.toClient.types.packet
    assert.ok(Array.isArray(packetDef) && packetDef[0] === 'container')
    const fields = packetDef[1]
    const nameField = fields.find((f) => f && f.name === 'name')
    assert.ok(nameField && Array.isArray(nameField.type))
    assert.strictEqual(nameField.type[0], 'mapper')
    const mappings = nameField.type[1].mappings
    const mappingKeys = Object.keys(mappings)
    assert.ok(mappingKeys.length > 0, 'play.toClient mappings must not be empty')

    // Remove the *last* mapping (highest id) to minimise the chance of the
    // mutation also breaking unrelated structural validators.
    const removedHexId = mappingKeys[mappingKeys.length - 1]
    const removedName = mappings[removedHexId]
    delete mappings[removedHexId]

    try {
      backupAndOverwrite(PROTOCOL_JSON_PATH, JSON.stringify(protocol, null, 2))
      const { status, stdout, stderr } = runScript()
      assert.strictEqual(
        status,
        1,
        `expected exit 1 when "${removedName}" (${removedHexId}) is removed from protocol.json, got ${status}\n` +
          `stdout:\n${stdout}\nstderr:\n${stderr}`
      )
      // The drift report goes to stdout. The removed packet name should
      // surface in the "missing from protocol.json" section.
      assert.ok(
        stdout.includes('DRIFT') || stdout.includes('missing from protocol.json'),
        `expected drift report in stdout\nstdout:\n${stdout}`
      )
      assert.ok(
        stdout.includes(removedName),
        `expected stdout to mention removed packet name "${removedName}"\nstdout:\n${stdout}`
      )
    } finally {
      restore(PROTOCOL_JSON_PATH)
    }
  })

  it('returns to exit 0 after restoring all mutations', function () {
    // Belt and braces: prove the previous mutations are fully undone.
    const { status, stdout } = runScript()
    assert.strictEqual(
      status,
      0,
      `expected exit 0 after restore, got ${status}\nstdout:\n${stdout}`
    )
  })
})
