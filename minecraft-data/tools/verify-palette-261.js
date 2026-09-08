#!/usr/bin/env node
/*
 * Cross-checks the frozen 26.1 packet palette against protocol.json.
 * The fixture is kept in-repository so this test does not need an adjacent
 * Minecraft-Console-Client checkout.
 *
 * Exit codes:
 *   0  Palette and protocol are equivalent.
 *   1  Palette drift detected.
 *   2  Fixture or protocol JSON could not be loaded or validated.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const MC_DATA_ROOT = path.resolve(SCRIPT_DIR, '..');
const PALETTE_PATH = path.join(SCRIPT_DIR, 'palette-261.json');
const PROTOCOL_JSON_PATH = path.join(MC_DATA_ROOT, 'data', 'pc', '26.1', 'protocol.json');

const DICTIONARIES = [
  { direction: 'playToClient', protocolSection: ['play', 'toClient'] },
  { direction: 'playToServer', protocolSection: ['play', 'toServer'] },
  { direction: 'configurationToClient', protocolSection: ['configuration', 'toClient'] },
  { direction: 'configurationToServer', protocolSection: ['configuration', 'toServer'] }
];

function die(message) {
  process.stderr.write(`verify-palette-261: ${message}\n`);
  process.exit(2);
}

function fmtHex(id) {
  return `0x${id.toString(16).toUpperCase().padStart(2, '0')}`;
}

function loadJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    die(`cannot load ${label}: ${err.message}`);
  }
}

function loadPalette() {
  const fixture = loadJson(PALETTE_PATH, 'palette-261.json');
  const palette = {};

  for (const { direction } of DICTIONARIES) {
    const entries = fixture[direction];
    if (!Array.isArray(entries)) die(`palette-261.json.${direction} must be an array`);

    const mappings = new Map();
    for (const [id, name] of entries.entries()) {
      if (name === null) continue;
      if (typeof name !== 'string' || name.length === 0) {
        die(`palette-261.json.${direction}[${id}] must be a packet name or null`);
      }
      mappings.set(id, name);
    }
    palette[direction] = mappings;
  }

  return palette;
}

function extractProtocolMappings(protocol, sectionPath) {
  let cursor = protocol;
  for (const key of sectionPath) {
    if (!cursor || typeof cursor !== 'object' || !(key in cursor)) return new Map();
    cursor = cursor[key];
  }

  const packet = cursor?.types?.packet;
  if (!Array.isArray(packet) || packet[0] !== 'container' || !Array.isArray(packet[1])) return new Map();

  const nameField = packet[1].find(field => field?.name === 'name');
  const mappings = nameField?.type?.[1]?.mappings;
  if (nameField?.type?.[0] !== 'mapper' || !mappings || typeof mappings !== 'object') return new Map();

  return new Map(Object.entries(mappings).map(([id, name]) => [parseInt(id, 16), String(name)]));
}

function diffPaletteVsProtocol(palette, protocol) {
  const perDirection = {};
  let totalMissing = 0;
  let totalExtra = 0;
  let totalMismatch = 0;

  for (const dictionary of DICTIONARIES) {
    const expected = palette[dictionary.direction];
    const actual = extractProtocolMappings(protocol, dictionary.protocolSection);
    const missingFromProtocol = [];
    const extraInProtocol = [];
    const mismatchedNames = [];

    for (const [id, name] of expected) {
      if (!actual.has(id)) missingFromProtocol.push({ id, name });
      else if (actual.get(id) !== name) mismatchedNames.push({ id, paletteName: name, protocolName: actual.get(id) });
    }
    for (const [id, name] of actual) {
      if (!expected.has(id)) extraInProtocol.push({ id, name });
    }

    perDirection[dictionary.direction] = { missingFromProtocol, extraInProtocol, mismatchedNames };
    totalMissing += missingFromProtocol.length;
    totalExtra += extraInProtocol.length;
    totalMismatch += mismatchedNames.length;
  }

  return { perDirection, totalMissing, totalExtra, totalMismatch };
}

function printDiff(palette, diff) {
  for (const { direction } of DICTIONARIES) {
    const entries = palette[direction];
    const { missingFromProtocol, extraInProtocol, mismatchedNames } = diff.perDirection[direction];
    process.stdout.write(`# ${direction}: fixture=${entries.size}, missing=${missingFromProtocol.length}, extra=${extraInProtocol.length}, mismatched=${mismatchedNames.length}\n`);
    for (const entry of missingFromProtocol) process.stdout.write(`  missing ${fmtHex(entry.id)} ${entry.name}\n`);
    for (const entry of extraInProtocol) process.stdout.write(`  extra ${fmtHex(entry.id)} ${entry.name}\n`);
    for (const entry of mismatchedNames) process.stdout.write(`  mismatch ${fmtHex(entry.id)} fixture=${entry.paletteName} protocol=${entry.protocolName}\n`);
  }
}

const palette = loadPalette();
const protocol = loadJson(PROTOCOL_JSON_PATH, 'data/pc/26.1/protocol.json');
const diff = diffPaletteVsProtocol(palette, protocol);

process.stdout.write('verify-palette-261: comparing tools/palette-261.json vs data/pc/26.1/protocol.json\n');
printDiff(palette, diff);

if (diff.totalMissing === 0 && diff.totalExtra === 0 && diff.totalMismatch === 0) {
  process.stdout.write('OK\n');
  process.exit(0);
}

process.stdout.write(`DRIFT: ${diff.totalMissing} missing, ${diff.totalExtra} extra, ${diff.totalMismatch} name-mismatched\n`);
process.exit(1);
