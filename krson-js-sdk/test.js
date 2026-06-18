'use strict';
const { KRSON } = require('./wrapper.js');

const data = {
  name:     'Alice',
  age:      30,
  score:    98.5,
  active:   true,
  tags:     ['admin', 'user'],
  metadata: { ip: '192.168.1.1', country: 'IN' },
};

// ─── Define schema once ───────────────────────────────────────
const schema = KRSON.defineSchema({
  name:     'string',
  age:      'varint',   // 1 byte for age < 64!
  score:    'float64',
  active:   'bool',
  tags:     'array',
  metadata: 'object',
});

// ─── Correctness ──────────────────────────────────────────────
console.log('=== Correctness ===');

const buf = schema.encode(data);
const out = schema.decode(buf);
console.log('  name    :', out.name     === 'Alice'             ? '✓' : '✗', out.name);
console.log('  age     :', out.age      === 30                  ? '✓' : '✗', out.age);
console.log('  score   :', out.score    === 98.5                ? '✓' : '✗', out.score);
console.log('  active  :', out.active   === true                ? '✓' : '✗', out.active);
console.log('  tags    :', JSON.stringify(out.tags));
console.log('  metadata:', JSON.stringify(out.metadata));
console.log('  get age :', schema.get(buf, 'age'));

const schemaless_buf = KRSON.encode(data);
const schemaless_out = KRSON.decode(schemaless_buf);
console.log('  schemaless name:', schemaless_out.name === 'Alice' ? '✓' : '✗');
console.log('  validate ✓    :', KRSON.validate(buf));
console.log('  validate ✗    :', KRSON.validate(Buffer.from([1,2,3])));

// ─── Benchmarks ───────────────────────────────────────────────
console.log('\n=== Benchmark (1,000,000 iterations) ===\n');

const N        = 1_000_000;
const jsonStr  = JSON.stringify(data);
const krsonBuf = schema.encode(data);
const schView  = schema;

let t0, t1;
function ms(t0, t1) { return (Number(t1 - t0) / 1e6).toFixed(2) + 'ms'; }

// ENCODE
t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) schema.encode(data);
t1 = process.hrtime.bigint();
const krson_enc = ms(t0, t1);

t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) JSON.stringify(data);
t1 = process.hrtime.bigint();
const json_enc = ms(t0, t1);

// DECODE
t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) schema.decode(krsonBuf);
t1 = process.hrtime.bigint();
const krson_dec = ms(t0, t1);

t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) JSON.parse(jsonStr);
t1 = process.hrtime.bigint();
const json_dec = ms(t0, t1);

// GET SINGLE FIELD
t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) schema.get(krsonBuf, 'age');
t1 = process.hrtime.bigint();
const krson_get = ms(t0, t1);

t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) { const o = JSON.parse(jsonStr); void o.age; }
t1 = process.hrtime.bigint();
const json_get = ms(t0, t1);

// SCHEMALESS
t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) KRSON.encode(data);
t1 = process.hrtime.bigint();
const krson_sl_enc = ms(t0, t1);

t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) KRSON.decode(schemaless_buf);
t1 = process.hrtime.bigint();
const krson_sl_dec = ms(t0, t1);

// ─── Results ──────────────────────────────────────────────────
function speedup(krson, json) {
  const k = parseFloat(krson); const j = parseFloat(json);
  const ratio = j / k;
  return ratio >= 1
    ? `${ratio.toFixed(1)}x FASTER ✅`
    : `${(k/j).toFixed(1)}x slower`;
}

console.log('ENCODE:');
console.log(`  KRSON schema.encode()   ${krson_enc.padStart(10)}   ${speedup(krson_enc, json_enc)}`);
console.log(`  JSON.stringify()        ${json_enc.padStart(10)}`);
console.log(`  KRSON schemaless        ${krson_sl_enc.padStart(10)}`);
console.log('');
console.log('DECODE:');
console.log(`  KRSON schema.decode()   ${krson_dec.padStart(10)}   ${speedup(krson_dec, json_dec)}`);
console.log(`  JSON.parse()            ${json_dec.padStart(10)}`);
console.log(`  KRSON schemaless        ${krson_sl_dec.padStart(10)}`);
console.log('');
console.log('SINGLE FIELD:');
console.log(`  KRSON schema.get()      ${krson_get.padStart(10)}   ${speedup(krson_get, json_get)}`);
console.log(`  JSON.parse() + .field   ${json_get.padStart(10)}`);
console.log('');

// PAYLOAD SIZE
const json_size  = Buffer.byteLength(jsonStr);
const krson_size = krsonBuf.length;
const sl_size    = schemaless_buf.length;
const pct_schema = Math.round((1 - krson_size / json_size) * 100);
const pct_sl     = Math.round((1 - sl_size    / json_size) * 100);
console.log('PAYLOAD SIZE:');
console.log(`  JSON:                   ${json_size} bytes`);
console.log(`  KRSON schema-first:     ${krson_size} bytes  (${pct_schema > 0 ? pct_schema+'% smaller ✅' : Math.abs(pct_schema)+'% larger'})`);
console.log(`  KRSON schemaless:       ${sl_size} bytes  (${pct_sl > 0 ? pct_sl+'% smaller ✅' : Math.abs(pct_sl)+'% larger'})`);
