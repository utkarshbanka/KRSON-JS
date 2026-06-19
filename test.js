const { defineSchema, encode, decode, validate } = require('./index.js');

// ─── Setup schema ─────────────────────────────────────────────────────────────
const userSchema = defineSchema({
  name:   'string',
  age:    'varint',
  score:  'float64',
  active: 'bool',
  tags:   'array',
  meta:   'object',
});

const user = {
  name:   'Alice',
  age:    30,
  score:  98.5,
  active: true,
  tags:   ['admin', 'user'],
  meta:   { country: 'IN', ip: '192.168.1.1' },
};

// ─── Correctness ──────────────────────────────────────────────────────────────
console.log('=== Correctness ===');
const buf = userSchema.encode(user);
const obj = userSchema.decode(buf);

console.log('  name    :', obj.name   === 'Alice'  ? '✓ Alice'  : '✗ ' + obj.name);
console.log('  age     :', obj.age    === 30        ? '✓ 30'     : '✗ ' + obj.age);
console.log('  score   :', Math.abs(obj.score - 98.5) < 0.001 ? '✓ 98.5' : '✗ ' + obj.score);
console.log('  active  :', obj.active === true      ? '✓ true'   : '✗ ' + obj.active);
console.log('  tags    :', JSON.stringify(obj.tags));
console.log('  meta    :', JSON.stringify(obj.meta));
console.log('  get age :', userSchema.get(buf, 'age'));

// Schemaless
const sl = encode({ hello: 'world' });
const slObj = decode(sl);
console.log('  schemaless name:', slObj.hello === 'world' ? '✓' : '✗ ' + slObj.hello);

// Validate
console.log('  validate ✓    :', validate(buf));
console.log('  validate ✗    :', validate(Buffer.from([0x00, 0x00])));

// getMany
const many = userSchema.getMany(buf, ['name', 'age', 'score']);
console.log('  getMany name  :', many.name  === 'Alice' ? '✓ Alice' : '✗ ' + many.name);
console.log('  getMany age   :', many.age   === 30      ? '✓ 30'    : '✗ ' + many.age);
console.log('  getMany score :', Math.abs(many.score - 98.5) < 0.001 ? '✓ 98.5' : '✗ ' + many.score);

// ─── Benchmark ────────────────────────────────────────────────────────────────
const N = 1_000_000;
console.log(`\n=== Benchmark (${N.toLocaleString()} iterations) ===`);

const jsonStr = JSON.stringify(user);

// ENCODE
console.log('ENCODE:');

let t = Date.now();
for (let i = 0; i < N; i++) userSchema.encode(user);
const krsonEncodeMs = Date.now() - t;

t = Date.now();
for (let i = 0; i < N; i++) JSON.stringify(user);
const jsonEncodeMs = Date.now() - t;

const encodeRatio = (krsonEncodeMs / jsonEncodeMs).toFixed(1);
const encodeLabel = krsonEncodeMs < jsonEncodeMs ? `${(jsonEncodeMs/krsonEncodeMs).toFixed(1)}x FASTER ✅` : `${encodeRatio}x slower`;
console.log(`  KRSON schema.encode()  ${krsonEncodeMs}ms   ${encodeLabel}`);
console.log(`  JSON.stringify()       ${jsonEncodeMs}ms`);

// DECODE
console.log('DECODE:');

t = Date.now();
for (let i = 0; i < N; i++) userSchema.decode(buf);
const krsonDecodeMs = Date.now() - t;

t = Date.now();
for (let i = 0; i < N; i++) JSON.parse(jsonStr);
const jsonDecodeMs = Date.now() - t;

const decodeRatio = (krsonDecodeMs / jsonDecodeMs).toFixed(1);
const decodeLabel = krsonDecodeMs < jsonDecodeMs ? `${(jsonDecodeMs/krsonDecodeMs).toFixed(1)}x FASTER ✅` : `${decodeRatio}x slower`;
console.log(`  KRSON schema.decode()  ${krsonDecodeMs}ms   ${decodeLabel}`);
console.log(`  JSON.parse()           ${jsonDecodeMs}ms`);

// SINGLE FIELD — THE REAL WIN
console.log('SINGLE FIELD:');

t = Date.now();
for (let i = 0; i < N; i++) userSchema.get(buf, 'age');
const krsonGetMs = Date.now() - t;

t = Date.now();
for (let i = 0; i < N; i++) JSON.parse(jsonStr).age;
const jsonGetMs = Date.now() - t;

const getLabel = krsonGetMs < jsonGetMs
  ? `${(jsonGetMs/krsonGetMs).toFixed(1)}x FASTER ✅`
  : `${(krsonGetMs/jsonGetMs).toFixed(1)}x slower`;
console.log(`  KRSON schema.get()     ${krsonGetMs}ms   ${getLabel}`);
console.log(`  JSON.parse() + .field  ${jsonGetMs}ms`);

// PAYLOAD SIZE
console.log('PAYLOAD SIZE:');
const jsonBytes  = Buffer.byteLength(jsonStr);
const krsonBytes = buf.length;
const diff = Math.round((1 - krsonBytes / jsonBytes) * 100);
const sizeLabel = diff > 0 ? `${diff}% smaller ✅` : `${-diff}% larger`;
console.log(`  JSON:                  ${jsonBytes} bytes`);
console.log(`  KRSON schema-first:    ${krsonBytes} bytes  (${sizeLabel})`);

// MULTIPLE FIELDS — getMany benchmark
console.log('MULTIPLE FIELDS (3 fields):');

t = Date.now();
for (let i = 0; i < N; i++) userSchema.getMany(buf, ['name', 'age', 'score']);
const krsonManyMs = Date.now() - t;

t = Date.now();
for (let i = 0; i < N; i++) {
  const o = JSON.parse(jsonStr);
  const _ = { name: o.name, age: o.age, score: o.score };
}
const jsonManyMs = Date.now() - t;

const manyLabel = krsonManyMs < jsonManyMs
  ? `${(jsonManyMs/krsonManyMs).toFixed(1)}x FASTER ✅`
  : `${(krsonManyMs/jsonManyMs).toFixed(1)}x slower`;
console.log(`  KRSON schema.getMany() ${krsonManyMs}ms   ${manyLabel}`);
console.log(`  JSON.parse() + 3fields ${jsonManyMs}ms`);
