/* eslint-env mocha */
const assert = require('assert')
const minecraftData = require('..')
const data = require('../data')

describe('exported pot_decorations schema', () => {
  it('exports four ordered optional item templates for 26.3 and protocol 777', () => {
    const embedded = require('../minecraft-data/data/pc/26.3/protocol.json')
    for (const protocol of [embedded, data.pc['26.3'].protocol, minecraftData('26.3').protocol, minecraftData(777).protocol]) {
      assert.strictEqual(protocol, embedded)
      assert.deepStrictEqual(protocol.types.SlotComponent[1][1].type[1].fields.pot_decorations, [
        'container',
        ['back', 'left', 'right', 'front'].map(name => ({ name, type: ['option', 'ItemStackTemplate'] }))
      ])
    }
  })

  for (const version of ['26.1', '26.2']) {
    it(`preserves the exported item ID array in ${version}`, () => {
      assert.deepStrictEqual(minecraftData(version).protocol.types.SlotComponent[1][1].type[1].fields.pot_decorations, [
        'container',
        [{ name: 'decorations', type: ['array', { countType: 'varint', type: 'varint' }] }]
      ])
    })
  }
})
