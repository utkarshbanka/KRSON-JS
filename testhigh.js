const { encode, decode } = require('./index.js');

if (typeof global.gc !== 'function') {
  console.log('Run with: node --expose-gc testhigh.js');
  process.exit(1);
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(2);
}

console.log('========================================');
console.log('KRSON HIGH PERFORMANCE BENCHMARK');
console.log('========================================');

const BIG_USER = {
  id: 1,
  name: "Utkarsh",
  profile: {
    city: "Varanasi",
    country: "India"
  },

  orders: Array.from({ length: 10000 }, (_, i) => ({
    id: i,
    amount: i * 100,
    status: "PAID",
    currency: "INR"
  })),

  transactions: Array.from({ length: 10000 }, (_, i) => ({
    id: i,
    type: "CREDIT",
    amount: i * 50,
    success: true
  })),

  history: Array.from({ length: 10000 }, (_, i) => ({
    action: "LOGIN",
    ip: "192.168.1.1"
  }))
};

const BIG_N = 100;

console.log('\n=== HUGE PAYLOAD ===');

const bigJson = JSON.stringify(BIG_USER);
const krBuf = encode(BIG_USER);

// --------------------------------------------------
// ENCODE
// --------------------------------------------------

let t = Date.now();

for (let i = 0; i < BIG_N; i++) {
  encode(BIG_USER);
}

const krEncode = Date.now() - t;

t = Date.now();

for (let i = 0; i < BIG_N; i++) {
  JSON.stringify(BIG_USER);
}

const jsonEncode = Date.now() - t;

// --------------------------------------------------
// DECODE
// --------------------------------------------------

t = Date.now();

for (let i = 0; i < BIG_N; i++) {
  decode(krBuf);
}

const krDecode = Date.now() - t;

t = Date.now();

for (let i = 0; i < BIG_N; i++) {
  JSON.parse(bigJson);
}

const jsonDecode = Date.now() - t;

// --------------------------------------------------
// PAYLOAD SIZE
// --------------------------------------------------

const jsonSize = Buffer.byteLength(bigJson);
const krSize = krBuf.length;

const diffPercent =
  ((1 - (krSize / jsonSize)) * 100).toFixed(2);

// --------------------------------------------------
// VERIFY
// --------------------------------------------------

const decoded = decode(krBuf);

// --------------------------------------------------
// MEMORY STRESS
// --------------------------------------------------

console.log('\n=== MEMORY STRESS ===');

global.gc();

const before = process.memoryUsage();

const MEMORY_RECORDS = 1000;
const records = [];

for (let i = 0; i < MEMORY_RECORDS; i++) {
  records.push(encode(BIG_USER));
}

global.gc();

const after = process.memoryUsage();

const heapDelta =
  after.heapUsed - before.heapUsed;

// --------------------------------------------------
// RESULTS
// --------------------------------------------------

console.log('\nENCODE:');
console.log(
  `KRSON : ${krEncode}ms`
);
console.log(
  `JSON  : ${jsonEncode}ms`
);

if (krEncode < jsonEncode) {
  console.log(
    `RESULT: ${(jsonEncode / krEncode).toFixed(2)}x FASTER ✅`
  );
} else {
  console.log(
    `RESULT: ${(krEncode / jsonEncode).toFixed(2)}x slower`
  );
}

console.log('\nDECODE:');
console.log(
  `KRSON : ${krDecode}ms`
);
console.log(
  `JSON  : ${jsonDecode}ms`
);

if (krDecode < jsonDecode) {
  console.log(
    `RESULT: ${(jsonDecode / krDecode).toFixed(2)}x FASTER ✅`
  );
} else {
  console.log(
    `RESULT: ${(krDecode / jsonDecode).toFixed(2)}x slower`
  );
}

console.log('\nPAYLOAD SIZE:');
console.log(
  `JSON  : ${jsonSize.toLocaleString()} bytes`
);
console.log(
  `KRSON : ${krSize.toLocaleString()} bytes`
);
console.log(
  `Difference: ${diffPercent}%`
);

console.log('\nVERIFY:');
console.log(
  `Orders       : ${decoded.orders.length}`
);
console.log(
  `Transactions : ${decoded.transactions.length}`
);
console.log(
  `History      : ${decoded.history.length}`
);

console.log('\nMEMORY STRESS:');
console.log(
  `Records      : ${MEMORY_RECORDS.toLocaleString()}`
);
console.log(
  `Heap Delta   : ${mb(heapDelta)} MB`
);

console.log('\nPROCESS MEMORY:');
console.log(
  `RSS          : ${mb(after.rss)} MB`
);
console.log(
  `Heap Used    : ${mb(after.heapUsed)} MB`
);
console.log(
  `Heap Total   : ${mb(after.heapTotal)} MB`
);

console.log('\n========================================');
console.log('END OF HIGH BENCHMARK');
console.log('========================================');