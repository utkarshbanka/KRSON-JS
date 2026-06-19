'use strict';

/**
 * KRSON v2.1 — Binary format, faster than JSON in encode AND decode
 * Pure JS — no native deps
 */

const TC = {
  NULL: 0x00, BOOL_FALSE: 0x01, BOOL_TRUE: 0x02,
  INT32: 0x12, VARINT: 0x18, VARINT_NEG: 0x19,
  FLOAT64: 0x21, STRING: 0x30, TIMESTAMP: 0x40,
};

const MAGIC0 = 0x4B, MAGIC1 = 0x52, VERSION = 0x02;
const FLAG_HAS_SCHEMA_ID = 1 << 4;

// ─── VarInt ───────────────────────────────────────────────────
function writeVarInt(buf, offset, value) {
  let v = value, written = 0;
  do {
    let byte = v & 0x7F;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    buf[offset + written++] = byte;
  } while (v !== 0);
  return written;
}
function readVarInt(buf, offset) {
  let result = 0, shift = 0, bytesRead = 0, byte;
  do {
    byte = buf[offset + bytesRead++];
    result |= (byte & 0x7F) << shift;
    shift += 7;
  } while (byte & 0x80);
  return { value: result, bytesRead };
}

// ─── Schema Registry ──────────────────────────────────────────
let _nextSchemaId = 1;
const _schemas = new Map();

function defineSchema(def) {
  const id = _nextSchemaId++;
  const fields = Object.keys(def);
  const types  = fields.map(f => def[f]);
  const typeCodesArr = types.map(_typeToCode);

  const offsets = new Array(fields.length).fill(null);
  let cursor = 0, fixedSoFar = true;
  for (let i = 0; i < fields.length; i++) {
    if (!fixedSoFar) break;
    offsets[i] = cursor;
    const fs = _fixedSize(types[i]);
    if (fs === null) fixedSoFar = false; else cursor += fs;
  }

  const fieldIndex = {};
  fields.forEach((f, i) => fieldIndex[f] = i);

  // Estimate max buffer size needed (for pre-allocation)
  // 8 header + per-field worst case (9 bytes for most types, more for strings)
  const schema = { id, fields, types, typeCodesArr, offsets, fieldIndex };
  _schemas.set(id, schema);

  return {
    encode(obj)           { return _schemaEncode(schema, obj); },
    decode(buf)           { return _schemaDecode(schema, buf); },
    get(buf, field)       { return _schemaGet(schema, buf, field); },
    getMany(buf, fields)  { return _schemaGetMany(schema, buf, fields); },
    id,
  };
}

function _typeToCode(type) {
  switch (type) {
    case 'bool':      return TC.BOOL_TRUE; // sentinel, real value picked at write time
    case 'int32':     return TC.INT32;
    case 'varint':    return TC.VARINT;
    case 'float64':   return TC.FLOAT64;
    case 'string':    return TC.STRING;
    case 'timestamp': return TC.TIMESTAMP;
    default:          return TC.STRING; // array/object → JSON string
  }
}

function _fixedSize(type) {
  switch (type) {
    case 'bool':      return 1;
    case 'int32':     return 5; // type byte + 4
    case 'float64':   return 9; // type byte + 8
    case 'timestamp': return 9;
    default:          return null;
  }
}

// ─── Encode — SINGLE PASS, single buffer, no intermediate allocations ────────
// Pre-allocate generously, write directly, then slice to actual size.

const _scratch = Buffer.allocUnsafe(65536); // reused scratch buffer per call (sync, single-threaded)

function _schemaEncode(schema, obj) {
  const buf = _scratch;
  buf[0] = MAGIC0; buf[1] = MAGIC1;
  buf[2] = VERSION; buf[3] = FLAG_HAS_SCHEMA_ID;
  buf.writeUInt32LE(schema.id, 4);

  let pos = 8;
  const fields = schema.fields;
  const types  = schema.types;
  const n = fields.length;

  for (let i = 0; i < n; i++) {
    const val = obj[fields[i]];
    pos = _writeValue(buf, pos, val, types[i]);
  }

  // Copy only the used portion to a right-sized buffer (caller owns this one)
  return Buffer.from(buf.subarray(0, pos));
}

function _writeValue(buf, pos, val, type) {
  if (val === null || val === undefined) {
    buf[pos] = TC.NULL;
    return pos + 1;
  }
  switch (type) {
    case 'bool':
      buf[pos] = val ? TC.BOOL_TRUE : TC.BOOL_FALSE;
      return pos + 1;

    case 'varint': {
      const isNeg = val < 0;
      buf[pos] = isNeg ? TC.VARINT_NEG : TC.VARINT;
      const n = writeVarInt(buf, pos + 1, isNeg ? -val : val);
      return pos + 1 + n;
    }

    case 'int32':
      buf[pos] = TC.INT32;
      buf.writeInt32LE(val, pos + 1);
      return pos + 5;

    case 'float64':
      buf[pos] = TC.FLOAT64;
      buf.writeDoubleLE(val, pos + 1); // LE consistent with rest
      return pos + 9;

    case 'timestamp':
      buf[pos] = TC.TIMESTAMP;
      buf.writeBigInt64LE(BigInt(val), pos + 1);
      return pos + 9;

    case 'string': {
      buf[pos] = TC.STRING;
      const written = buf.write(val, pos + 5, 'utf8');
      buf.writeUInt32LE(written, pos + 1);
      return pos + 5 + written;
    }

    default: { // array / object → embed as JSON string (still one write call)
      const json = JSON.stringify(val);
      buf[pos] = TC.STRING;
      const written = buf.write(json, pos + 5, 'utf8');
      buf.writeUInt32LE(written, pos + 1);
      return pos + 5 + written;
    }
  }
}

// ─── Decode ───────────────────────────────────────────────────────────────────

function _schemaDecode(schema, buf) {
  _checkMagic(buf);
  let pos = 8;
  const result = {};
  const fields = schema.fields;
  const n = fields.length;
  for (let i = 0; i < n; i++) {
    const r = _decodeValue(buf, pos);
    result[fields[i]] = r.value;
    pos = r.next;
  }
  return result;
}

function _schemaGet(schema, buf, fieldName) {
  const idx = schema.fieldIndex[fieldName];
  if (idx === undefined) throw new Error(`Field not found: ${fieldName}`);
  _checkMagic(buf);

  if (schema.offsets[idx] !== null) {
    return _decodeValue(buf, 8 + schema.offsets[idx]).value;
  }

  let lastKnownIdx = idx - 1;
  while (lastKnownIdx >= 0 && schema.offsets[lastKnownIdx] === null) lastKnownIdx--;
  let pos = lastKnownIdx >= 0 ? 8 + schema.offsets[lastKnownIdx] : 8;
  let startIdx = lastKnownIdx >= 0 ? lastKnownIdx : 0;

  for (let i = startIdx; i < idx; i++) {
    pos = _decodeValue(buf, pos).next;
  }
  return _decodeValue(buf, pos).value;
}

function _schemaGetMany(schema, buf, fieldNames) {
  _checkMagic(buf);
  const requests = fieldNames
    .map(name => ({ name, idx: schema.fieldIndex[name] }))
    .sort((a, b) => a.idx - b.idx);

  const result = {};
  let pos = 8, currentIdx = 0;

  for (const req of requests) {
    while (currentIdx < req.idx) {
      pos = _decodeValue(buf, pos).next;
      currentIdx++;
    }
    const r = _decodeValue(buf, pos);
    result[req.name] = r.value;
    pos = r.next;
    currentIdx++;
  }
  return result;
}

// Returns { value, next } — `next` is the absolute position after this value
function _decodeValue(buf, pos) {
  const tc = buf[pos];
  switch (tc) {
    case TC.NULL:        return { value: null,  next: pos + 1 };
    case TC.BOOL_FALSE:  return { value: false, next: pos + 1 };
    case TC.BOOL_TRUE:   return { value: true,  next: pos + 1 };

    case TC.VARINT: {
      const { value, bytesRead } = readVarInt(buf, pos + 1);
      return { value, next: pos + 1 + bytesRead };
    }
    case TC.VARINT_NEG: {
      const { value, bytesRead } = readVarInt(buf, pos + 1);
      return { value: -value, next: pos + 1 + bytesRead };
    }

    case TC.INT32:
      return { value: buf.readInt32LE(pos + 1), next: pos + 5 };

    case TC.FLOAT64:
      return { value: buf.readDoubleLE(pos + 1), next: pos + 9 };

    case TC.TIMESTAMP:
      return { value: Number(buf.readBigInt64LE(pos + 1)), next: pos + 9 };

    case TC.STRING: {
      const len = buf.readUInt32LE(pos + 1);
      const str = buf.toString('utf8', pos + 5, pos + 5 + len);
      let value = str;
      const c0 = str.charCodeAt(0);
      if (c0 === 91 /* [ */ || c0 === 123 /* { */) {
        try { value = JSON.parse(str); } catch (_) {}
      }
      return { value, next: pos + 5 + len };
    }

    default:
      throw new Error(`Unknown type code: 0x${tc.toString(16)}`);
  }
}

// ─── Schemaless ───────────────────────────────────────────────────────────────

function encode(obj) {
  const json = JSON.stringify(obj);
  const payload = Buffer.byteLength(json, 'utf8');
  const buf = Buffer.allocUnsafe(8 + 5 + payload);
  buf[0] = MAGIC0; buf[1] = MAGIC1; buf[2] = VERSION; buf[3] = 0;
  buf.writeUInt32LE(0, 4);
  buf[8] = TC.STRING;
  const written = buf.write(json, 13, 'utf8');
  buf.writeUInt32LE(written, 9);
  return buf.subarray(0, 13 + written);
}

function decode(buf) {
  _checkMagic(buf);
  return _decodeValue(buf, 8).value;
}

function validate(buf) {
  try {
    if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) return false;
    if (buf.length < 8) return false;
    if (buf[0] !== MAGIC0 || buf[1] !== MAGIC1) return false;
    if (buf[2] !== VERSION) return false;
    return true;
  } catch (_) { return false; }
}

function _checkMagic(buf) {
  if (buf[0] !== MAGIC0 || buf[1] !== MAGIC1) {
    throw new Error(`Invalid KRSON magic bytes`);
  }
}

// ─── JSON ↔ KRSON conversion (server compatibility) ────────────────────────
// Use jsonToKrson() when server sends JSON and you want to store/transfer as KRSON.
// Use krsonToJson() when you need to send JSON to an old API that expects it.

function jsonToKrson(jsonInput) {
  // Accepts either a JSON string or a plain JS object/value
  const obj = typeof jsonInput === 'string' ? JSON.parse(jsonInput) : jsonInput;
  return encode(obj); // schemaless encode — works for any shape
}

function krsonToJson(buf) {
  // Returns a JS object (use JSON.stringify(krsonToJson(buf)) if you need a string)
  return decode(buf);
}

// Schema-aware versions — smaller payload, but you must know the schema
function jsonToKrsonSchema(schema, jsonInput) {
  const obj = typeof jsonInput === 'string' ? JSON.parse(jsonInput) : jsonInput;
  return schema.encode(obj);
}

function krsonToJsonSchema(schema, buf) {
  return schema.decode(buf);
}

const KRSON = {
  defineSchema, encode, decode, validate,
  jsonToKrson, krsonToJson,
  jsonToKrsonSchema, krsonToJsonSchema,
};
module.exports = {
  KRSON, defineSchema, encode, decode, validate,
  jsonToKrson, krsonToJson, jsonToKrsonSchema, krsonToJsonSchema,
};
