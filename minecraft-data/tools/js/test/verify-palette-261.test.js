/* eslint-env mocha */

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const MC_DATA_ROOT = path.resolve(__dirname, '../../../')
const SCRIPT_PATH = path.join(MC_DATA_ROOT, 'tools', 'verify-palette-261.js')
const PALETTE_PATH = path.join(MC_DATA_ROOT, 'tools', 'palette-261.json')
const PROTOCOL_JSON_PATH = path.join(MC_DATA_ROOT, 'data', 'pc', '26.1', 'protocol.json')

const backups = new Map()

function backupAndOverwrite (filePath, contents) {
  if (!backups.has(filePath)) backups.set(filePath, fs.readFileSync(filePath, 'utf8'))
  fs.writeFileSync(filePath, contents)
}

function restore (filePath) {
  if (backups.has(filePath)) {
    fs.writeFileSync(filePath, backups.get(filePath))
    backups.delete(filePath)
  }
}

function runScript () {
  const result = spawnSync(process.execPath, [SCRIPT_PATH], { cwd: MC_DATA_ROOT, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' }
}

describe('verify-palette-261.js exit-code semantics', function () {
  after(function () {
    for (const [filePath, contents] of backups) fs.writeFileSync(filePath, contents)
  })

  it('exits 0 when the fixture and protocol are in sync', function () {
    const { status, stdout } = runScript()
    assert.strictEqual(status, 0)
    assert.match(stdout, /\bOK\b/)
  })

  it('exits 2 for invalid fixture JSON', function () {
    try {
      backupAndOverwrite(PALETTE_PATH, '{')
      const { status, stderr } = runScript()
      assert.strictEqual(status, 2)
      assert.match(stderr, /cannot load palette-261\.json/)
    } finally {
      restore(PALETTE_PATH)
    }
  })

  it('exits 1 when protocol.json drifts', function () {
    const protocol = JSON.parse(fs.readFileSync(PROTOCOL_JSON_PATH, 'utf8'))
    const nameField = protocol.play.toClient.types.packet[1].find(field => field && field.name === 'name')
    const mappings = nameField.type[1].mappings
    const id = Object.keys(mappings).at(-1)
    const name = mappings[id]
    delete mappings[id]

    try {
      backupAndOverwrite(PROTOCOL_JSON_PATH, JSON.stringify(protocol, null, 2))
      const { status, stdout } = runScript()
      assert.strictEqual(status, 1)
      assert.match(stdout, /DRIFT/)
      assert.ok(stdout.includes(name))
    } finally {
      restore(PROTOCOL_JSON_PATH)
    }
  })
})
