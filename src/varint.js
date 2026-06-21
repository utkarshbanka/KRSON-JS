'use strict';

// ─── VarInt ───────────────────────────────────────────────────────────────────
// Uses plain arithmetic (*, /, %) rather than bitwise operators, which JS
// forces to 32-bit signed integers regardless of the actual value's
// magnitude — any value outside the ±2^31 range (e.g. ms timestamps, DB
// auto-increment IDs) would otherwise silently wrap to a wrong, often
// negative number with no error. Plain arithmetic is correct for the full
// safe-integer range (±2^53) since it never goes through a 32-bit coercion.
// `value` passed in here is always >= 0 (zigzag-encoded before this point).

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
// Zigzag encoding roughly *doubles* the magnitude of n (n*2, or -n*2-1). For
// n close to ±Number.MAX_SAFE_INTEGER, the doubled result itself exceeds
// MAX_SAFE_INTEGER and would silently lose precision as a JS double — e.g.
// zigzagEncode(-9007199254740991) computes 18014398509481981, which cannot
// be represented exactly as a Number, so it would silently round and
// decode() would return the wrong value with the wrong sign. This boundary
// case (the few thousand integers nearest ±MAX_SAFE_INTEGER) is routed
// through BigInt, which has unlimited precision, while ordinary values stay
// on the fast plain-number path.
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

module.exports = {
  writeVarInt,
  varintSize,
  readVarInt,
  zigzagEncode,
  zigzagDecode,
};
