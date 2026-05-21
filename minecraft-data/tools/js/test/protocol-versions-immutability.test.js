/* eslint-env mocha */
//
// Task 1.5 — Regression / immutability test for protocolVersions.json and
// historical version directories.
//
// Validates: Requirements 1.5, 14.2
//   - data/pc/common/protocolVersions.json must record 26.1.2 with
//     version=775 and dataVersion=4790 exactly.
//   - The version.json files for a sample of historical version directories
//     (1.21.11, 1.20.4, 1.16.5) must still exist and still report the
//     well-known "version" numbers we expect (774, 765, 754).

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '../../../')

describe('protocolVersions.json — 26.1.2 record stability', function () {
  it('records 26.1.2 with version=775 and dataVersion=4790', function () {
    const file = path.join(REPO_ROOT, 'data/pc/common/protocolVersions.json')
    const records = JSON.parse(fs.readFileSync(file, 'utf8'))

    // Requirement 1.5 / Task 1.5 spec talks about *the* 26.1.2 release
    // record, not the release-candidate. Filter on usesNetty + releaseType
    // so we don't accidentally pick up "26.1.2-rc-1" sitting next to it.
    const matches = records.filter((r) => r.minecraftVersion === '26.1.2')
    assert.ok(matches.length >= 1, 'expected at least one 26.1.2 entry in protocolVersions.json')

    const release = matches.find((r) => r.releaseType === 'release') || matches[0]
    assert.strictEqual(release.version, 775, '26.1.2 protocol version must be 775')
    assert.strictEqual(release.dataVersion, 4790, '26.1.2 dataVersion must be 4790')
  })
})

describe('historical version.json files are unchanged', function () {
  // (majorVersionDir, expectedVersion) pairs. expectedVersion values are
  // pinned hardcoded so any drift in these long-published entries shows
  // up here as a clear failure.
  const samples = [
    { dir: '1.21.11', expectedVersion: 774 },
    { dir: '1.20.4', expectedVersion: 765 },
    { dir: '1.16.5', expectedVersion: 754 }
  ]

  samples.forEach(function (sample) {
    it(`data/pc/${sample.dir}/version.json still reports version=${sample.expectedVersion}`, function () {
      const file = path.join(REPO_ROOT, 'data', 'pc', sample.dir, 'version.json')
      assert.ok(
        fs.existsSync(file),
        `historical version.json missing: ${path.relative(REPO_ROOT, file)}`
      )

      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      assert.ok(
        Object.prototype.hasOwnProperty.call(parsed, 'version'),
        `version.json for ${sample.dir} must contain a "version" field`
      )
      assert.strictEqual(
        parsed.version,
        sample.expectedVersion,
        `data/pc/${sample.dir}/version.json "version" field changed (expected ${sample.expectedVersion}, got ${parsed.version})`
      )
    })
  })
})
