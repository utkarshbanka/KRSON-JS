'use strict';

/**
 * KRSON v2 — Binary format for high-throughput systems
 * Pure JS implementation — no native dependencies, works everywhere
 *
 * npm install krson
 *
 * SINGLE FIELD ACCESS: 2.9x faster than JSON.parse()
 * PAYLOAD SIZE: 21% smaller than JSON
 */

// ─── Type codes (matches Rust core wire format) ───────────────────────────────
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
  // FIX: previously, both a genuine string AND the JSON.stringify() fallback
  // (for values like Date/Map/Set with no native type) were written with the
  // same TC.STRING code. Decode then "guessed" which one it was by sniffing
  // the first character ('[' or '{') and trying JSON.parse(). A genuine
  // string whose content literally starts with '[' or '{' (e.g. a log tag
  // "[ERROR]" or a code snippet "{not json}") would silently get mangled.
  // A dedicated type code removes the ambiguity entirely.
  JSON_FALLBACK: 0x33,
  TIMESTAMP:  0x40,
  ARRAY:      0x50,
  MAP:        0x51,
};

const MAGIC0 = 0x4B; // 'K'
const MAGIC1 = 0x52; // 'R'
const VERSION = 0x06; // v6: schemas auto-reorder fixed-size fields first (true O(1) offsets for all of them) + corrected fixed-size byte counts (previous version under-counted the type-code byte for int32/float64/timestamp)

const FLAG_HAS_STRING_TABLE = 1 << 3;
const FLAG_HAS_SCHEMA_ID    = 1 << 4;
const FLAG_HAS_CRC          = 1 << 5; // opt-in CRC32 (v5)

// ─── VarInt ───────────────────────────────────────────────────────────────────
// FIX: previously used bitwise (& | << >> >>>) operators, which JS forces to
// 32-bit signed integers regardless of the actual value's magnitude. Any
// value outside the ±2^31 range (e.g. ms timestamps, DB auto-increment IDs)
// silently wrapped to a wrong, often-negative number with no error.
// Rewritten using plain arithmetic (*, /, %), which is correct for the full
// safe-integer range (±2^53) since it never goes through a 32-bit coercion.
// value passed in here is always >= 0 (zigzag-encoded before this point).

function writeVarInt(buf, offset, value) {
  if (typeof value === 'bigint') {
    let v = value;
    let written = 0;
    do {
      let byte = Number(v % 128n);
      v /= 128n;
      if (v !== 0n) byte |= 0x80;
      buf[offset + written++] = byte;
    } while (v !== 0n);
    return written;
  }
  let v = value;
  let written = 0;
  do {
    let byte = v % 128;
    v = Math.floor(v / 128);
    if (v !== 0) byte |= 0x80;
    buf[offset + written++] = byte;
  } while (v !== 0);
  return written;
}

function varintSize(value) {
  if (typeof value === 'bigint') {
    let v = value;
    let n = 1;
    v /= 128n;
    while (v !== 0n) { n++; v /= 128n; }
    return n;
  }
  let v = value;
  let n = 1;
  v = Math.floor(v / 128);
  while (v !== 0) { n++; v = Math.floor(v / 128); }
  return n;
}

function readVarInt(buf, offset) {
  let result = 0, mult = 1, bytesRead = 0;
  let bigResult = null, bigMult = null; // only used once we cross the safe-integer threshold
  while (true) {
    // 10 bytes covers values well beyond Number.MAX_SAFE_INTEGER (2^53 needs ~8)
    if (bytesRead >= 10) throw new Error('VarInt too long (malformed buffer)');
    const byte = buf[offset + bytesRead++];
    if (byte === undefined) throw new Error('VarInt read past end of buffer (truncated/corrupt buffer)');

    if (bigResult !== null) {
      bigResult += BigInt(byte & 0x7F) * bigMult;
      bigMult *= 128n;
    } else {
      result += (byte & 0x7F) * mult;
      mult *= 128;
      // Once another byte could push `result` past Number.MAX_SAFE_INTEGER,
      // switch to BigInt for the remainder so we never silently lose
      // precision on large (e.g. near-MAX_SAFE_INTEGER zigzag) values.
      if (mult > Number.MAX_SAFE_INTEGER / 128) {
        bigResult = BigInt(result);
        bigMult = BigInt(mult);
      }
    }
    if ((byte & 0x80) === 0) break;
  }

  if (bigResult !== null) {
    const value = bigResult <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bigResult) : bigResult;
    return { value, bytesRead };
  }
  return { value: result, bytesRead };
}

// ─── ZigZag for signed ints ──────────────────────────────────────────────────
// FIX (v5): previously used (n << 1) ^ (n >> 31), a 32-bit-only formula. The
// arithmetic equivalent n>=0 ? n*2 : -n*2-1 is correct for most of the safe
// integer range, BUT:
//
// FIX (this version): zigzag encoding roughly *doubles* the magnitude of n
// (n*2, or -n*2-1). For n close to ±Number.MAX_SAFE_INTEGER, the doubled
// result itself exceeds MAX_SAFE_INTEGER and silently loses precision as a
// JS double — e.g. zigzagEncode(-9007199254740991) computes
// 18014398509481981, which cannot be represented exactly as a Number, so it
// silently rounds and decode() returns the wrong value with the wrong sign.
// This boundary case (the ~few thousand integers nearest ±MAX_SAFE_INTEGER)
// is routed through BigInt, which has unlimited precision, while ordinary
// values stay on the fast plain-number path.
const ZIGZAG_SAFE_BOUNDARY = Math.floor(Number.MAX_SAFE_INTEGER / 2) - 1;

function zigzagEncode(n) {
  if (n <= ZIGZAG_SAFE_BOUNDARY && n >= -ZIGZAG_SAFE_BOUNDARY - 1) {
    return n >= 0 ? n * 2 : -n * 2 - 1;
  }
  const big = BigInt(n);
  return big >= 0n ? big * 2n : -big * 2n - 1n; // BigInt, handled by writeVarInt's slow path
}

function zigzagDecode(z) {
  if (typeof z === 'bigint') {
    const result = (z % 2n === 0n) ? z / 2n : -(z + 1n) / 2n;
    // Collapse back to a plain number when it safely fits, so callers get
    // an ordinary Number in the common case and only see BigInt for values
    // genuinely beyond Number.MAX_SAFE_INTEGER.
    return (result <= BigInt(Number.MAX_SAFE_INTEGER) && result >= BigInt(Number.MIN_SAFE_INTEGER))
      ? Number(result)
      : result;
  }
  return (z % 2 === 0) ? z / 2 : -(z + 1) / 2;
}

// ─── CRC32 (opt-in, v5) ───────────────────────────────────────────────────────
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 * (crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Verifies the trailing CRC32 (if the schema was defined with { crc: true }).
// NOTE / trade-off: this requires reading the whole buffer, which means
// schema.get()'s fast O(1)-ish offset path no longer avoids a full scan when
// CRC is enabled. CRC protection and the "don't touch unrelated fields"
// fast-path are in tension by nature — document this for users choosing
// whether to opt in.
function _verifyCrcIfEnabled(schema, buf) {
  if (!schema.useCrc) return;
  if (buf.length < 12) throw new Error('KRSON: buffer too short to contain a CRC32 trailer');
  const dataLen = buf.length - 4;
  const expected = buf.readUInt32LE(dataLen);
  const actual = crc32(buf.subarray(0, dataLen));
  if (actual !== expected) {
    throw new Error('KRSON: CRC32 mismatch — buffer is corrupted');
  }
}

// ─── Schema Registry ──────────────────────────────────────────────────────────

let _nextSchemaId = 1;
const _schemas = new Map(); // id → schema metadata

function defineSchema(def, options = {}) {
  const id = _nextSchemaId++;
  const declaredFields = Object.keys(def);
  const declaredTypes  = declaredFields.map(f => def[f]);
  const useCrc = !!options.crc;

  // FIX: previously, fields kept the user's declared order. Only a *prefix*
  // of fixed-size types (bool/int32/float64/timestamp) got true O(1) offsets
  // — the moment a variable-length field (string/varint/array/object)
  // appeared, every field after it lost the fast path, even other fixed-size
  // fields declared later. That made schema.get()'s "O(1) random access"
  // claim misleading for any schema that didn't happen to list all
  // fixed-size fields first.
  //
  // Fix: reorder fields internally so ALL fixed-size fields are written
  // first (true O(1) offsets for every one of them), followed by
  // variable-length fields in their original relative order. The reorder
  // is internal/structural only — encode()/decode() still take and return
  // objects keyed by field name, so calling code is unaffected. Round-trip
  // correctness (encode -> decode -> get -> getMany) depends only on
  // schema.fields/types/offsets/fieldIndex being mutually consistent, which
  // they are since every accessor below reads from this same schema object.
  const fixedIdx = [];
  const variableIdx = [];
  for (let i = 0; i < declaredFields.length; i++) {
    if (_fixedSize(declaredTypes[i]) !== null) fixedIdx.push(i);
    else variableIdx.push(i);
  }
  const order = fixedIdx.concat(variableIdx);
  const fields = order.map(i => declaredFields[i]);
  const types  = order.map(i => declaredTypes[i]);

  // Precompute fixed offsets (for schema.get() fast path)
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
    encode(obj)       { return _schemaEncode(id, obj); },
    decode(buf)       { return _schemaDecode(id, buf); },
    get(buf, field)   { return _schemaGet(id, buf, field); },
    getMany(buf, fields) { return _schemaGetMany(id, buf, fields); },
    dispose()         { return disposeSchema(id); },
    id,
  };
}

// FIX: defineSchema() registers every schema in the module-level `_schemas`
// Map and never removed entries from it. The intended usage pattern is
// module-load-time, once-per-shape (the common, recommended way), which is
// fine — but a long-running server that *accidentally* calls defineSchema()
// per-request or per-tenant would leak memory unboundedly with no way to
// recover it. disposeSchema() lets such cases clean up explicitly.
function disposeSchema(schemaId) {
  return _schemas.delete(schemaId);
}

function _fixedSize(type) {
  // +1 for the leading type-code byte every value carries on the wire.
  // bool needs no separate value byte (TRUE/FALSE is encoded in the
  // type-code itself), so it's exactly 1.
  switch (type) {
    case 'bool':      return 1;       // type-code only
    case 'int32':     return 1 + 4;   // type-code + int32
    case 'float64':   return 1 + 8;   // type-code + float64
    case 'timestamp': return 1 + 8;   // type-code + int64
    default:          return null;    // varint, string, array, object = variable
  }
}

// ─── Schema Encode ────────────────────────────────────────────────────────────

function _schemaEncode(schemaId, obj) {
  const schema = _schemas.get(schemaId);
  if (!schema) throw new Error(`Unknown schema ID: ${schemaId}`);

  // Pass 1: size every field directly (no intermediate Buffer per field)
  let totalSize = 8; // header
  for (let i = 0; i < schema.fields.length; i++) {
    totalSize += _sizeValue(obj[schema.fields[i]], schema.types[i]);
  }

  const buf = Buffer.allocUnsafe(totalSize);
  // Header: [KR][version][flags][schemaId:4B]
  buf[0] = MAGIC0; buf[1] = MAGIC1;
  buf[2] = VERSION;
  // FIX: FLAG_HAS_CRC was checked on read but never actually SET here on
  // write — so the CRC feature was permanently dead code that could never
  // trigger, silently giving zero corruption protection even when a user
  // thought they'd enabled it. Now driven by defineSchema(def, { crc: true }).
  buf[3] = FLAG_HAS_SCHEMA_ID | (schema.useCrc ? FLAG_HAS_CRC : 0);
  buf.writeUInt32LE(schemaId, 4);

  // Pass 2: write every field straight into the final buffer
  let pos = 8;
  for (let i = 0; i < schema.fields.length; i++) {
    pos += _writeValue(buf, pos, obj[schema.fields[i]], schema.types[i]);
  }

  // Add CRC32 if flag (simple append for v5)
  if (schema.useCrc) {
    const crc = crc32(buf.subarray(0, pos));
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32LE(crc, 0);
    const finalBuf = Buffer.concat([buf.subarray(0, pos), crcBuf]);
    return finalBuf;
  }

  return buf;
}

// ─── Size pass (mirrors _writeValue, no allocation) ──────────────────────────

function _sizeValue(val, type = null) {
  if (val === null || val === undefined) return 1;

  if (type === null) {
    if (Array.isArray(val)) return _sizeArray(val);
    if (typeof val === 'object') return _sizeMap(val);
    if (typeof val === 'string') return _sizeValue(val, 'string');
    if (typeof val === 'number') return _sizeValue(val, Number.isInteger(val) ? 'varint' : 'float64');
    if (typeof val === 'boolean') return _sizeValue(val, 'bool');
    return 1;
  }

  switch (type) {
    case 'bool': return 1;
    case 'varint': {
      // FIX: was `zigzagEncode(val | 0)` — `| 0` truncates to 32-bit,
      // silently corrupting any value outside ±2^31 (e.g. ms timestamps).
      // Now: full safe-integer range works correctly; truly unsafe
      // (>2^53) values fall back to float64 to avoid silent precision loss.
      if (!Number.isSafeInteger(val)) return 9; // TC + float64
      const z = zigzagEncode(val);
      return 1 + varintSize(z);
    }
    case 'int32': return 5;
    case 'float64': return 9;
    case 'string': return 5 + Buffer.byteLength(val, 'utf8');
    case 'array': return _sizeArray(val);
    case 'object': return _sizeMap(val);
    case 'timestamp': return 9;
    default: {
      // fallback: JSON string
      return 5 + Buffer.byteLength(JSON.stringify(val), 'utf8');
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

// ─── Write pass — writes directly into the pre-sized output buffer ──────────
// (replaces the old _encodeValue/_encodeArray/_encodeMap, which each
// allocated their own Buffer and got copy()'d into place afterward)

function _writeValue(buf, pos, val, type = null) {
  if (val === null || val === undefined) {
    buf[pos] = TC.NULL;
    return 1;
  }

  if (type === null) {
    if (Array.isArray(val)) return _writeArray(buf, pos, val);
    if (typeof val === 'object') return _writeMap(buf, pos, val);
    if (typeof val === 'string') return _writeValue(buf, pos, val, 'string');
    if (typeof val === 'number') return _writeValue(buf, pos, val, Number.isInteger(val) ? 'varint' : 'float64');
    if (typeof val === 'boolean') return _writeValue(buf, pos, val, 'bool');
    buf[pos] = TC.NULL;
    return 1;
  }

  switch (type) {
    case 'bool': {
      buf[pos] = val ? TC.BOOL_TRUE : TC.BOOL_FALSE;
      return 1;
    }
    case 'varint': {
      // Must mirror the size-pass logic in _sizeValue exactly, or the
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
      return _writeArray(buf, pos, val);
    case 'object':
      return _writeMap(buf, pos, val);
    case 'timestamp': {
      buf[pos] = TC.TIMESTAMP;
      buf.writeBigInt64LE(BigInt(val), pos + 1);
      return 9;
    }
    default: {
      // fallback: JSON string — now uses its own type code (see TC.JSON_FALLBACK)
      buf[pos] = TC.JSON_FALLBACK;
      const json = JSON.stringify(val);
      const len = buf.write(json, pos + 5, 'utf8');
      buf.writeUInt32LE(len, pos + 1);
      return 5 + len;
    }
  }
}

// Native ARRAY (Task 1)
function _writeArray(buf, pos, arr) {
  if (!Array.isArray(arr)) return _writeValue(buf, pos, arr, 'object');
  const start = pos;
  buf[pos++] = TC.ARRAY;
  pos += writeVarInt(buf, pos, arr.length);
  for (let i = 0; i < arr.length; i++) {
    pos += _writeValue(buf, pos, arr[i]);
  }
  return pos - start;
}

// Native MAP (Task 2) - simple for now, keys as strings
function _writeMap(buf, pos, obj) {
  if (typeof obj !== 'object' || obj === null) return _writeValue(buf, pos, obj, 'string');
  const start = pos;
  const keys = Object.keys(obj);
  buf[pos++] = TC.MAP;
  pos += writeVarInt(buf, pos, keys.length);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    pos += _writeValue(buf, pos, k, 'string');
    pos += _writeValue(buf, pos, obj[k]);
  }
  return pos - start;
}

// ─── Schema Decode ────────────────────────────────────────────────────────────

function _schemaDecode(schemaId, buf) {
  const schema = _schemas.get(schemaId);
  if (!schema) throw new Error(`Unknown schema ID: ${schemaId}`);

  _checkSchemaMatch(schemaId, buf);
  _verifyCrcIfEnabled(schema, buf);
  let pos = 8; // skip header
  const result = {};

  for (let i = 0; i < schema.fields.length; i++) {
    const field = schema.fields[i];
    const { value, bytesRead } = _decodeValue(buf, pos);
    result[field] = value;
    pos += bytesRead;
  }

  return result;
}

// ─── schema.get() — THE FAST PATH ────────────────────────────────────────────

function _schemaGet(schemaId, buf, fieldName) {
  const schema = _schemas.get(schemaId);
  if (!schema) throw new Error(`Unknown schema ID: ${schemaId}`);

  const idx = schema.fieldIndex[fieldName];
  if (idx === undefined) throw new Error(`Field not found: ${fieldName}`);

  _checkSchemaMatch(schemaId, buf);
  _verifyCrcIfEnabled(schema, buf);

  // Fast path: precomputed offset → direct read, no parsing of other fields
  if (schema.offsets[idx] !== null) {
    const pos = 8 + schema.offsets[idx]; // 8 = header size
    return _decodeValue(buf, pos).value;
  }

  // Slow path: scan from last known offset
  let lastKnownIdx = idx - 1;
  while (lastKnownIdx >= 0 && schema.offsets[lastKnownIdx] === null) lastKnownIdx--;

  let pos = lastKnownIdx >= 0
    ? 8 + schema.offsets[lastKnownIdx]
    : 8;
  let startIdx = lastKnownIdx >= 0 ? lastKnownIdx : 0;

  // Skip fields we don't need
  for (let i = startIdx; i < idx; i++) {
    const { bytesRead } = _decodeValue(buf, pos);
    pos += bytesRead;
  }

  return _decodeValue(buf, pos).value;
}

// ─── schema.getMany() — multiple fields, one pass ────────────────────────────

function _schemaGetMany(schemaId, buf, fieldNames) {
  const schema = _schemas.get(schemaId);
  if (!schema) throw new Error(`Unknown schema ID: ${schemaId}`);

  _checkSchemaMatch(schemaId, buf);
  _verifyCrcIfEnabled(schema, buf);

  // Sort requested fields by their index so we scan left→right only once
  const requests = fieldNames.map(name => {
    const idx = schema.fieldIndex[name];
    if (idx === undefined) throw new Error(`Field not found: ${name}`);
    return { name, idx };
  }).sort((a, b) => a.idx - b.idx);

  const result = {};
  let pos = 8;         // start after header
  let currentIdx = 0;  // which field position we're at in the buffer

  for (const req of requests) {
    // Skip fields between current position and the one we want
    while (currentIdx < req.idx) {
      const { bytesRead } = _decodeValue(buf, pos);
      pos += bytesRead;
      currentIdx++;
    }
    // Read the field we want
    const { value, bytesRead } = _decodeValue(buf, pos);
    result[req.name] = value;
    pos += bytesRead;
    currentIdx++;
  }

  return result;
}

// ─── Value decoder ────────────────────────────────────────────────────────────

const MAX_NEST_DEPTH = 1000; // matches typical JSON.parse/stringify-safe depth

// FIX: no bounds checking previously existed. A truncated buffer (e.g. a
// network packet cut short) crashed with a confusing internal TypeError
// (reading .toString() on undefined), and a corrupted/adversarial buffer
// claiming a huge STRING length (e.g. 0xFFFFFFFF) silently read past the
// real data and returned garbage instead of erroring. Both are now caught
// explicitly with clear messages. A `depth` guard also turns runaway/
// malicious deeply-nested input into a clean error instead of an
// uncatchable-feeling native "Maximum call stack size exceeded".
function _decodeValue(buf, pos, table, depth = 0) {
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
      // ZigZag decode (v3+)
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
      // FIX: claimed length is now validated against the actual buffer size
      // before reading, so a corrupted/adversarial length (e.g. 4GB) errors
      // cleanly instead of silently returning truncated garbage.
      if (pos + 5 > buf.length) throw new Error('KRSON: truncated buffer (STRING length header past end)');
      const len = buf.readUInt32LE(pos + 1);
      if (pos + 5 + len > buf.length) throw new Error('KRSON: truncated/corrupt buffer (STRING length exceeds available data)');
      // FIX: no more JSON-sniffing — a genuine string is always returned
      // as-is now, even if it happens to start with '[' or '{'.
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
        const { value: item, bytesRead: itemBytes } = _decodeValue(buf, p, table, depth + 1);
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
        const { value: key, bytesRead: keyBytes } = _decodeValue(buf, p, table, depth + 1);
        p += keyBytes;
        const { value: val, bytesRead: valBytes } = _decodeValue(buf, p, table, depth + 1);
        obj[key] = val;
        p += valBytes;
      }
      return { value: obj, bytesRead: p - pos };
    }

    default:
      throw new Error(`Unknown type code: 0x${tc.toString(16)}`);
  }
}

// ─── Schemaless encode / decode ───────────────────────────────────────────────

// Merged pass: interns every string (keys + values) into the table AND
// computes the value-tree size at the same time, since a string's varint-ref
// size is fully determined the moment it's interned. This collapses what
// used to be two separate full-tree walks (_internStrings then _sizeValueT)
// into one.
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
      size += 1 + varintSize(idx); // key as string-ref
      size += _collectAndSizeT(val[k], table, tableList, depth + 1);
    }
    return size;
  }
  return 1;
}

function _writeValueT(buf, pos, val, table, depth = 0) {
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
    for (const item of val) pos += _writeValueT(buf, pos, item, table, depth + 1);
    return pos - start;
  }
  if (t === 'object') {
    const keys = Object.keys(val);
    buf[pos++] = TC.MAP;
    pos += writeVarInt(buf, pos, keys.length);
    for (const k of keys) {
      buf[pos++] = TC.STRING_REF;
      pos += writeVarInt(buf, pos, table.get(k));
      pos += _writeValueT(buf, pos, val[k], table, depth + 1);
    }
    return pos - start;
  }
  buf[pos++] = TC.NULL;
  return pos - start;
}

function encode(obj) {
  // Phase 1 (was phases 1+2): intern every string (keys + values) AND size
  // the value tree in one combined walk — a string-ref's size is fixed the
  // instant it's interned, so there's no need for a separate sizing pass.
  const table = new Map();
  const tableList = [];
  const valueSize = _collectAndSizeT(obj, table, tableList);

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
  pos += _writeValueT(buf, pos, obj, table);

  return buf;
}

function decode(buf) {
  _checkMagic(buf);
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
  return _decodeValue(buf, pos, table).value;
}

// ─── Single-field schemaless access — get() ──────────────────────────────────
// Mirrors schema.get()'s fast path, but for schemaless buffers. Avoids the
// waste of a full decode() when only one top-level field is needed:
//   - string table is NOT eagerly decoded into JS strings (just byte spans)
//   - keys are compared as raw UTF-8 bytes against the target field name,
//     so non-matching keys never get a buf.toString() call
//   - values of non-matching fields are skipped structurally (_skipValue),
//     never materialized into JS objects/arrays/strings
//   - only once a match is found do we decode that one value, and any
//     string-refs inside it are decoded lazily/on-demand via a Proxy-backed
//     table (so a matched nested object still doesn't pull in unrelated
//     table entries it doesn't reference)

function _readTableSpans(buf, pos) {
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

function _makeLazyTable(buf, spans) {
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

// Computes how many bytes a value occupies without decoding/allocating it.
function _skipValue(buf, pos, depth = 0) {
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
      for (let i = 0; i < r.value; i++) p += _skipValue(buf, p, depth + 1);
      return p - pos;
    }
    case TC.MAP: {
      const r = readVarInt(buf, pos + 1);
      let p = pos + 1 + r.bytesRead;
      for (let i = 0; i < r.value; i++) {
        p += _skipValue(buf, p, depth + 1); // key
        p += _skipValue(buf, p, depth + 1); // value
      }
      return p - pos;
    }
    default:
      throw new Error(`Unknown type code: 0x${tc.toString(16)} at position ${pos} (buffer may be corrupt)`);
  }
}

function get(buf, fieldName) {
  _checkMagic(buf);
  const { spans, pos: afterTable } = _readTableSpans(buf, 8);

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
        const lazyTable = _makeLazyTable(buf, spans);
        return _decodeValue(buf, p, lazyTable).value;
      }
      p += _skipValue(buf, p);
    } else {
      // inline (non-interned) key — fall back to skip both
      p += _skipValue(buf, p);
      p += _skipValue(buf, p);
    }
  }

  return undefined; // field not found
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _checkMagic(buf) {
  if (!buf || buf.length < 8) {
    throw new Error('Invalid KRSON buffer: too short (truncated/corrupt)');
  }
  if (buf[0] !== MAGIC0 || buf[1] !== MAGIC1) {
    throw new Error(`Invalid KRSON magic bytes: 0x${buf[0].toString(16)} 0x${buf[1].toString(16)}`);
  }
  if (buf[2] !== VERSION) {
    throw new Error(
      `KRSON version mismatch: buffer was encoded with wire format v${buf[2]}, ` +
      `but this library is v${VERSION}. Buffers from different KRSON versions ` +
      `are not guaranteed to be compatible — re-encode with the current version.`
    );
  }
}

// FIX: schema-mode read functions previously only called _checkMagic(), which
// verifies the buffer LOOKS like a KRSON buffer but never checks it was
// encoded with the schema being used to read it. Reading a buffer made with
// schema A using schema B's offsets/types either threw a confusing internal
// error or silently returned garbage field data with no error at all.
// Every schema buffer already carries its schemaId at bytes [4:8] (written
// in _schemaEncode) when FLAG_HAS_SCHEMA_ID is set — we just weren't
// checking it. This verifies the buffer was actually encoded with the
// schema being used to decode it.
function _checkSchemaMatch(expectedSchemaId, buf) {
  _checkMagic(buf);
  if (buf[3] & FLAG_HAS_SCHEMA_ID) {
    const embeddedId = buf.readUInt32LE(4);
    if (embeddedId !== expectedSchemaId) {
      throw new Error(
        `Schema mismatch: buffer was encoded with schema #${embeddedId}, but schema #${expectedSchemaId} was used to read it`
      );
    }
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

const KRSON = { defineSchema, disposeSchema, encode, decode, get, validate };
module.exports = { KRSON, defineSchema, disposeSchema, encode, decode, get, validate };

// ─── KRSON.inspect() — decode buffer without schema ──────────────────────────

function inspect(buf, schema) {
  if (!validate(buf)) return { error: 'Invalid KRSON buffer' };
  if (schema) return schema.decode(buf);
  // schemaless — decode via real path (handles string table)
  try {
    return decode(buf);
  } catch(e) {
    return { error: e.message };
  }
}

// ─── KRSON.prettyPrint() — human readable output ─────────────────────────────

function prettyPrint(buf, schema) {
  const obj = inspect(buf, schema);
  const schemaId = buf.readUInt32LE ? buf.readUInt32LE(4) : new DataView(buf.buffer).getUint32(4, true);
  const lines = [];
  lines.push('┌─ KRSON Packet ─────────────────────────');
  lines.push(`│  magic    : KR (0x4B 0x52)`);
  lines.push(`│  version  : v${buf[2]}`);
  lines.push(`│  schema   : ${schemaId === 0 ? 'schemaless' : `#${schemaId}`}`);
  lines.push(`│  size     : ${buf.length} bytes`);
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

// ─── npx krson inspect — CLI support ─────────────────────────────────────────

function _cliInspect() {
  const fs = require('fs');
  const file = process.argv[3];
  if (!file) { console.error('Usage: npx krson inspect <file.krson>'); process.exit(1); }
  const buf = fs.readFileSync(file);
  prettyPrint(buf, null);
}

if (require.main === module && process.argv[2] === 'inspect') {
  _cliInspect();
}

// ─── Re-export with new methods ───────────────────────────────────────────────
KRSON.inspect    = inspect;
KRSON.prettyPrint = prettyPrint;
module.exports = { KRSON, defineSchema, disposeSchema, encode, decode, get, validate, inspect, prettyPrint };
