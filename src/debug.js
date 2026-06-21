'use strict';

const { validate } = require('./validate');

function inspect(buf, schema, decode) {
  if (!validate(buf)) return { error: 'Invalid KRSON buffer' };
  if (schema) return schema.decode(buf);
  // schemaless — decode via real path (handles string table)
  try {
    return decode(buf);
  } catch (e) {
    return { error: e.message };
  }
}

function prettyPrint(buf, schema, decode) {
  const obj = inspect(buf, schema, decode);
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

module.exports = { inspect, prettyPrint };
