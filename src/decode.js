'use strict';

const { TC, FLAG_HAS_STRING_TABLE, MAX_NEST_DEPTH } = require('./constants');
const { readVarInt, zigzagDecode } = require('./varint');
const { verifyCrcIfEnabled } = require('./crc32');
const { getSchema } = require('./schema-registry');
const { checkMagic, checkSchemaMatch } = require('./validate');

// ─── Value decoder ────────────────────────────────────────────────────────────
// No bounds checking previously existed. A truncated buffer (e.g. a network
// packet cut short) crashed with a confusing internal TypeError (reading
// .toString() on undefined), and a corrupted/adversarial buffer claiming a
// huge STRING length (e.g. 0xFFFFFFFF) silently read past the real data and
// returned garbage instead of erroring. Both are caught explicitly here with
// clear messages. A `depth` guard also turns runaway/malicious deeply-nested
// input into a clean error instead of an uncatchable-feeling native
// "Maximum call stack size exceeded".
function decodeValue(buf, pos, table, depth = 0) {
  if (depth > MAX_NEST_DEPTH) {
    throw new Error(`KRSON: maximum nesting depth (${MAX_NEST_DEPTH}) exceeded — buffer may be corrupt or malicious`);
  }
  if (pos >= buf.length) {
    throw new Error('KRSON: unexpected end of buffer while decoding (truncated/corrupt buffer)');
  }
  const tc = buf[pos];

  switch (tc) {
    case TC.NULL:
      return { value: null, bytesRead: 1 };
    case TC.BOOL_FALSE:
      return { value: false, bytesRead: 1 };
    case TC.BOOL_TRUE:
      return { value: true, bytesRead: 1 };

    case TC.VARINT: {
      const { value: z, bytesRead } = readVarInt(buf, pos + 1);
      const value = zigzagDecode(z);
      return { value, bytesRead: 1 + bytesRead };
    }

    case TC.INT32:
      if (pos + 5 > buf.length) throw new Error('KRSON: truncated buffer (INT32 read past end)');
      return { value: buf.readInt32LE(pos + 1), bytesRead: 5 };

    case TC.FLOAT64:
      if (pos + 9 > buf.length) throw new Error('KRSON: truncated buffer (FLOAT64 read past end)');
      return { value: buf.readDoubleBE(pos + 1), bytesRead: 9 };

    case TC.TIMESTAMP:
      if (pos + 9 > buf.length) throw new Error('KRSON: truncated buffer (TIMESTAMP read past end)');
      return { value: Number(buf.readBigInt64LE(pos + 1)), bytesRead: 9 };

    case TC.STRING: {
      // Claimed length is validated against the actual buffer size before
      // reading, so a corrupted/adversarial length (e.g. 4GB) errors
      // cleanly instead of silently returning truncated garbage.
      if (pos + 5 > buf.length) throw new Error('KRSON: truncated buffer (STRING length header past end)');
      const len = buf.readUInt32LE(pos + 1);
      if (pos + 5 + len > buf.length) throw new Error('KRSON: truncated/corrupt buffer (STRING length exceeds available data)');
      // A genuine string is always returned as-is, even if it happens to
      // start with '[' or '{' — no JSON-sniffing.
      const value = buf.toString('utf8', pos + 5, pos + 5 + len);
      return { value, bytesRead: 5 + len };
    }
    case TC.JSON_FALLBACK: {
      if (pos + 5 > buf.length) throw new Error('KRSON: truncated buffer (JSON_FALLBACK length header past end)');
      const len = buf.readUInt32LE(pos + 1);
      if (pos + 5 + len > buf.length) throw new Error('KRSON: truncated/corrupt buffer (JSON_FALLBACK length exceeds available data)');
      const str = buf.toString('utf8', pos + 5, pos + 5 + len);
      let value;
      try { value = JSON.parse(str); } catch (e) {
        throw new Error('KRSON: corrupt JSON_FALLBACK value (buffer may be corrupt)');
      }
      return { value, bytesRead: 5 + len };
    }
    case TC.STRING_REF: {
      const { value: idx, bytesRead } = readVarInt(buf, pos + 1);
      const value = (table && table[idx] !== undefined) ? table[idx] : `[REF:${idx}]`;
      return { value, bytesRead: 1 + bytesRead };
    }

    case TC.ARRAY: {
      const { value: len, bytesRead: lenBytes } = readVarInt(buf, pos + 1);
      let p = pos + 1 + lenBytes;
      const arr = [];
      for (let i = 0; i < len; i++) {
        const { value: item, bytesRead: itemBytes } = decodeValue(buf, p, table, depth + 1);
        arr.push(item);
        p += itemBytes;
      }
      return { value: arr, bytesRead: p - pos };
    }

    case TC.MAP: {
      const { value: count, bytesRead: countBytes } = readVarInt(buf, pos + 1);
      let p = pos + 1 + countBytes;
      const obj = {};
      for (let i = 0; i < count; i++) {
        const { value: key, bytesRead: keyBytes } = decodeValue(buf, p, table, depth + 1);
        p += keyBytes;
        const { value: val, bytesRead: valBytes } = decodeValue(buf, p, table, depth + 1);
        obj[key] = val;
        p += valBytes;
      }
      return { value: obj, bytesRead: p - pos };
    }

    default:
      throw new Error(`Unknown type code: 0x${tc.toString(16)}`);
  }
}

// Computes how many bytes a value occupies without decoding/allocating it.
function skipValue(buf, pos, depth = 0) {
  if (depth > MAX_NEST_DEPTH) {
    throw new Error(`KRSON: maximum nesting depth (${MAX_NEST_DEPTH}) exceeded — buffer may be corrupt or malicious`);
  }
  if (pos >= buf.length) {
    throw new Error('KRSON: unexpected end of buffer while skipping a field (truncated/corrupt buffer)');
  }
  const tc = buf[pos];
  switch (tc) {
    case TC.NULL:
    case TC.BOOL_FALSE:
    case TC.BOOL_TRUE:
      return 1;
    case TC.VARINT:
    case TC.STRING_REF: {
      const r = readVarInt(buf, pos + 1);
      return 1 + r.bytesRead;
    }
    case TC.INT32:
      if (pos + 5 > buf.length) throw new Error('KRSON: truncated buffer (INT32 skip past end)');
      return 5;
    case TC.FLOAT64:
    case TC.TIMESTAMP:
      if (pos + 9 > buf.length) throw new Error('KRSON: truncated buffer (FLOAT64/TIMESTAMP skip past end)');
      return 9;
    case TC.STRING:
    case TC.JSON_FALLBACK: {
      if (pos + 5 > buf.length) throw new Error('KRSON: truncated buffer (STRING length header past end)');
      const len = buf.readUInt32LE(pos + 1);
      if (pos + 5 + len > buf.length) throw new Error('KRSON: truncated/corrupt buffer (STRING length exceeds available data)');
      return 5 + len;
    }
    case TC.ARRAY: {
      const r = readVarInt(buf, pos + 1);
      let p = pos + 1 + r.bytesRead;
      for (let i = 0; i < r.value; i++) p += skipValue(buf, p, depth + 1);
      return p - pos;
    }
    case TC.MAP: {
      const r = readVarInt(buf, pos + 1);
      let p = pos + 1 + r.bytesRead;
      for (let i = 0; i < r.value; i++) {
        p += skipValue(buf, p, depth + 1); // key
        p += skipValue(buf, p, depth + 1); // value
      }
      return p - pos;
    }
    default:
      throw new Error(`Unknown type code: 0x${tc.toString(16)} at position ${pos} (buffer may be corrupt)`);
  }
}

// ─── Schema-mode decode/get/getMany ───────────────────────────────────────────

function schemaDecode(schemaId, buf) {
  const schema = getSchema(schemaId);
  if (!schema) throw new Error(`Unknown schema ID: ${schemaId}`);

  checkSchemaMatch(schemaId, buf);
  verifyCrcIfEnabled(schema, buf);
  let pos = 8; // skip header
  const result = {};

  for (let i = 0; i < schema.fields.length; i++) {
    const field = schema.fields[i];
    const { value, bytesRead } = decodeValue(buf, pos);
    result[field] = value;
    pos += bytesRead;
  }

  return result;
}

function schemaGet(schemaId, buf, fieldName) {
  const schema = getSchema(schemaId);
  if (!schema) throw new Error(`Unknown schema ID: ${schemaId}`);

  const idx = schema.fieldIndex[fieldName];
  if (idx === undefined) throw new Error(`Field not found: ${fieldName}`);

  checkSchemaMatch(schemaId, buf);
  verifyCrcIfEnabled(schema, buf);

  // Fast path: precomputed offset → direct read, no parsing of other fields
  if (schema.offsets[idx] !== null) {
    const pos = 8 + schema.offsets[idx]; // 8 = header size
    return decodeValue(buf, pos).value;
  }

  // Slow path: scan from last known offset
  let lastKnownIdx = idx - 1;
  while (lastKnownIdx >= 0 && schema.offsets[lastKnownIdx] === null) lastKnownIdx--;

  let pos = lastKnownIdx >= 0 ? 8 + schema.offsets[lastKnownIdx] : 8;
  let startIdx = lastKnownIdx >= 0 ? lastKnownIdx : 0;

  for (let i = startIdx; i < idx; i++) {
    const { bytesRead } = decodeValue(buf, pos);
    pos += bytesRead;
  }

  return decodeValue(buf, pos).value;
}

function schemaGetMany(schemaId, buf, fieldNames) {
  const schema = getSchema(schemaId);
  if (!schema) throw new Error(`Unknown schema ID: ${schemaId}`);

  checkSchemaMatch(schemaId, buf);
  verifyCrcIfEnabled(schema, buf);

  // Sort requested fields by their index so we scan left→right only once
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
      const { bytesRead } = decodeValue(buf, pos);
      pos += bytesRead;
      currentIdx++;
    }
    const { value, bytesRead } = decodeValue(buf, pos);
    result[req.name] = value;
    pos += bytesRead;
    currentIdx++;
  }

  return result;
}

// ─── Schemaless decode ─────────────────────────────────────────────────────────

function decode(buf) {
  checkMagic(buf);
  let pos = 8;
  let table = null;
  if (buf[3] & FLAG_HAS_STRING_TABLE) {
    const r = readVarInt(buf, pos);
    pos += r.bytesRead;
    table = new Array(r.value);
    for (let i = 0; i < r.value; i++) {
      const lr = readVarInt(buf, pos);
      pos += lr.bytesRead;
      table[i] = buf.toString('utf8', pos, pos + lr.value);
      pos += lr.value;
    }
  }
  return decodeValue(buf, pos, table).value;
}

// ─── Single-field schemaless access — get() ──────────────────────────────────
// Mirrors schema.get()'s fast path, but for schemaless buffers. Avoids the
// waste of a full decode() when only one top-level field is needed:
//   - string table is NOT eagerly decoded into JS strings (just byte spans)
//   - keys are compared as raw UTF-8 bytes against the target field name,
//     so non-matching keys never get a buf.toString() call
//   - values of non-matching fields are skipped structurally (skipValue),
//     never materialized into JS objects/arrays/strings
//   - only once a match is found do we decode that one value, and any
//     string-refs inside it are decoded lazily/on-demand via a Proxy-backed
//     table (so a matched nested object still doesn't pull in unrelated
//     table entries it doesn't reference)

function readTableSpans(buf, pos) {
  let spans = null;
  if (buf[3] & FLAG_HAS_STRING_TABLE) {
    const r = readVarInt(buf, pos);
    pos += r.bytesRead;
    spans = new Array(r.value);
    for (let i = 0; i < r.value; i++) {
      const lr = readVarInt(buf, pos);
      pos += lr.bytesRead;
      spans[i] = { offset: pos, length: lr.value };
      pos += lr.value;
    }
  }
  return { spans, pos };
}

function makeLazyTable(buf, spans) {
  if (!spans) return null;
  const cache = new Array(spans.length);
  return new Proxy(cache, {
    get(target, prop) {
      if (typeof prop === 'string' && prop.length > 0 && prop[0] >= '0' && prop[0] <= '9') {
        const idx = prop | 0;
        if (target[idx] === undefined) {
          const e = spans[idx];
          target[idx] = buf.toString('utf8', e.offset, e.offset + e.length);
        }
        return target[idx];
      }
      return target[prop];
    },
  });
}

function get(buf, fieldName) {
  checkMagic(buf);
  const { spans, pos: afterTable } = readTableSpans(buf, 8);

  if (buf[afterTable] !== TC.MAP) {
    throw new Error('get(): top-level KRSON value is not an object (use decode() instead)');
  }

  const targetBuf = Buffer.from(fieldName, 'utf8');
  const r = readVarInt(buf, afterTable + 1);
  let p = afterTable + 1 + r.bytesRead;
  const count = r.value;

  for (let i = 0; i < count; i++) {
    const keyTc = buf[p];

    if (keyTc === TC.STRING_REF) {
      const kr = readVarInt(buf, p + 1);
      const keySpan = spans[kr.value];
      p += 1 + kr.bytesRead;

      let isMatch = keySpan.length === targetBuf.length;
      for (let j = 0; isMatch && j < targetBuf.length; j++) {
        if (buf[keySpan.offset + j] !== targetBuf[j]) isMatch = false;
      }

      if (isMatch) {
        const lazyTable = makeLazyTable(buf, spans);
        return decodeValue(buf, p, lazyTable).value;
      }
      p += skipValue(buf, p);
    } else {
      // inline (non-interned) key — fall back to skip both
      p += skipValue(buf, p);
      p += skipValue(buf, p);
    }
  }

  return undefined; // field not found
}

module.exports = {
  decodeValue,
  skipValue,
  schemaDecode,
  schemaGet,
  schemaGetMany,
  decode,
  get,
};
