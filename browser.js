'use strict';

/**
 * KRSON v5 — Browser build (ArrayBuffer/Uint8Array/DataView based)
 * Wire-format identical to index.js (Node build) — same bytes on the wire,
 * just no dependency on Buffer (so it works in React/Vue/plain HTML/Workers).
 *
 * This file mirrors index.js feature-for-feature and bug-fix-for-bug-fix.
 * Previously this file was a separately-maintained, much weaker
 * implementation (schemaless encode() was literally just
 * `JSON.stringify()` wrapped in a STRING value — no real binary format,
 * no string interning, and get() didn't exist at all). It now shares the
 * exact same logic and wire format as index.js, just expressed with
 * Uint8Array/DataView instead of Buffer.
 */

const TC = {
  NULL:       0x00,
  BOOL_FALSE: 0x01,
  BOOL_TRUE:  0x02,
  INT32:      0x12,
  INT64:      0x13,
  VARINT:     0x18,
  VARINT_NEG: 0x19,
  FLOAT64:    0x21,
  STRING:     0x30,
  BYTES:      0x31,
  STRING_REF: 0x32,
  JSON_FALLBACK: 0x33,
  TIMESTAMP:  0x40,
  ARRAY:      0x50,
  MAP:        0x51,
};

const MAGIC0 = 0x4B; // 'K'
const MAGIC1 = 0x52; // 'R'
const VERSION = 0x05;

const FLAG_HAS_STRING_TABLE = 1 << 3;
const FLAG_HAS_SCHEMA_ID    = 1 << 4;
const FLAG_HAS_CRC          = 1 << 5;

const MAX_NEST_DEPTH = 1000;

const _enc = new TextEncoder();
const _dec = new TextDecoder('utf-8');

// ─── VarInt ───────────────────────────────────────────────────────────────────
// Same fix as index.js: arithmetic instead of bitwise (&, |, <<, >>>), which
// in JS truncate to 32-bit regardless of the value's real magnitude.

function writeVarInt(arr, offset, value) {
  let v = value;
  let written = 0;
  do {
    let byte = v % 128;
    v = Math.floor(v / 128);
    if (v !== 0) byte |= 0x80;
    arr[offset + written++] = byte;
  } while (v !== 0);
  return written;
}

function varintSize(value) {
  let v = value;
  let n = 1;
  v = Math.floor(v / 128);
  while (v !== 0) { n++; v = Math.floor(v / 128); }
  return n;
}

function readVarInt(arr, offset) {
  let result = 0, mult = 1, bytesRead = 0;
  while (true) {
    if (bytesRead >= 10) throw new Error('VarInt too long (malformed buffer)');
    const byte = arr[offset + bytesRead++];
    if (byte === undefined) throw new Error('VarInt read past end of buffer (truncated/corrupt buffer)');
    result += (byte & 0x7F) * mult;
    mult *= 128;
    if ((byte & 0x80) === 0) break;
  }
  return { value: result, bytesRead };
}

// ─── ZigZag for signed ints ──────────────────────────────────────────────────
function zigzagEncode(n) {
  return n >= 0 ? n * 2 : -n * 2 - 1;
}

function zigzagDecode(z) {
  return (z % 2 === 0) ? z / 2 : -(z + 1) / 2;
}

// ─── CRC32 (opt-in) ───────────────────────────────────────────────────────────
function crc32(u8) {
  let crc = 0xffffffff;
  for (let i = 0; i < u8.length; i++) {
    crc ^= u8[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 * (crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function _verifyCrcIfEnabled(schema, u8) {
  if (!schema.useCrc) return;
  if (u8.length < 12) throw new Error('KRSON: buffer too short to contain a CRC32 trailer');
  const dataLen = u8.length - 4;
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const expected = view.getUint32(dataLen, true);
  const actual = crc32(u8.subarray(0, dataLen));
  if (actual !== expected) {
    throw new Error('KRSON: CRC32 mismatch — buffer is corrupted');
  }
}

// ─── Schema Registry ──────────────────────────────────────────────────────────

let _nextSchemaId = 1;
const _schemas = new Map();

function defineSchema(def, options = {}) {
  const id = _nextSchemaId++;
  const fields = Object.keys(def);
  const types  = fields.map(f => def[f]);
  const useCrc = !!options.crc;

  const offsets = new Array(fields.length).fill(null);
  let cursor = 0;
  let fixedSoFar = true;

  for (let i = 0; i < fields.length; i++) {
    if (!fixedSoFar) break;
    offsets[i] = cursor;
    const fixedSize = _fixedSize(types[i]);
    if (fixedSize === null) { fixedSoFar = false; }
    else { cursor += fixedSize; }
  }

  const fieldIndex = {};
  fields.forEach((f, i) => fieldIndex[f] = i);

  _schemas.set(id, { id, fields, types, offsets, fieldIndex, useCrc });

  return {
    encode(obj)           { return _schemaEncode(id, obj); },
    decode(buf)            { return _schemaDecode(id, buf); },
    get(buf, field)        { return _schemaGet(id, buf, field); },
    getMany(buf, fields)   { return _schemaGetMany(id, buf, fields); },
    dispose()               { return disposeSchema(id); },
    id,
  };
}

function disposeSchema(schemaId) {
  return _schemas.delete(schemaId);
}

function _fixedSize(type) {
  switch (type) {
    case 'bool':    return 1;
    case 'int32':   return 4;
    case 'float64': return 8;
    case 'timestamp': return 8;
    default:        return null;
  }
}

// ─── Schema Encode ────────────────────────────────────────────────────────────

function _schemaEncode(schemaId, obj) {
  const schema = _schemas.get(schemaId);
  if (!schema) throw new Error(`Unknown schema ID: ${schemaId}`);

  let totalSize = 8; // header
  for (let i = 0; i < schema.fields.length; i++) {
    totalSize += _sizeValue(obj[schema.fields[i]], schema.types[i]);
  }

  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);

  out[0] = MAGIC0; out[1] = MAGIC1;
  out[2] = VERSION;
  out[3] = FLAG_HAS_SCHEMA_ID | (schema.useCrc ? FLAG_HAS_CRC : 0);
  view.setUint32(4, schemaId, true);

  let pos = 8;
  for (let i = 0; i < schema.fields.length; i++) {
    pos += _writeValue(out, view, pos, obj[schema.fields[i]], schema.types[i]);
  }

  if (schema.useCrc) {
    const crc = crc32(out.subarray(0, pos));
    const final = new Uint8Array(pos + 4);
    final.set(out.subarray(0, pos));
    new DataView(final.buffer).setUint32(pos, crc, true);
    return final;
  }

  return out.subarray(0, pos);
}

// ─── Size pass ────────────────────────────────────────────────────────────────

function _sizeValue(val, type = null) {
  if (val === null || val === undefined) return 1;

  if (type === null) {
    if (Array.isArray(val)) return _sizeArray(val);
    if (typeof val === 'object') return _sizeMap(val);
    if (typeof val === 'string') return _sizeValue(val, 'string');
    if (typeof val === 'number') return _sizeValue(val, Number.isInteger(val) && Number.isSafeInteger(val) ? 'varint' : 'float64');
    if (typeof val === 'boolean') return _sizeValue(val, 'bool');
    return 1;
  }

  switch (type) {
    case 'bool': return 1;
    case 'varint': {
      // FIX: same as index.js — falls back to float64 for unsafe integers
      // instead of corrupting them via 32-bit truncation.
      if (!Number.isSafeInteger(val)) return 9;
      const z = zigzagEncode(val);
      return 1 + varintSize(z);
    }
    case 'int32': return 5;
    case 'float64': return 9;
    case 'string': return 5 + _enc.encode(val).length;
    case 'array': return _sizeArray(val);
    case 'object': return _sizeMap(val);
    case 'timestamp': return 9;
    default: {
      return 5 + _enc.encode(JSON.stringify(val)).length;
    }
  }
}

function _sizeArray(arr) {
  if (!Array.isArray(arr)) return _sizeValue(arr, 'object');
  let total = 1 + varintSize(arr.length);
  for (let i = 0; i < arr.length; i++) total += _sizeValue(arr[i]);
  return total;
}

function _sizeMap(obj) {
  if (typeof obj !== 'object' || obj === null) return _sizeValue(obj, 'string');
  const keys = Object.keys(obj);
  let total = 1 + varintSize(keys.length);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    total += _sizeValue(k, 'string');
    total += _sizeValue(obj[k]);
  }
  return total;
}

// ─── Write pass ───────────────────────────────────────────────────────────────

function _writeValue(out, view, pos, val, type = null) {
  if (val === null || val === undefined) {
    out[pos] = TC.NULL;
    return 1;
  }

  if (type === null) {
    if (Array.isArray(val)) return _writeArray(out, view, pos, val);
    if (typeof val === 'object') return _writeMap(out, view, pos, val);
    if (typeof val === 'string') return _writeValue(out, view, pos, val, 'string');
    if (typeof val === 'number') return _writeValue(out, view, pos, val, Number.isInteger(val) && Number.isSafeInteger(val) ? 'varint' : 'float64');
    if (typeof val === 'boolean') return _writeValue(out, view, pos, val, 'bool');
    out[pos] = TC.NULL;
    return 1;
  }

  switch (type) {
    case 'bool': {
      out[pos] = val ? TC.BOOL_TRUE : TC.BOOL_FALSE;
      return 1;
    }
    case 'varint': {
      // Must mirror _sizeValue's float64 fallback exactly.
      if (!Number.isSafeInteger(val)) {
        out[pos] = TC.FLOAT64;
        view.setFloat64(pos + 1, val, false);
        return 9;
      }
      out[pos] = TC.VARINT;
      const z = zigzagEncode(val);
      return 1 + writeVarInt(out, pos + 1, z);
    }
    case 'int32': {
      out[pos] = TC.INT32;
      view.setInt32(pos + 1, val, true);
      return 5;
    }
    case 'float64': {
      out[pos] = TC.FLOAT64;
      view.setFloat64(pos + 1, val, false); // big-endian, matches Node build
      return 9;
    }
    case 'string': {
      out[pos] = TC.STRING;
      const { written } = _enc.encodeInto(val, out.subarray(pos + 5));
      view.setUint32(pos + 1, written, true);
      return 5 + written;
    }
    case 'array':
      return _writeArray(out, view, pos, val);
    case 'object':
      return _writeMap(out, view, pos, val);
    case 'timestamp': {
      out[pos] = TC.TIMESTAMP;
      view.setBigInt64(pos + 1, BigInt(val), true);
      return 9;
    }
    default: {
      // FIX: was TC.STRING — collided with genuine strings. Now its own
      // unambiguous type code (see TC.JSON_FALLBACK in index.js).
      out[pos] = TC.JSON_FALLBACK;
      const json = JSON.stringify(val);
      const { written } = _enc.encodeInto(json, out.subarray(pos + 5));
      view.setUint32(pos + 1, written, true);
      return 5 + written;
    }
  }
}

function _writeArray(out, view, pos, arr) {
  if (!Array.isArray(arr)) return _writeValue(out, view, pos, arr, 'object');
  const start = pos;
  out[pos++] = TC.ARRAY;
  pos += writeVarInt(out, pos, arr.length);
  for (let i = 0; i < arr.length; i++) {
    pos += _writeValue(out, view, pos, arr[i]);
  }
  return pos - start;
}

function _writeMap(out, view, pos, obj) {
  if (typeof obj !== 'object' || obj === null) return _writeValue(out, view, pos, obj, 'string');
  const start = pos;
  const keys = Object.keys(obj);
  out[pos++] = TC.MAP;
  pos += writeVarInt(out, pos, keys.length);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    pos += _writeValue(out, view, pos, k, 'string');
    pos += _writeValue(out, view, pos, obj[k]);
  }
  return pos - start;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _toUint8(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  throw new Error('KRSON (browser): expected Uint8Array or ArrayBuffer');
}

function _checkMagic(u8) {
  if (!u8 || u8.length < 8) {
    throw new Error('Invalid KRSON buffer: too short (truncated/corrupt)');
  }
  if (u8[0] !== MAGIC0 || u8[1] !== MAGIC1) {
    throw new Error(`Invalid KRSON magic bytes: 0x${u8[0].toString(16)} 0x${u8[1].toString(16)}`);
  }
}

// FIX: same as index.js — schema-mode reads now verify the buffer's embedded
// schemaId matches the schema being used to read it, instead of only
// checking the generic magic bytes.
function _checkSchemaMatch(expectedSchemaId, u8) {
  _checkMagic(u8);
  if (u8[3] & FLAG_HAS_SCHEMA_ID) {
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const embeddedId = view.getUint32(4, true);
    if (embeddedId !== expectedSchemaId) {
      throw new Error(
        `Schema mismatch: buffer was encoded with schema #${embeddedId}, but schema #${expectedSchemaId} was used to read it`
      );
    }
  }
}

// ─── Schema Decode ────────────────────────────────────────────────────────────

function _schemaDecode(schemaId, buf) {
  const schema = _schemas.get(schemaId);
  if (!schema) throw new Error(`Unknown schema ID: ${schemaId}`);

  const u8 = _toUint8(buf);
  _checkSchemaMatch(schemaId, u8);
  _verifyCrcIfEnabled(schema, u8);
  let pos = 8;
  const result = {};

  for (let i = 0; i < schema.fields.length; i++) {
    const field = schema.fields[i];
    const { value, bytesRead } = _decodeValue(u8, pos);
    result[field] = value;
    pos += bytesRead;
  }

  return result;
}

// ─── schema.get() — fast path ────────────────────────────────────────────────

function _schemaGet(schemaId, buf, fieldName) {
  const schema = _schemas.get(schemaId);
  if (!schema) throw new Error(`Unknown schema ID: ${schemaId}`);

  const idx = schema.fieldIndex[fieldName];
  if (idx === undefined) throw new Error(`Field not found: ${fieldName}`);

  const u8 = _toUint8(buf);
  _checkSchemaMatch(schemaId, u8);
  _verifyCrcIfEnabled(schema, u8);

  if (schema.offsets[idx] !== null) {
    const pos = 8 + schema.offsets[idx];
    return _decodeValue(u8, pos).value;
  }

  let lastKnownIdx = idx - 1;
  while (lastKnownIdx >= 0 && schema.offsets[lastKnownIdx] === null) lastKnownIdx--;

  let pos = lastKnownIdx >= 0 ? 8 + schema.offsets[lastKnownIdx] : 8;
  let startIdx = lastKnownIdx >= 0 ? lastKnownIdx : 0;

  for (let i = startIdx; i < idx; i++) {
    const { bytesRead } = _decodeValue(u8, pos);
    pos += bytesRead;
  }

  return _decodeValue(u8, pos).value;
}

// ─── schema.getMany() ─────────────────────────────────────────────────────────

function _schemaGetMany(schemaId, buf, fieldNames) {
  const schema = _schemas.get(schemaId);
  if (!schema) throw new Error(`Unknown schema ID: ${schemaId}`);

  const u8 = _toUint8(buf);
  _checkSchemaMatch(schemaId, u8);
  _verifyCrcIfEnabled(schema, u8);

  const requests = fieldNames.map(name => {
    const idx = schema.fieldIndex[name];
    if (idx === undefined) throw new Error(`Field not found: ${name}`);
    return { name, idx };
  }).sort((a, b) => a.idx - b.idx);

  const result = {};
  let pos = 8;
  let currentIdx = 0;

  for (const req of requests) {
    while (currentIdx < req.idx) {
      const { bytesRead } = _decodeValue(u8, pos);
      pos += bytesRead;
      currentIdx++;
    }
    const { value, bytesRead } = _decodeValue(u8, pos);
    result[req.name] = value;
    pos += bytesRead;
    currentIdx++;
  }

  return result;
}

// ─── Value decoder ────────────────────────────────────────────────────────────
// FIX: bounds-checked the same way as index.js — truncated/corrupt buffers
// now throw clear errors instead of crashing on undefined reads or silently
// returning garbage from an out-of-range claimed length. depth-guarded the
// same way to turn runaway nesting into a clean error.

function _decodeValue(u8, pos, table, depth = 0) {
  if (depth > MAX_NEST_DEPTH) {
    throw new Error(`KRSON: maximum nesting depth (${MAX_NEST_DEPTH}) exceeded — buffer may be corrupt or malicious`);
  }
  if (pos >= u8.length) {
    throw new Error('KRSON: unexpected end of buffer while decoding (truncated/corrupt buffer)');
  }
  const tc = u8[pos];
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  switch (tc) {
    case TC.NULL:
      return { value: null, bytesRead: 1 };
    case TC.BOOL_FALSE:
      return { value: false, bytesRead: 1 };
    case TC.BOOL_TRUE:
      return { value: true, bytesRead: 1 };

    case TC.VARINT: {
      const { value: z, bytesRead } = readVarInt(u8, pos + 1);
      const value = zigzagDecode(z);
      return { value, bytesRead: 1 + bytesRead };
    }

    case TC.INT32:
      if (pos + 5 > u8.length) throw new Error('KRSON: truncated buffer (INT32 read past end)');
      return { value: view.getInt32(pos + 1, true), bytesRead: 5 };

    case TC.FLOAT64:
      if (pos + 9 > u8.length) throw new Error('KRSON: truncated buffer (FLOAT64 read past end)');
      return { value: view.getFloat64(pos + 1, false), bytesRead: 9 };

    case TC.TIMESTAMP:
      if (pos + 9 > u8.length) throw new Error('KRSON: truncated buffer (TIMESTAMP read past end)');
      return { value: Number(view.getBigInt64(pos + 1, true)), bytesRead: 9 };

    case TC.STRING: {
      if (pos + 5 > u8.length) throw new Error('KRSON: truncated buffer (STRING length header past end)');
      const len = view.getUint32(pos + 1, true);
      if (pos + 5 + len > u8.length) throw new Error('KRSON: truncated/corrupt buffer (STRING length exceeds available data)');
      // FIX: no more JSON-sniffing — a genuine string is always returned
      // as-is, even if it happens to start with '[' or '{'.
      const value = _dec.decode(u8.subarray(pos + 5, pos + 5 + len));
      return { value, bytesRead: 5 + len };
    }

    case TC.JSON_FALLBACK: {
      if (pos + 5 > u8.length) throw new Error('KRSON: truncated buffer (JSON_FALLBACK length header past end)');
      const len = view.getUint32(pos + 1, true);
      if (pos + 5 + len > u8.length) throw new Error('KRSON: truncated/corrupt buffer (JSON_FALLBACK length exceeds available data)');
      const str = _dec.decode(u8.subarray(pos + 5, pos + 5 + len));
      let value;
      try { value = JSON.parse(str); } catch (e) {
        throw new Error('KRSON: corrupt JSON_FALLBACK value (buffer may be corrupt)');
      }
      return { value, bytesRead: 5 + len };
    }

    case TC.STRING_REF: {
      const { value: idx, bytesRead } = readVarInt(u8, pos + 1);
      const value = (table && table[idx] !== undefined) ? table[idx] : `[REF:${idx}]`;
      return { value, bytesRead: 1 + bytesRead };
    }

    case TC.ARRAY: {
      const { value: len, bytesRead: lenBytes } = readVarInt(u8, pos + 1);
      let p = pos + 1 + lenBytes;
      const arr = [];
      for (let i = 0; i < len; i++) {
        const { value: item, bytesRead: itemBytes } = _decodeValue(u8, p, table, depth + 1);
        arr.push(item);
        p += itemBytes;
      }
      return { value: arr, bytesRead: p - pos };
    }

    case TC.MAP: {
      const { value: count, bytesRead: countBytes } = readVarInt(u8, pos + 1);
      let p = pos + 1 + countBytes;
      const obj = {};
      for (let i = 0; i < count; i++) {
        const { value: key, bytesRead: keyBytes } = _decodeValue(u8, p, table, depth + 1);
        p += keyBytes;
        const { value: val, bytesRead: valBytes } = _decodeValue(u8, p, table, depth + 1);
        obj[key] = val;
        p += valBytes;
      }
      return { value: obj, bytesRead: p - pos };
    }

    default:
      throw new Error(`Unknown type code: 0x${tc.toString(16)} at position ${pos} (buffer may be corrupt)`);
  }
}

// ─── Schemaless encode / decode ───────────────────────────────────────────────
// FIX: this used to be `JSON.stringify(obj)` wrapped in a single STRING
// value — not a real binary format at all, no string interning, no native
// arrays/maps. It now mirrors index.js's real implementation: string
// interning table, native ARRAY/MAP type codes, identical wire format to
// the Node build.

function _collectAndSizeT(val, table, tableList, depth = 0) {
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
    return 9;
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
    for (const item of val) size += _collectAndSizeT(item, table, tableList, depth + 1);
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
      size += 1 + varintSize(idx);
      size += _collectAndSizeT(val[k], table, tableList, depth + 1);
    }
    return size;
  }
  return 1;
}

function _writeValueT(out, view, pos, val, table, depth = 0) {
  const start = pos;
  if (val === null || val === undefined) {
    out[pos++] = TC.NULL;
    return pos - start;
  }
  const t = typeof val;
  if (t === 'boolean') {
    out[pos++] = val ? TC.BOOL_TRUE : TC.BOOL_FALSE;
    return pos - start;
  }
  if (t === 'number') {
    if (Number.isInteger(val) && Number.isSafeInteger(val)) {
      out[pos++] = TC.VARINT;
      const z = zigzagEncode(val);
      pos += writeVarInt(out, pos, z);
    } else {
      out[pos++] = TC.FLOAT64;
      view.setFloat64(pos, val, false);
      pos += 8;
    }
    return pos - start;
  }
  if (t === 'string') {
    out[pos++] = TC.STRING_REF;
    pos += writeVarInt(out, pos, table.get(val));
    return pos - start;
  }
  if (Array.isArray(val)) {
    out[pos++] = TC.ARRAY;
    pos += writeVarInt(out, pos, val.length);
    for (const item of val) pos += _writeValueT(out, view, pos, item, table, depth + 1);
    return pos - start;
  }
  if (t === 'object') {
    const keys = Object.keys(val);
    out[pos++] = TC.MAP;
    pos += writeVarInt(out, pos, keys.length);
    for (const k of keys) {
      out[pos++] = TC.STRING_REF;
      pos += writeVarInt(out, pos, table.get(k));
      pos += _writeValueT(out, view, pos, val[k], table, depth + 1);
    }
    return pos - start;
  }
  out[pos++] = TC.NULL;
  return pos - start;
}

function encode(obj) {
  const table = new Map();
  const tableList = [];
  const valueSize = _collectAndSizeT(obj, table, tableList);

  const entryLens = new Array(tableList.length);
  let tableSize = varintSize(tableList.length);
  const encodedEntries = new Array(tableList.length);
  for (let i = 0; i < tableList.length; i++) {
    const encoded = _enc.encode(tableList[i]);
    encodedEntries[i] = encoded;
    entryLens[i] = encoded.length;
    tableSize += varintSize(encoded.length) + encoded.length;
  }

  const total = 8 + tableSize + valueSize;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out[0] = MAGIC0; out[1] = MAGIC1;
  out[2] = VERSION;
  out[3] = FLAG_HAS_STRING_TABLE;
  view.setUint32(4, 0, true);

  let pos = 8;
  pos += writeVarInt(out, pos, tableList.length);
  for (let i = 0; i < tableList.length; i++) {
    pos += writeVarInt(out, pos, entryLens[i]);
    out.set(encodedEntries[i], pos);
    pos += entryLens[i];
  }
  pos += _writeValueT(out, view, pos, obj, table);

  return out;
}

function decode(buf) {
  const u8 = _toUint8(buf);
  _checkMagic(u8);
  let pos = 8;
  let table = null;
  if (u8[3] & FLAG_HAS_STRING_TABLE) {
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const r = readVarInt(u8, pos);
    pos += r.bytesRead;
    table = new Array(r.value);
    for (let i = 0; i < r.value; i++) {
      const lr = readVarInt(u8, pos);
      pos += lr.bytesRead;
      table[i] = _dec.decode(u8.subarray(pos, pos + lr.value));
      pos += lr.value;
    }
  }
  return _decodeValue(u8, pos, table).value;
}

// ─── Single-field schemaless access — get() ──────────────────────────────────
// FIX: this function didn't exist at all in the previous browser.js. Mirrors
// index.js's get(): structurally skips non-matching fields without
// materializing them into JS objects/arrays/strings.

function _readTableSpans(u8, pos) {
  let spans = null;
  if (u8[3] & FLAG_HAS_STRING_TABLE) {
    const r = readVarInt(u8, pos);
    pos += r.bytesRead;
    spans = new Array(r.value);
    for (let i = 0; i < r.value; i++) {
      const lr = readVarInt(u8, pos);
      pos += lr.bytesRead;
      spans[i] = { offset: pos, length: lr.value };
      pos += lr.value;
    }
  }
  return { spans, pos };
}

function _makeLazyTable(u8, spans) {
  if (!spans) return null;
  const cache = new Array(spans.length);
  return new Proxy(cache, {
    get(target, prop) {
      if (typeof prop === 'string' && prop.length > 0 && prop[0] >= '0' && prop[0] <= '9') {
        const idx = prop | 0;
        if (target[idx] === undefined) {
          const e = spans[idx];
          target[idx] = _dec.decode(u8.subarray(e.offset, e.offset + e.length));
        }
        return target[idx];
      }
      return target[prop];
    },
  });
}

function _skipValue(u8, pos, depth = 0) {
  if (depth > MAX_NEST_DEPTH) {
    throw new Error(`KRSON: maximum nesting depth (${MAX_NEST_DEPTH}) exceeded — buffer may be corrupt or malicious`);
  }
  if (pos >= u8.length) {
    throw new Error('KRSON: unexpected end of buffer while skipping a field (truncated/corrupt buffer)');
  }
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tc = u8[pos];
  switch (tc) {
    case TC.NULL:
    case TC.BOOL_FALSE:
    case TC.BOOL_TRUE:
      return 1;
    case TC.VARINT:
    case TC.STRING_REF: {
      const r = readVarInt(u8, pos + 1);
      return 1 + r.bytesRead;
    }
    case TC.INT32:
      if (pos + 5 > u8.length) throw new Error('KRSON: truncated buffer (INT32 skip past end)');
      return 5;
    case TC.FLOAT64:
    case TC.TIMESTAMP:
      if (pos + 9 > u8.length) throw new Error('KRSON: truncated buffer (FLOAT64/TIMESTAMP skip past end)');
      return 9;
    case TC.STRING:
    case TC.JSON_FALLBACK: {
      if (pos + 5 > u8.length) throw new Error('KRSON: truncated buffer (STRING length header past end)');
      const len = view.getUint32(pos + 1, true);
      if (pos + 5 + len > u8.length) throw new Error('KRSON: truncated/corrupt buffer (STRING length exceeds available data)');
      return 5 + len;
    }
    case TC.ARRAY: {
      const r = readVarInt(u8, pos + 1);
      let p = pos + 1 + r.bytesRead;
      for (let i = 0; i < r.value; i++) p += _skipValue(u8, p, depth + 1);
      return p - pos;
    }
    case TC.MAP: {
      const r = readVarInt(u8, pos + 1);
      let p = pos + 1 + r.bytesRead;
      for (let i = 0; i < r.value; i++) {
        p += _skipValue(u8, p, depth + 1);
        p += _skipValue(u8, p, depth + 1);
      }
      return p - pos;
    }
    default:
      throw new Error(`Unknown type code: 0x${tc.toString(16)} at position ${pos} (buffer may be corrupt)`);
  }
}

function get(buf, fieldName) {
  const u8 = _toUint8(buf);
  _checkMagic(u8);
  const { spans, pos: afterTable } = _readTableSpans(u8, 8);

  if (u8[afterTable] !== TC.MAP) {
    throw new Error('get(): top-level KRSON value is not an object (use decode() instead)');
  }

  const targetBuf = _enc.encode(fieldName);
  const r = readVarInt(u8, afterTable + 1);
  let p = afterTable + 1 + r.bytesRead;
  const count = r.value;

  for (let i = 0; i < count; i++) {
    const keyTc = u8[p];

    if (keyTc === TC.STRING_REF) {
      const kr = readVarInt(u8, p + 1);
      const keySpan = spans[kr.value];
      p += 1 + kr.bytesRead;

      let isMatch = keySpan.length === targetBuf.length;
      for (let j = 0; isMatch && j < targetBuf.length; j++) {
        if (u8[keySpan.offset + j] !== targetBuf[j]) isMatch = false;
      }

      if (isMatch) {
        const lazyTable = _makeLazyTable(u8, spans);
        return _decodeValue(u8, p, lazyTable).value;
      }
      p += _skipValue(u8, p);
    } else {
      p += _skipValue(u8, p);
      p += _skipValue(u8, p);
    }
  }

  return undefined;
}

function validate(buf) {
  try {
    const u8 = _toUint8(buf);
    if (u8.length < 8) return false;
    if (u8[0] !== MAGIC0 || u8[1] !== MAGIC1) return false;
    if (u8[2] !== VERSION) return false;
    return true;
  } catch (_) { return false; }
}

// ─── inspect() / prettyPrint() — same as Node build ───────────────────────────

function inspect(buf, schema) {
  if (!validate(buf)) return { error: 'Invalid KRSON buffer' };
  if (schema) return schema.decode(buf);
  try {
    return decode(buf);
  } catch (e) {
    return { error: e.message };
  }
}

function prettyPrint(buf, schema) {
  const u8 = _toUint8(buf);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const obj = inspect(u8, schema);
  const schemaId = view.getUint32(4, true);
  const lines = [];
  lines.push('┌─ KRSON Packet ─────────────────────────');
  lines.push(`│  magic    : KR (0x4B 0x52)`);
  lines.push(`│  version  : v${u8[2]}`);
  lines.push(`│  schema   : ${schemaId === 0 ? 'schemaless' : `#${schemaId}`}`);
  lines.push(`│  size     : ${u8.length} bytes`);
  lines.push('├─ Fields ───────────────────────────────');
  if (obj && typeof obj === 'object' && !obj.error) {
    const keys = Object.keys(obj);
    const maxKey = Math.max(...keys.map(k => k.length));
    for (const [k, v] of Object.entries(obj)) {
      const val = typeof v === 'object' ? JSON.stringify(v) : v;
      lines.push(`│  ${k.padEnd(maxKey)} : ${val}`);
    }
  } else {
    lines.push(`│  ${JSON.stringify(obj)}`);
  }
  lines.push('└────────────────────────────────────────');
  const out = lines.join('\n');
  console.log(out);
  return out;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

const KRSON = { defineSchema, disposeSchema, encode, decode, get, validate, inspect, prettyPrint };

module.exports = { KRSON, defineSchema, disposeSchema, encode, decode, get, validate, inspect, prettyPrint };
