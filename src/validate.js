'use strict';

const { MAGIC0, MAGIC1, VERSION, FLAG_HAS_SCHEMA_ID } = require('./constants');

function checkMagic(buf) {
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

// Schema-mode read functions previously only called checkMagic(), which
// verifies the buffer LOOKS like a KRSON buffer but never checked it was
// encoded with the schema being used to read it. Reading a buffer made with
// schema A using schema B's offsets/types either threw a confusing internal
// error or silently returned garbage field data with no error at all. Every
// schema buffer already carries its schemaId at bytes [4:8] (written in
// schemaEncode) when FLAG_HAS_SCHEMA_ID is set — this verifies it matches.
function checkSchemaMatch(expectedSchemaId, buf) {
  checkMagic(buf);
  if (buf[3] & FLAG_HAS_SCHEMA_ID) {
    const embeddedId = buf.readUInt32LE(4);
    if (embeddedId !== expectedSchemaId) {
      throw new Error(
        `Schema mismatch: buffer was encoded with schema #${embeddedId}, but schema #${expectedSchemaId} was used to read it`
      );
    }
  }
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

module.exports = { checkMagic, checkSchemaMatch, validate };
