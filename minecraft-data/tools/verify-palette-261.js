#!/usr/bin/env node
/*
 * verify-palette-261.js
 * ---------------------
 * Cross-checks the four packet dictionaries declared in
 *   Minecraft-Console-Client/MinecraftClient/Protocol/Handlers/PacketPalettes/PacketPalette261.cs
 * against
 *   minecraft-data/data/pc/26.1/protocol.json
 *
 * Pure Node.js + regex. Does NOT require dotnet/csc.
 *
 * Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5
 *
 * Exit codes:
 *   0  Palettes are equivalent (no drift).
 *   1  Palette drift detected (entries missing-from or extra-in protocol.json).
 *   2  Failed to regex-parse one or more dictionaries from PacketPalette261.cs.
 *   3  palette-name-map.json is missing one or more csharpName entries needed
 *      to translate PascalCase -> snake_case for the diff.
 *
 * Intermediate model (in-memory):
 *   {
 *     playToClient:           Map<number, PaletteEntry>,
 *     playToServer:           Map<number, PaletteEntry>,
 *     configurationToClient:  Map<number, PaletteEntry>,
 *     configurationToServer:  Map<number, PaletteEntry>,
 *   }
 * where PaletteEntry = { id, csharpName, snakeName }.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// --- Path resolution ---------------------------------------------------------
const SCRIPT_DIR = __dirname;
const MC_DATA_ROOT = path.resolve(SCRIPT_DIR, '..');
const WORKSPACE_ROOT = path.resolve(MC_DATA_ROOT, '..');

const PALETTE_CS_PATH = path.join(
  WORKSPACE_ROOT,
  'Minecraft-Console-Client',
  'MinecraftClient',
  'Protocol',
  'Handlers',
  'PacketPalettes',
  'PacketPalette261.cs'
);
const NAME_MAP_PATH = path.join(SCRIPT_DIR, 'palette-name-map.json');
const PROTOCOL_JSON_PATH = path.join(MC_DATA_ROOT, 'data', 'pc', '26.1', 'protocol.json');

// --- Dictionary descriptors --------------------------------------------------
const DICTIONARIES = [
  {
    direction: 'playToClient',
    csharpField: 'typeIn',
    enumPrefix: 'PacketTypesIn',
    protocolSection: ['play', 'toClient'],
  },
  {
    direction: 'playToServer',
    csharpField: 'typeOut',
    enumPrefix: 'PacketTypesOut',
    protocolSection: ['play', 'toServer'],
  },
  {
    direction: 'configurationToClient',
    csharpField: 'configurationTypesIn',
    enumPrefix: 'ConfigurationPacketTypesIn',
    protocolSection: ['configuration', 'toClient'],
  },
  {
    direction: 'configurationToServer',
    csharpField: 'configurationTypesOut',
    enumPrefix: 'ConfigurationPacketTypesOut',
    protocolSection: ['configuration', 'toServer'],
  },
];

// --- Helpers -----------------------------------------------------------------

function die(exitCode, message) {
  process.stderr.write(message);
  if (!message.endsWith('\n')) process.stderr.write('\n');
  process.exit(exitCode);
}

function readFileOrDie(filePath, exitCode = 2) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    die(exitCode, `verify-palette-261: cannot read ${filePath}: ${err.message}`);
  }
}

/**
 * Locate one dictionary block inside PacketPalette261.cs by csharp field name.
 *
 * The actual format in the file is:
 *   private readonly BROKEN_TypeIn typeIn = new()
 *   {
 *     ...
 *   };
 *
 * We look for the field name followed by `= new()` then find the brace-delimited block.
 */
function locateDictionaryBlock(source, csharpField) {
  // Match the field declaration: any type + fieldName + = new()
  // e.g. "BROKEN_TypeIn typeIn = new()" or "Dictionary<int, PacketTypesIn> typeIn = new()"
  const headerRe = new RegExp(
    '\\b' + csharpField + '\\s*=\\s*new\\s*\\(\\s*\\)',
    'm'
  );
  const m = headerRe.exec(source);
  if (!m) return null;

  // Find the opening brace after the header.
  let i = m.index + m[0].length;
  while (i < source.length && source[i] !== '{') i++;
  if (i >= source.length) return null;

  // Walk forward counting braces to find the matching closing brace.
  let depth = 0;
  const start = i;
  for (; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];

    // Line comment
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    // Block comment
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length - 1 && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i++; // skip closing /
      continue;
    }
    // String / char literals
    if (c === '"' || c === '\'') {
      const quote = c;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++;
        i++;
      }
      continue;
    }

    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Parse all `{ 0xNN, EnumPrefix.Member }` entries inside a dictionary block.
 * Returns Map<number, csharpName>. Throws on duplicate id.
 */
function parseEntries(block, enumPrefix) {
  const entryRe = new RegExp(
    '\\{\\s*0x([0-9A-Fa-f]+)\\s*,\\s*' + enumPrefix + '\\.(\\w+)\\s*\\}',
    'g'
  );
  const map = new Map();
  let m;
  while ((m = entryRe.exec(block)) !== null) {
    const id = parseInt(m[1], 16);
    const name = m[2];
    if (map.has(id)) {
      throw new Error(
        `duplicate id 0x${id.toString(16).toUpperCase().padStart(2, '0')} in ${enumPrefix} dictionary (csharpName=${name}, previous=${map.get(id)})`
      );
    }
    map.set(id, name);
  }
  return map;
}

/**
 * Format hex id with at least 2 lowercase digits, prefixed with 0x.
 */
function fmtHex(id) {
  return '0x' + id.toString(16).padStart(2, '0').toUpperCase();
}

/**
 * Build the palette model { direction -> Map<id, PaletteEntry> } from the
 * C# source and the name map.
 *
 * Returns { model, parseFailed, missingNames }.
 *  parseFailed:  array of { csharpField, reason } -> exit 2 if non-empty.
 *  missingNames: array of { direction, csharpName, id } -> exit 3 if non-empty.
 */
function buildPaletteModel(csharpSource, nameMap) {
  const model = {};
  const parseFailed = [];
  const missingNames = [];

  for (const dict of DICTIONARIES) {
    const block = locateDictionaryBlock(csharpSource, dict.csharpField);
    if (block === null) {
      const idx = csharpSource.indexOf(dict.csharpField);
      const ctx = idx >= 0
        ? csharpSource.slice(idx, idx + 200).replace(/\r?\n/g, ' ')
        : '(field name not found in source)';
      parseFailed.push({
        csharpField: dict.csharpField,
        reason: `failed to locate dictionary block; context: ${ctx}`,
      });
      continue;
    }

    let entries;
    try {
      entries = parseEntries(block, dict.enumPrefix);
    } catch (err) {
      parseFailed.push({ csharpField: dict.csharpField, reason: err.message });
      continue;
    }

    if (entries.size === 0) {
      const ctx = block.slice(0, 200).replace(/\r?\n/g, ' ');
      parseFailed.push({
        csharpField: dict.csharpField,
        reason: `regex matched zero entries; context: ${ctx}`,
      });
      continue;
    }

    const directionMap = new Map();
    const directionNameTable = (nameMap && nameMap[dict.direction]) || {};
    for (const [id, csharpName] of entries) {
      const snakeName = directionNameTable[csharpName];
      if (typeof snakeName !== 'string' || snakeName.length === 0) {
        missingNames.push({ direction: dict.direction, csharpName, id });
        continue;
      }
      directionMap.set(id, { id, csharpName, snakeName });
    }
    model[dict.direction] = directionMap;
  }

  return { model, parseFailed, missingNames };
}

// --- protocol.json extraction ------------------------------------------------

/**
 * Given a protocol.json document and a section path (e.g. ['play','toClient']),
 * extract the packet id -> name mapping from the protodef mapper structure.
 *
 * Shape (per minecraft-data convention):
 *   protocol[section][direction].types.packet = [
 *     'container',
 *     [
 *       { name: 'name', type: ['mapper', { type:'varint', mappings: { '0x00':'name1', ... } }] },
 *       { name: 'params', type: ['switch', { compareTo:'name', fields: { ... } }] }
 *     ]
 *   ]
 *
 * Returns Map<number, string> (id -> packet name).
 */
function extractProtocolMappings(protocol, sectionPath) {
  const empty = new Map();
  if (!protocol || typeof protocol !== 'object') return empty;

  let cursor = protocol;
  for (const key of sectionPath) {
    if (cursor && typeof cursor === 'object' && key in cursor) {
      cursor = cursor[key];
    } else {
      return empty;
    }
  }

  // cursor should be { types: { packet: [...], ... } }
  const types = cursor && cursor.types;
  if (!types || typeof types !== 'object') return empty;
  const packet = types.packet;
  if (!Array.isArray(packet) || packet[0] !== 'container' || !Array.isArray(packet[1])) {
    return empty;
  }

  const idToName = new Map();
  for (const field of packet[1]) {
    if (!field || typeof field !== 'object' || !Array.isArray(field.type)) continue;
    const [kind, def] = field.type;
    if (field.name === 'name' && kind === 'mapper' && def && def.mappings) {
      for (const [hex, name] of Object.entries(def.mappings)) {
        const id = parseInt(hex, 16);
        if (!Number.isNaN(id)) idToName.set(id, String(name));
      }
    }
  }
  return idToName;
}

// --- Diffing -----------------------------------------------------------------

/**
 * Diff the palette model against the protocol.json document.
 * Returns { perDirection, totalMissing, totalExtra, totalMismatch }.
 */
function diffPaletteVsProtocol(model, protocol) {
  const perDirection = {};
  let totalMissing = 0;
  let totalExtra = 0;
  let totalMismatch = 0;

  for (const dict of DICTIONARIES) {
    const palette = model[dict.direction];
    if (!palette) continue;
    const idToName = extractProtocolMappings(protocol, dict.protocolSection);

    const missingFromProtocol = [];
    const extraInProtocol = [];
    const mismatchedNames = [];

    // Palette -> protocol direction: check each palette entry exists in protocol.
    for (const [id, entry] of palette) {
      if (!idToName.has(id)) {
        missingFromProtocol.push({ id, csharpName: entry.csharpName, snakeName: entry.snakeName });
      } else {
        const protoName = idToName.get(id);
        if (protoName !== entry.snakeName) {
          mismatchedNames.push({ id, paletteName: entry.snakeName, protocolName: protoName });
        }
      }
    }
    // Protocol -> palette direction: check each protocol entry exists in palette.
    for (const [id, name] of idToName) {
      if (!palette.has(id)) {
        extraInProtocol.push({ id, name });
      }
    }

    missingFromProtocol.sort((a, b) => a.id - b.id);
    extraInProtocol.sort((a, b) => a.id - b.id);
    mismatchedNames.sort((a, b) => a.id - b.id);

    perDirection[dict.direction] = { missingFromProtocol, extraInProtocol, mismatchedNames };
    totalMissing += missingFromProtocol.length;
    totalExtra += extraInProtocol.length;
    totalMismatch += mismatchedNames.length;
  }

  return { perDirection, totalMissing, totalExtra, totalMismatch };
}

// --- Reporting ---------------------------------------------------------------

function printHeader() {
  process.stdout.write(
    'verify-palette-261: comparing PacketPalette261.cs vs data/pc/26.1/protocol.json\n'
  );
  process.stdout.write(`  palette source : ${path.relative(WORKSPACE_ROOT, PALETTE_CS_PATH)}\n`);
  process.stdout.write(`  protocol.json  : ${path.relative(WORKSPACE_ROOT, PROTOCOL_JSON_PATH)}\n`);
  process.stdout.write(`  name map       : ${path.relative(WORKSPACE_ROOT, NAME_MAP_PATH)}\n`);
  process.stdout.write('\n');
}

function printDiff(model, diff) {
  for (const dict of DICTIONARIES) {
    const palette = model[dict.direction];
    const section = diff.perDirection[dict.direction];
    if (!palette || !section) continue;

    const paletteSize = palette.size;
    const { missingFromProtocol, extraInProtocol, mismatchedNames } = section;

    process.stdout.write(`# ${dict.direction} (csharp field: ${dict.csharpField})\n`);
    process.stdout.write(
      `  palette entries: ${paletteSize}, missing-from-protocol: ${missingFromProtocol.length}, extra-in-protocol: ${extraInProtocol.length}, name-mismatches: ${mismatchedNames.length}\n`
    );

    if (missingFromProtocol.length > 0) {
      process.stdout.write('  missing from protocol.json (palette has, protocol.json lacks):\n');
      for (const e of missingFromProtocol) {
        process.stdout.write(`    ${fmtHex(e.id)}  ${e.snakeName}  (csharp: ${e.csharpName})\n`);
      }
    }
    if (extraInProtocol.length > 0) {
      process.stdout.write('  extra in protocol.json (protocol.json has, palette lacks):\n');
      for (const e of extraInProtocol) {
        process.stdout.write(`    ${fmtHex(e.id)}  ${e.name}\n`);
      }
    }
    if (mismatchedNames.length > 0) {
      process.stdout.write('  name mismatches (same id, different name):\n');
      for (const e of mismatchedNames) {
        process.stdout.write(
          `    ${fmtHex(e.id)}  palette=${e.paletteName}  protocol=${e.protocolName}\n`
        );
      }
    }
    process.stdout.write('\n');
  }
}

// --- Main --------------------------------------------------------------------

function main() {
  // 1. Read PacketPalette261.cs
  const csharpSource = readFileOrDie(PALETTE_CS_PATH, 2);

  // 2. Read palette-name-map.json
  let nameMap;
  try {
    const raw = fs.readFileSync(NAME_MAP_PATH, 'utf8');
    nameMap = JSON.parse(raw);
  } catch (err) {
    die(3, `verify-palette-261: cannot load palette-name-map.json: ${err.message}`);
  }

  // 3. Build palette model.
  const { model, parseFailed, missingNames } = buildPaletteModel(csharpSource, nameMap);

  // 4. Exit code 2 if any dictionary failed to parse.
  if (parseFailed.length > 0) {
    let msg = '';
    for (const f of parseFailed) {
      msg += `PacketPalette261.cs regex parse failed: ${f.csharpField}\n  ${f.reason}\n`;
    }
    die(2, msg.trimEnd());
  }

  // 5. Exit code 3 if name map is missing entries.
  if (missingNames.length > 0) {
    let msg = 'verify-palette-261: palette-name-map.json is missing entries:\n';
    for (const e of missingNames) {
      msg += `  ${e.direction}.${e.csharpName} (id ${fmtHex(e.id)})\n`;
    }
    die(3, msg.trimEnd());
  }

  // 6. Read protocol.json (graceful: if missing, treat sections as empty).
  let protocol = null;
  let protocolMissing = false;
  if (!fs.existsSync(PROTOCOL_JSON_PATH)) {
    protocolMissing = true;
  } else {
    try {
      protocol = JSON.parse(fs.readFileSync(PROTOCOL_JSON_PATH, 'utf8'));
    } catch (err) {
      die(2, `verify-palette-261: protocol.json is not valid JSON: ${err.message}`);
    }
  }

  // 7. Print header + diff.
  printHeader();
  if (protocolMissing) {
    process.stdout.write(
      'note: data/pc/26.1/protocol.json does not exist yet; treating all protocol sections as empty.\n\n'
    );
  }

  const diff = diffPaletteVsProtocol(model, protocol);
  printDiff(model, diff);

  // 8. Final summary + exit.
  if (diff.totalMissing === 0 && diff.totalExtra === 0 && diff.totalMismatch === 0) {
    process.stdout.write('OK\n');
    process.exit(0);
  } else {
    process.stdout.write(
      `DRIFT: ${diff.totalMissing} missing, ${diff.totalExtra} extra, ${diff.totalMismatch} name-mismatched\n`
    );
    process.exit(1);
  }
}

main();
