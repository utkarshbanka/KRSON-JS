const { defineSchema, encode, decode, validate } = require('./index.js');

// ============================================================================
// HELPERS
// ============================================================================

function formatMB(bytes) {
return (bytes / 1024 / 1024).toFixed(2);
}

function heap() {
if (global.gc) global.gc();
return process.memoryUsage();
}

function printResult(name, a, b) {
const label =
a < b
? `${(b / a).toFixed(1)}x FASTER ✅`
: `${(a / b).toFixed(1)}x slower`;

console.log(`  ${name.padEnd(24)} ${a}ms   ${label}`);
}

// ============================================================================
// SCHEMA
// ============================================================================

const userSchema = defineSchema({
name: 'string',
age: 'varint',
score: 'float64',
active: 'bool',
tags: 'array',
meta: 'object',
});

const user = {
name: 'Alice',
age: 30,
score: 98.5,
active: true,
tags: ['admin', 'user'],
meta: {
country: 'IN',
ip: '192.168.1.1',
},
};

// ============================================================================
// CORRECTNESS
// ============================================================================

console.log('=== Correctness ===');

const buf = userSchema.encode(user);
const obj = userSchema.decode(buf);

console.log('  name    :', obj.name === 'Alice' ? '✓ Alice' : '✗');
console.log('  age     :', obj.age === 30 ? '✓ 30' : '✗');
console.log(
'  score   :',
Math.abs(obj.score - 98.5) < 0.001 ? '✓ 98.5' : '✗'
);
console.log('  active  :', obj.active === true ? '✓ true' : '✗');
console.log('  tags    :', JSON.stringify(obj.tags));
console.log('  meta    :', JSON.stringify(obj.meta));
console.log('  get age :', userSchema.get(buf, 'age'));

const sl = encode({ hello: 'world' });
const slObj = decode(sl);

console.log(
'  schemaless:',
slObj.hello === 'world' ? '✓ world' : '✗'
);

console.log('  validate ✓ :', validate(buf));
console.log(
'  validate ✗ :',
validate(Buffer.from([0x00, 0x00]))
);

const many = userSchema.getMany(
buf,
['name', 'age', 'score']
);

console.log(
'  getMany name :',
many.name === 'Alice' ? '✓ Alice' : '✗'
);

console.log(
'  getMany age  :',
many.age === 30 ? '✓ 30' : '✗'
);

console.log(
'  getMany score:',
Math.abs(many.score - 98.5) < 0.001
? '✓ 98.5'
: '✗'
);

// ============================================================================
// BENCHMARK CONFIG
// ============================================================================

const N = 1_000_000;
const jsonStr = JSON.stringify(user);

console.log(
`\n=== Core Benchmark (${N.toLocaleString()} iterations) ===`
);

// ============================================================================
// ENCODE
// ============================================================================

console.log('\nENCODE:');

let t = Date.now();

for (let i = 0; i < N; i++) {
userSchema.encode(user);
}

const krsonEncodeMs = Date.now() - t;

t = Date.now();

for (let i = 0; i < N; i++) {
JSON.stringify(user);
}

const jsonEncodeMs = Date.now() - t;

printResult(
'KRSON encode',
krsonEncodeMs,
jsonEncodeMs
);

console.log(
`  JSON stringify          ${jsonEncodeMs}ms`
);

// ============================================================================
// DECODE
// ============================================================================

console.log('\nDECODE:');

t = Date.now();

for (let i = 0; i < N; i++) {
userSchema.decode(buf);
}

const krsonDecodeMs = Date.now() - t;

t = Date.now();

for (let i = 0; i < N; i++) {
JSON.parse(jsonStr);
}

const jsonDecodeMs = Date.now() - t;

printResult(
'KRSON decode',
krsonDecodeMs,
jsonDecodeMs
);

console.log(
`  JSON parse              ${jsonDecodeMs}ms`
);

// ============================================================================
// SINGLE FIELD
// ============================================================================

console.log('\nSINGLE FIELD ACCESS:');

t = Date.now();

for (let i = 0; i < N; i++) {
userSchema.get(buf, 'age');
}

const krsonGetMs = Date.now() - t;

t = Date.now();

for (let i = 0; i < N; i++) {
JSON.parse(jsonStr).age;
}

const jsonGetMs = Date.now() - t;

printResult(
'KRSON get(age)',
krsonGetMs,
jsonGetMs
);

console.log(
`  JSON parse + field      ${jsonGetMs}ms`
);

// ============================================================================
// MULTI FIELD
// ============================================================================

console.log('\nMULTIPLE FIELDS:');

t = Date.now();

for (let i = 0; i < N; i++) {
userSchema.getMany(
buf,
['name', 'age', 'score']
);
}

const krsonManyMs = Date.now() - t;

t = Date.now();

for (let i = 0; i < N; i++) {
const o = JSON.parse(jsonStr);

const _ = {
name: o.name,
age: o.age,
score: o.score,
};
}

const jsonManyMs = Date.now() - t;

printResult(
'KRSON getMany',
krsonManyMs,
jsonManyMs
);

console.log(
`  JSON parse + 3 fields   ${jsonManyMs}ms`
);

// ============================================================================
// PAYLOAD SIZE
// ============================================================================

console.log('\nPAYLOAD SIZE:');

const jsonBytes = Buffer.byteLength(jsonStr);
const krsonBytes = buf.length;

const diff =
Math.round(
(1 - krsonBytes / jsonBytes) * 100
);

console.log(
`  JSON                  ${jsonBytes} bytes`
);

console.log(
`  KRSON                 ${krsonBytes} bytes`
);

console.log(
`  Difference            ${diff}% smaller`
);

// ============================================================================
// READ HEAVY
// ============================================================================

console.log('\nREAD HEAVY (1 write + 100 reads):');

const OPS = 100_000;
const READS = 100;

t = Date.now();

for (let i = 0; i < OPS; i++) {
const b = userSchema.encode(user);

for (let j = 0; j < READS; j++) {
userSchema.get(b, 'age');
}
}

const krsonReadHeavyMs = Date.now() - t;

t = Date.now();

for (let i = 0; i < OPS; i++) {
const s = JSON.stringify(user);

for (let j = 0; j < READS; j++) {
JSON.parse(s).age;
}
}

const jsonReadHeavyMs = Date.now() - t;

printResult(
'KRSON read-heavy',
krsonReadHeavyMs,
jsonReadHeavyMs
);

console.log(
`  JSON read-heavy         ${jsonReadHeavyMs}ms`
);

// ============================================================================
// READ RATIO
// ============================================================================

console.log('\nREAD RATIO (1 write : 100 reads):');

const READ_RATIO = 100;
const READ_OPS = 100_000;

t = Date.now();

const krBuf = userSchema.encode(user);

for (let i = 0; i < READ_OPS; i++) {
  for (let j = 0; j < READ_RATIO; j++) {
    userSchema.get(krBuf, 'age');
  }
}

const krRatioMs = Date.now() - t;

t = Date.now();

const jsStr = JSON.stringify(user);

for (let i = 0; i < READ_OPS; i++) {
  for (let j = 0; j < READ_RATIO; j++) {
    JSON.parse(jsStr).age;
  }
}

const jsRatioMs = Date.now() - t;

printResult(
  'KRSON ratio',
  krRatioMs,
  jsRatioMs
);

console.log(
  `  JSON ratio              ${jsRatioMs}ms`
);

// ============================================================================
// ANALYTICS
// ============================================================================

console.log('\nANALYTICS (1M records):');

const RECORDS = 100_000;

const krRecords = [];
const jsRecords = [];

for (let i = 0; i < RECORDS; i++) {
const u = {
...user,
age: (i % 80) + 18,
};

krRecords.push(
userSchema.encode(u)
);

jsRecords.push(
JSON.stringify(u)
);
}

t = Date.now();

let krSum = 0;

for (const r of krRecords) {
krSum += userSchema.get(r, 'age');
}

const krAnalyticsMs = Date.now() - t;

t = Date.now();

let jsSum = 0;

for (const r of jsRecords) {
jsSum += JSON.parse(r).age;
}

const jsAnalyticsMs = Date.now() - t;

printResult(
'KRSON analytics',
krAnalyticsMs,
jsAnalyticsMs
);

console.log(
`  JSON analytics          ${jsAnalyticsMs}ms`
);

console.log(
`  avg(age)=${(krSum / RECORDS).toFixed(2)}`
);

// ============================================================================
// API GATEWAY
// ============================================================================

console.log('\nAPI GATEWAY:');

const REQUESTS = 1_000_000;

t = Date.now();

for (let i = 0; i < REQUESTS; i++) {
userSchema.getMany(
buf,
['name', 'age', 'active']
);
}

const krGatewayMs = Date.now() - t;

t = Date.now();

for (let i = 0; i < REQUESTS; i++) {
const o = JSON.parse(jsonStr);

const _ = {
name: o.name,
age: o.age,
active: o.active,
};
}

const jsGatewayMs = Date.now() - t;

printResult(
'KRSON gateway',
krGatewayMs,
jsGatewayMs
);

console.log(
`  JSON gateway            ${jsGatewayMs}ms`
);

// ============================================================================
// MEMORY TEST
// ============================================================================

console.log('\nMEMORY BENCHMARK:');

const MEM_N = 100_000;

let before = heap();

const krBuffers = [];

for (let i = 0; i < MEM_N; i++) {
krBuffers.push(
userSchema.encode(user)
);
}

let after = heap();

console.log(
`  KRSON Heap Used         ${formatMB(
    after.heapUsed - before.heapUsed
  )} MB`
);

krBuffers.length = 0;

if (global.gc) global.gc();

before = heap();

const jsBuffers = [];

for (let i = 0; i < MEM_N; i++) {
jsBuffers.push(
JSON.stringify(user)
);
}

after = heap();

console.log(
`  JSON Heap Used          ${formatMB(
    after.heapUsed - before.heapUsed
  )} MB`
);

// ============================================================================
// FINAL SCORECARD
// ============================================================================

console.log('\n==============================');
console.log('KRSON vs JSON SCORECARD');
console.log('==============================');

console.log(
`Encode        : ${
    krsonEncodeMs < jsonEncodeMs ? 'WIN' : 'LOSS'
  }`
);

console.log(
`Decode        : ${
    krsonDecodeMs < jsonDecodeMs ? 'WIN' : 'LOSS'
  }`
);

console.log(
`Single Field  : ${
    krsonGetMs < jsonGetMs ? 'WIN' : 'LOSS'
  }`
);

console.log(
`Multi Field   : ${
    krsonManyMs < jsonManyMs ? 'WIN' : 'LOSS'
  }`
);

console.log(
`Read Heavy    : ${
    krsonReadHeavyMs < jsonReadHeavyMs
      ? 'WIN'
      : 'LOSS'
  }`
);

console.log(
`Analytics     : ${
    krAnalyticsMs < jsAnalyticsMs
      ? 'WIN'
      : 'LOSS'
  }`
);

console.log(
`Gateway       : ${
    krGatewayMs < jsGatewayMs
      ? 'WIN'
      : 'LOSS'
  }`
);

console.log('==============================');
console.log(
'Run with: node --expose-gc test.js'
);
console.log('==============================');
