// Temporary one-shot script: build data/pc/26.1/protocol.json skeleton
// from data/pc/1.21.11/protocol.json by reusing types/handshaking/status/login
// segments as-is and emptying configuration/play type containers.
//
// Removed after task 1.3.
'use strict'

const fs = require('fs')
const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '..')
const SRC = path.join(REPO_ROOT, 'data', 'pc', '1.21.11', 'protocol.json')
const DST = path.join(REPO_ROOT, 'data', 'pc', '26.1', 'protocol.json')

const src = JSON.parse(fs.readFileSync(SRC, 'utf8'))

// Sanity check: top-level key set must match what task 1.3 specifies.
const expectedKeys = ['types', 'handshaking', 'status', 'login', 'configuration', 'play']
for (const key of expectedKeys) {
  if (!Object.prototype.hasOwnProperty.call(src, key)) {
    throw new Error(`source protocol.json missing top-level key: ${key}`)
  }
}

// Reuse types/handshaking/status/login as-is. JSON is data, deep clone via
// JSON round-trip so we don't accidentally share references with the source.
const skeleton = {
  types: src.types,
  handshaking: src.handshaking,
  status: src.status,
  login: src.login,
  configuration: {
    toClient: { types: {} },
    toServer: { types: {} }
  },
  play: {
    toClient: { types: {} },
    toServer: { types: {} }
  }
}

// Sanity check: handshaking/status/login direction shape preserved.
for (const stage of ['handshaking', 'status', 'login']) {
  for (const dir of ['toClient', 'toServer']) {
    if (skeleton[stage][dir] && !skeleton[stage][dir].types) {
      throw new Error(`unexpected shape: ${stage}.${dir} has no types container`)
    }
  }
}

const json = JSON.stringify(skeleton, null, 2) + '\n'

// Confirm JSON.parse round-trip succeeds.
JSON.parse(json)

fs.mkdirSync(path.dirname(DST), { recursive: true })
fs.writeFileSync(DST, json)

console.log(`wrote ${DST} (${json.length} bytes)`)
