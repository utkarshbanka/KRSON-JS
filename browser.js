'use strict';

/**
 * KRSON v2 — Browser build (ArrayBuffer/Uint8Array/DataView based)
 * Wire-format identical to index.js (Node build) — same bytes on the wire,
 * just no dependency on Buffer (so it works in React/Vue/plain HTML/Workers).
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
  TIMESTAMP:  0x40,
  ARRAY:      0x50,
  MAP:        0x51,
};

const MAGIC0 = 0x4B; // 'K'
const MAGIC1 = 0x52; // 'R'
const VERSION = 0x02;

const FLAG_HAS_STRING_TABLE = 1 << 3;
const FLAG_HAS_SCHEMA_ID    = 1 << 4;

const _enc = new TextEncoder();
const _dec = new TextDecoder('utf-8');

// ─── VarInt ───────────────────────────────────────────────────────────────────

function writeVarInt(arr, offset, value) {
  let v = value < 0 ? -value : value;
  let written = 0;
  do {
    let byte = v & 0x7F;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    arr[offset + written++] = byte;
  } while (v !== 0);
  return written;
}

function readVarInt(arr, offset) {
  let result = 0, shift = 0, bytesRead = 0;
  while (true) {
    if (bytesRead >= 5) throw new Error('VarInt too long');
    const byte = arr[offset + bytesRead++];
    result |= (byte & 0x7F) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value: result, bytesRead };
}

// ─── Schema Registry ──────────────────────────────────────────────────────────

let _nextSchemaId = 1;
const _schemas = new Map();

function defineSchema(def) {
  const id = _nextSchemaId++;
  const fields = Object.keys(def);
  const types  = fields.map(f => def[f]);

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

  _schemas.set(id, { id, fields, types, offsets, fieldIndex });

  return {
    encode(obj)          { return _schemaEncode(id, obj); },
    decode(buf)          { return _schemaDecode(id, buf); },
    get(buf, field)       { return _schemaGet(id, buf, field); },
    getMany(buf, fields)  { return _schemaGetMany(id, buf, fields); },
    id,
  };
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

  const parts = [];
  let totalSize = 8; // header

  for (let i = 0; i < schema.fields.length; i++) {
    const field = schema.fields[i];
    const type  = schema.types[i];
    const val   = obj[field];
    const part  = _encodeValue(val, type);
    parts.push(part);
    totalSize += part.length;
  }

  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);

  out[0] = MAGIC0; out[1] = MAGIC1;
  out[2] = VERSION;
  out[3] = FLAG_HAS_SCHEMA_ID;
  view.setUint32(4, schemaId, true);

  let pos = 8;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }

  return out;
}

function _encodeValue(val, type) {
  if (val === null || val === undefined) {
    return new Uint8Array([TC.NULL]);
  }

  switch (type) {
    case 'bool': {
      return new Uint8Array([val ? TC.BOOL_TRUE : TC.BOOL_FALSE]);
    }
    case 'varint': {
      const isNeg = val < 0;
      const tmp = new Uint8Array(6);
      tmp[0] = isNeg ? TC.VARINT_NEG : TC.VARINT;
      const n = writeVarInt(tmp, 1, Math.abs(val));
      return tmp.slice(0, 1 + n);
    }
    case 'int32': {
      const b = new Uint8Array(5);
      const v = new DataView(b.buffer);
      b[0] = TC.INT32;
      v.setInt32(1, val, true);
      return b;
    }
    case 'float64': {
      const b = new Uint8Array(9);
      const v = new DataView(b.buffer);
      b[0] = TC.FLOAT64;
      v.setFloat64(1, val, false); // big-endian, matches Node build
      return b;
    }
    case 'string': {
      const strBuf = _enc.encode(val);
      const b = new Uint8Array(5 + strBuf.length);
      const v = new DataView(b.buffer);
      b[0] = TC.STRING;
      v.setUint32(1, strBuf.length, true);
      b.set(strBuf, 5);
      return b;
    }
    case 'array':
    case 'object': {
      const json = _enc.encode(JSON.stringify(val));
      const b = new Uint8Array(5 + json.length);
      const v = new DataView(b.buffer);
      b[0] = TC.STRING;
      v.setUint32(1, json.length, true);
      b.set(json, 5);
      return b;
    }
    case 'timestamp': {
      const b = new Uint8Array(9);
      const v = new DataView(b.buffer);
      b[0] = TC.TIMESTAMP;
      v.setBigInt64(1, BigInt(val), true);
      return b;
    }
    default: {
      const json = _enc.encode(JSON.stringify(val));
      const b = new Uint8Array(5 + json.length);
      const v = new DataView(b.buffer);
      b[0] = TC.STRING;
      v.setUint32(1, json.length, true);
      b.set(json, 5);
      return b;
    }
  }
}

// ─── Schema Decode ────────────────────────────────────────────────────────────

function _schemaDecode(schemaId, buf) {
  const schema = _schemas.get(schemaId);
  if (!schema) throw new Error(`Unknown schema ID: ${schemaId}`);

  const u8 = _toUint8(buf);
  _checkMagic(u8);
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
  _checkMagic(u8);

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
  _checkMagic(u8);

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

function _decodeValue(u8, pos) {
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
      const { value, bytesRead } = readVarInt(u8, pos + 1);
      return { value, bytesRead: 1 + bytesRead };
    }
    case TC.VARINT_NEG: {
      const { value, bytesRead } = readVarInt(u8, pos + 1);
      return { value: -value, bytesRead: 1 + bytesRead };
    }

    case TC.INT32:
      return { value: view.getInt32(pos + 1, true), bytesRead: 5 };

    case TC.FLOAT64:
      return { value: view.getFloat64(pos + 1, false), bytesRead: 9 };

    case TC.TIMESTAMP:
      return { value: Number(view.getBigInt64(pos + 1, true)), bytesRead: 9 };

    case TC.STRING:
    case TC.STRING_REF: {
      const len = view.getUint32(pos + 1, true);
      const str = _dec.decode(u8.subarray(pos + 5, pos + 5 + len));
      let value = str;
      if (str[0] === '[' || str[0] === '{') {
        try { value = JSON.parse(str); } catch (_) {}
      }
      return { value, bytesRead: 5 + len };
    }

    default:
      throw new Error(`Unknown type code: 0x${tc.toString(16)}`);
  }
}

// ─── Schemaless encode / decode ───────────────────────────────────────────────

function encode(obj) {
  const payload = _enc.encode(JSON.stringify(obj));
  const out = new Uint8Array(8 + 1 + 4 + payload.length);
  const view = new DataView(out.buffer);
  out[0] = MAGIC0; out[1] = MAGIC1;
  out[2] = VERSION; out[3] = 0;
  view.setUint32(4, 0, true);
  out[8] = TC.STRING;
  view.setUint32(9, payload.length, true);
  out.set(payload, 13);
  return out;
}

function decode(buf) {
  const u8 = _toUint8(buf);
  _checkMagic(u8);
  return _decodeValue(u8, 8).value;
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _toUint8(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  throw new Error('KRSON (browser): expected Uint8Array or ArrayBuffer');
}

function _checkMagic(u8) {
  if (u8[0] !== MAGIC0 || u8[1] !== MAGIC1) {
    throw new Error(`Invalid KRSON magic bytes: 0x${u8[0].toString(16)} 0x${u8[1].toString(16)}`);
  }
}

// ─── inspect() / prettyPrint() — same as Node build ───────────────────────────

function inspect(buf, schema) {
  if (!validate(buf)) return { error: 'Invalid KRSON buffer' };
  if (schema) return schema.decode(buf);
  try {
    const u8 = _toUint8(buf);
    return _decodeValue(u8, 8).value;
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

const KRSON = { defineSchema, encode, decode, validate, inspect, prettyPrint };

module.exports = { KRSON, defineSchema, encode, decode, validate, inspect, prettyPrint };
