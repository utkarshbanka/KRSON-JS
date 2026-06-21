'use strict';

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
  // A genuine string AND the JSON.stringify() fallback (for values like
  // Date/Map/Set with no native type) used to share TC.STRING, with decode
  // "guessing" which one it was by sniffing the first character. A genuine
  // string starting with '[' or '{' (e.g. a log tag "[ERROR]") would
  // silently get mangled. A dedicated type code removes the ambiguity.
  JSON_FALLBACK: 0x33,
  TIMESTAMP:  0x40,
  ARRAY:      0x50,
  MAP:        0x51,
};

const MAGIC0 = 0x4B; // 'K'
const MAGIC1 = 0x52; // 'R'
// v6: schemas auto-reorder fixed-size fields first (true O(1) offsets for
// all of them) + corrected fixed-size byte counts (previous version
// under-counted the type-code byte for int32/float64/timestamp)
const VERSION = 0x06;

const FLAG_HAS_STRING_TABLE = 1 << 3;
const FLAG_HAS_SCHEMA_ID    = 1 << 4;
const FLAG_HAS_CRC          = 1 << 5; // opt-in CRC32 (v5)

// Matches typical JSON.parse/stringify-safe depth. Used both when decoding
// (to turn runaway/malicious deeply-nested input into a clean error instead
// of an uncatchable-feeling native "Maximum call stack size exceeded") and
// when encoding (to reject circular/too-deep structures the same way).
const MAX_NEST_DEPTH = 1000;

module.exports = {
  TC,
  MAGIC0,
  MAGIC1,
  VERSION,
  FLAG_HAS_STRING_TABLE,
  FLAG_HAS_SCHEMA_ID,
  FLAG_HAS_CRC,
  MAX_NEST_DEPTH,
};
