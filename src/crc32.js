'use strict';

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
function verifyCrcIfEnabled(schema, buf) {
  if (!schema.useCrc) return;
  if (buf.length < 12) throw new Error('KRSON: buffer too short to contain a CRC32 trailer');
  const dataLen = buf.length - 4;
  const expected = buf.readUInt32LE(dataLen);
  const actual = crc32(buf.subarray(0, dataLen));
  if (actual !== expected) {
    throw new Error('KRSON: CRC32 mismatch — buffer is corrupted');
  }
}

module.exports = { crc32, verifyCrcIfEnabled };
