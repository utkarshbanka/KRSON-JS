'use strict';

const { TC, MAGIC0, MAGIC1, VERSION, FLAG_HAS_SCHEMA_ID, FLAG_HAS_CRC, FLAG_HAS_STRING_TABLE, MAX_NEST_DEPTH } = require('./constants');
const { writeVarInt, varintSize, zigzagEncode } = require('./varint');
const { crc32 } = require('./crc32');
const { getSchema } = require('./schema-registry');

// ─── Schema-mode encode ───────────────────────────────────────────────────────

function schemaEncode(schemaId, obj) {
  const schema = getSchema(schemaId);
  if (!schema) throw new Error(`Unknown schema ID: ${schemaId}`);

  // Pass 1: size every field directly (no intermediate Buffer per field)
  let totalSize = 8; // header
  for (let i = 0; i < schema.fields.length; i++) {
    totalSize += sizeValue(obj[schema.fields[i]], schema.types[i]);
  }

  const buf = Buffer.allocUnsafe(totalSize);
  // Header: [KR][version][flags][schemaId:4B]
  buf[0] = MAGIC0; buf[1] = MAGIC1;
  buf[2] = VERSION;
  buf[3] = FLAG_HAS_SCHEMA_ID | (schema.useCrc ? FLAG_HAS_CRC : 0);
  buf.writeUInt32LE(schemaId, 4);

  // Pass 2: write every field straight into the final buffer
  let pos = 8;
  for (let i = 0; i < schema.fields.length; i++) {
    pos += writeValue(buf, pos, obj[schema.fields[i]], schema.types[i]);
  }

  // Add CRC32 if the schema opted in
  if (schema.useCrc) {
    const crc = crc32(buf.subarray(0, pos));
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32LE(crc, 0);
    return Buffer.concat([buf.subarray(0, pos), crcBuf]);
  }

  return buf;
}

// ─── Size pass (mirrors writeValue, no allocation) ───────────────────────────

function sizeValue(val, type = null) {
  if (val === null || val === undefined) return 1;

  if (type === null) {
    if (Array.isArray(val)) return sizeArray(val);
    if (typeof val === 'object') return sizeMap(val);
    if (typeof val === 'string') return sizeValue(val, 'string');
    if (typeof val === 'number') return sizeValue(val, Number.isInteger(val) ? 'varint' : 'float64');
    if (typeof val === 'boolean') return sizeValue(val, 'bool');
    return 1;
  }

  switch (type) {
    case 'bool': return 1;
    case 'varint': {
      // `val | 0` would truncate to 32-bit, silently corrupting any value
      // outside ±2^31 (e.g. ms timestamps). Full safe-integer range works
      // correctly here; truly unsafe (>2^53) values fall back to float64
      // to avoid silent precision loss.
      if (!Number.isSafeInteger(val)) return 9; // TC + float64
      const z = zigzagEncode(val);
      return 1 + varintSize(z);
    }
    case 'int32': return 5;
    case 'float64': return 9;
    case 'string': return 5 + Buffer.byteLength(val, 'utf8');
    case 'array': return sizeArray(val);
    case 'object': return sizeMap(val);
    case 'timestamp': return 9;
    default: {
      // fallback: JSON string
      return 5 + Buffer.byteLength(JSON.stringify(val), 'utf8');
    }
  }
}

function sizeArray(arr) {
  if (!Array.isArray(arr)) return sizeValue(arr, 'object');
  let total = 1 + varintSize(arr.length);
  for (let i = 0; i < arr.length; i++) total += sizeValue(arr[i]);
  return total;
}

function sizeMap(obj) {
  if (typeof obj !== 'object' || obj === null) return sizeValue(obj, 'string');
  const keys = Object.keys(obj);
  let total = 1 + varintSize(keys.length);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    total += sizeValue(k, 'string');
    total += sizeValue(obj[k]);
  }
  return total;
}

// ─── Write pass — writes directly into the pre-sized output buffer ──────────

function writeValue(buf, pos, val, type = null) {
  if (val === null || val === undefined) {
    buf[pos] = TC.NULL;
    return 1;
  }

  if (type === null) {
    if (Array.isArray(val)) return writeArray(buf, pos, val);
    if (typeof val === 'object') return writeMap(buf, pos, val);
    if (typeof val === 'string') return writeValue(buf, pos, val, 'string');
    if (typeof val === 'number') return writeValue(buf, pos, val, Number.isInteger(val) ? 'varint' : 'float64');
    if (typeof val === 'boolean') return writeValue(buf, pos, val, 'bool');
    buf[pos] = TC.NULL;
    return 1;
  }

  switch (type) {
    case 'bool': {
      buf[pos] = val ? TC.BOOL_TRUE : TC.BOOL_FALSE;
      return 1;
    }
    case 'varint': {
      // Must mirror the size-pass logic in sizeValue exactly, or the
      // pre-computed buffer size and the actual bytes written diverge.
      if (!Number.isSafeInteger(val)) {
        buf[pos] = TC.FLOAT64;
        buf.writeDoubleBE(val, pos + 1);
        return 9;
      }
      buf[pos] = TC.VARINT;
      const z = zigzagEncode(val);
      return 1 + writeVarInt(buf, pos + 1, z);
    }
    case 'int32': {
      buf[pos] = TC.INT32;
      buf.writeInt32LE(val, pos + 1);
      return 5;
    }
    case 'float64': {
      buf[pos] = TC.FLOAT64;
      buf.writeDoubleBE(val, pos + 1);
      return 9;
    }
    case 'string': {
      buf[pos] = TC.STRING;
      const len = buf.write(val, pos + 5, 'utf8');
      buf.writeUInt32LE(len, pos + 1);
      return 5 + len;
    }
    case 'array':
      return writeArray(buf, pos, val);
    case 'object':
      return writeMap(buf, pos, val);
    case 'timestamp': {
      buf[pos] = TC.TIMESTAMP;
      buf.writeBigInt64LE(BigInt(val), pos + 1);
      return 9;
    }
    default: {
      // fallback: JSON string, tagged with its own type code so it's never
      // confused with a genuine string that happens to start with [ or {
      buf[pos] = TC.JSON_FALLBACK;
      const json = JSON.stringify(val);
      const len = buf.write(json, pos + 5, 'utf8');
      buf.writeUInt32LE(len, pos + 1);
      return 5 + len;
    }
  }
}

function writeArray(buf, pos, arr) {
  if (!Array.isArray(arr)) return writeValue(buf, pos, arr, 'object');
  const start = pos;
  buf[pos++] = TC.ARRAY;
  pos += writeVarInt(buf, pos, arr.length);
  for (let i = 0; i < arr.length; i++) {
    pos += writeValue(buf, pos, arr[i]);
  }
  return pos - start;
}

function writeMap(buf, pos, obj) {
  if (typeof obj !== 'object' || obj === null) return writeValue(buf, pos, obj, 'string');
  const start = pos;
  const keys = Object.keys(obj);
  buf[pos++] = TC.MAP;
  pos += writeVarInt(buf, pos, keys.length);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    pos += writeValue(buf, pos, k, 'string');
    pos += writeValue(buf, pos, obj[k]);
  }
  return pos - start;
}

// ─── Schemaless encode ────────────────────────────────────────────────────────
// Merged pass: interns every string (keys + values) into the table AND
// computes the value-tree size at the same time, since a string's varint-ref
// size is fully determined the moment it's interned. This collapses what
// would otherwise be two separate full-tree walks into one.

function collectAndSizeT(val, table, tableList, depth = 0) {
  if (depth > MAX_NEST_DEPTH) {
    throw new Error(`KRSON: maximum nesting depth (${MAX_NEST_DEPTH}) exceeded while encoding`);
  }
  if (val === null || val === undefined) return 1;
  const t = typeof val;
  if (t === 'boolean') return 1;
  if (t === 'number') {
    if (Number.isInteger(val) && Number.isSafeInteger(val)) {
      const z = zigzagEncode(val);
      return 1 + varintSize(z);
    }
    return 9; // TC + float64 (also covers NaN/Infinity and unsafe integers)
  }
  if (t === 'string') {
    let idx = table.get(val);
    if (idx === undefined) {
      idx = tableList.length;
      table.set(val, idx);
      tableList.push(val);
    }
    return 1 + varintSize(idx);
  }
  if (Array.isArray(val)) {
    let size = 1 + varintSize(val.length);
    for (const item of val) size += collectAndSizeT(item, table, tableList, depth + 1);
    return size;
  }
  if (t === 'object') {
    const keys = Object.keys(val);
    let size = 1 + varintSize(keys.length);
    for (const k of keys) {
      let idx = table.get(k);
      if (idx === undefined) {
        idx = tableList.length;
        table.set(k, idx);
        tableList.push(k);
      }
      size += 1 + varintSize(idx); // key as string-ref
      size += collectAndSizeT(val[k], table, tableList, depth + 1);
    }
    return size;
  }
  return 1;
}

function writeValueT(buf, pos, val, table, depth = 0) {
  const start = pos;
  if (val === null || val === undefined) {
    buf[pos++] = TC.NULL;
    return pos - start;
  }
  const t = typeof val;
  if (t === 'boolean') {
    buf[pos++] = val ? TC.BOOL_TRUE : TC.BOOL_FALSE;
    return pos - start;
  }
  if (t === 'number') {
    if (Number.isInteger(val) && Number.isSafeInteger(val)) {
      buf[pos++] = TC.VARINT;
      const z = zigzagEncode(val);
      pos += writeVarInt(buf, pos, z);
    } else {
      buf[pos++] = TC.FLOAT64;
      buf.writeDoubleBE(val, pos);
      pos += 8;
    }
    return pos - start;
  }
  if (t === 'string') {
    buf[pos++] = TC.STRING_REF;
    pos += writeVarInt(buf, pos, table.get(val));
    return pos - start;
  }
  if (Array.isArray(val)) {
    buf[pos++] = TC.ARRAY;
    pos += writeVarInt(buf, pos, val.length);
    for (const item of val) pos += writeValueT(buf, pos, item, table, depth + 1);
    return pos - start;
  }
  if (t === 'object') {
    const keys = Object.keys(val);
    buf[pos++] = TC.MAP;
    pos += writeVarInt(buf, pos, keys.length);
    for (const k of keys) {
      buf[pos++] = TC.STRING_REF;
      pos += writeVarInt(buf, pos, table.get(k));
      pos += writeValueT(buf, pos, val[k], table, depth + 1);
    }
    return pos - start;
  }
  buf[pos++] = TC.NULL;
  return pos - start;
}

function encode(obj) {
  // Phase 1: intern every string (keys + values) AND size the value tree in
  // one combined walk — a string-ref's size is fixed the instant it's
  // interned, so there's no need for a separate sizing pass.
  const table = new Map();
  const tableList = [];
  const valueSize = collectAndSizeT(obj, table, tableList);

  // Phase 2: size the string table section
  const entryLens = new Array(tableList.length);
  let tableSize = varintSize(tableList.length);
  for (let i = 0; i < tableList.length; i++) {
    const len = Buffer.byteLength(tableList[i], 'utf8');
    entryLens[i] = len;
    tableSize += varintSize(len) + len;
  }

  // Single allocation, single write pass — no per-field Buffer allocations
  const total = 8 + tableSize + valueSize;
  const buf = Buffer.allocUnsafe(total);
  buf[0] = MAGIC0; buf[1] = MAGIC1;
  buf[2] = VERSION;
  buf[3] = FLAG_HAS_STRING_TABLE;
  buf.writeUInt32LE(0, 4); // no schema id

  let pos = 8;
  pos += writeVarInt(buf, pos, tableList.length);
  for (let i = 0; i < tableList.length; i++) {
    pos += writeVarInt(buf, pos, entryLens[i]);
    buf.write(tableList[i], pos, 'utf8');
    pos += entryLens[i];
  }
  pos += writeValueT(buf, pos, obj, table);

  return buf;
}

module.exports = {
  schemaEncode,
  sizeValue,
  writeValue,
  encode,
};
