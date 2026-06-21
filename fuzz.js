'use strict';
/**
 * fuzz.js — Standalone deep fuzz runner
 * =======================================
 * Separate from test/fuzz.spec.js (which runs a fixed, fast set of fuzz
 * cases on every CI run). This script runs a much larger number of
 * randomized iterations and is meant for:
 *   - a pre-publish sanity pass on your own machine
 *   - a scheduled (e.g. nightly) CI job, not on every push
 *
 * It NEVER asserts on values (random input has no "correct" decoded
 * output) — it only asserts that the library never crashes the process,
 * never hangs, and only ever fails with a clean `Error`, never some other
 * thrown value (string, undefined, etc.) or an unbounded loop.
 *
 * Usage:
 *   node fuzz.js                 # default: 20,000 iterations per category
 *   node fuzz.js --iterations=100000
 *   node fuzz.js --seed=12345    # reproducible run
 */

const { encode, decode, get, validate, defineSchema } = require('./index.js');

// ─── tiny seedable PRNG so failures are reproducible with --seed ─────────────
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const m = args.find(a => a.startsWith(`--${name}=`));
  return m ? Number(m.split('=')[1]) : def;
};
const ITERATIONS = getArg('iterations', 20000);
const SEED = getArg('seed', Date.now() & 0xffffffff);
const rand = mulberry32(SEED);

console.log(`fuzz.js — seed=${SEED}, iterations per category=${ITERATIONS.toLocaleString()}`);
console.log('(re-run with --seed=' + SEED + ' to reproduce exactly)\n');

let crashes = 0; // anything that is NOT a clean Error throw
let cleanErrors = 0;
let successes = 0;
const crashDetails = [];

function attempt(label, fn, context) {
  try {
    fn();
    successes++;
  } catch (e) {
    if (e instanceof Error) {
      cleanErrors++;
    } else {
      crashes++;
      crashDetails.push({ label, context, thrown: e });
    }
  }
}

function randomByte() { return (rand() * 256) | 0; }

function randomBuffer(len) {
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i++) buf[i] = randomByte();
  return buf;
}

function randomValidHeaderBuffer(len) {
  const buf = randomBuffer(Math.max(len, 8));
  buf[0] = 0x4B; buf[1] = 0x52; buf[2] = 0x06;
  return buf;
}

// ─── Category 1: fully random bytes, any length ──────────────────────────────
console.log('Category 1: fully random buffers (no valid header)...');
for (let i = 0; i < ITERATIONS; i++) {
  const len = (rand() * 300) | 0;
  const buf = randomBuffer(len);
  attempt('decode(random)', () => decode(buf), { len, seedIter: i });
  attempt('get(random)', () => get(buf, 'x'), { len, seedIter: i });
  attempt('validate(random)', () => validate(buf), { len, seedIter: i });
}

// ─── Category 2: valid magic+version header, random body ─────────────────────
console.log('Category 2: valid header + random body...');
for (let i = 0; i < ITERATIONS; i++) {
  const len = 8 + ((rand() * 200) | 0);
  const buf = randomValidHeaderBuffer(len);
  attempt('decode(valid-header)', () => decode(buf), { len, seedIter: i });
  attempt('get(valid-header)', () => get(buf, 'x'), { len, seedIter: i });
}

// ─── Category 3: bit-flip corruption of real, validly-encoded buffers ────────
console.log('Category 3: bit-flipped real buffers...');
const realSeeds = [
  { name: 'Alice', age: 30, tags: ['a', 'b', 'c'], meta: { x: 1, nested: { y: 2 } } },
  { orders: Array.from({ length: 20 }, (_, i) => ({ id: i, items: [1, 2, 3] })) },
  { s: 'x'.repeat(2000), n: 123456789, f: 3.14159, b: true },
  {},
  { a: null, b: [], c: {} },
];
const realBuffers = realSeeds.map(s => Buffer.from(encode(s)));
for (let i = 0; i < ITERATIONS; i++) {
  const original = realBuffers[(rand() * realBuffers.length) | 0];
  const corrupted = Buffer.from(original);
  const numFlips = 1 + ((rand() * 3) | 0);
  for (let f = 0; f < numFlips; f++) {
    const pos = (rand() * corrupted.length) | 0;
    corrupted[pos] = randomByte();
  }
  attempt('decode(bit-flipped)', () => decode(corrupted), { seedIter: i });
}

// ─── Category 4: truncated real buffers (simulates cut-off network reads) ────
console.log('Category 4: truncated real buffers...');
for (let i = 0; i < ITERATIONS; i++) {
  const original = realBuffers[(rand() * realBuffers.length) | 0];
  const cutAt = (rand() * original.length) | 0;
  const truncated = original.subarray(0, cutAt);
  attempt('decode(truncated)', () => decode(truncated), { cutAt, seedIter: i });
}

// ─── Category 5: schema-mode fuzzing ──────────────────────────────────────────
console.log('Category 5: schema-mode fuzzing (decode/get on corrupted schema buffers)...');
const fuzzSchema = defineSchema({ id: 'int32', name: 'string', score: 'float64', active: 'bool', tags: 'array' });
const schemaBuf = Buffer.from(fuzzSchema.encode({ id: 1, name: 'x', score: 1.5, active: true, tags: [1, 2] }));
for (let i = 0; i < ITERATIONS; i++) {
  const corrupted = Buffer.from(schemaBuf);
  const pos = (rand() * corrupted.length) | 0;
  corrupted[pos] = randomByte();
  attempt('schema.decode(corrupted)', () => fuzzSchema.decode(corrupted), { seedIter: i });
  attempt('schema.get(corrupted)', () => fuzzSchema.get(corrupted, 'name'), { seedIter: i });
}

// ─── Category 6: weird-but-valid-JS encode-side inputs ───────────────────────
console.log('Category 6: unusual (but legal) JS values on the encode side...');
const weirdValues = [
  () => ({}), () => ([]), () => (null), () => (undefined),
  () => ({ a: NaN, b: Infinity, c: -Infinity }),
  () => ({ [Symbol('x')]: 1, normal: 2 }), // symbol keys are ignored by Object.keys
  () => ({ get x() { return 1; } }), // getter property
  () => Object.create(null), // no prototype
  () => ({ ['a'.repeat(10000)]: 1 }), // huge key name
  () => ({ a: new Array(10000).fill(0) }),
  () => JSON.parse('{"__proto__":{"polluted":true}}'),
];
for (let i = 0; i < ITERATIONS / 100; i++) {
  const valueFn = weirdValues[(rand() * weirdValues.length) | 0];
  attempt('encode(weird-value)', () => { const v = valueFn(); if (v !== null && v !== undefined) decode(encode(v)); }, { seedIter: i });
}

// ─── Results ──────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(70));
console.log('FUZZ RESULTS');
console.log('='.repeat(70));
console.log(`  Total attempts   : ${(successes + cleanErrors + crashes).toLocaleString()}`);
console.log(`  Succeeded        : ${successes.toLocaleString()}`);
console.log(`  Clean Error throw: ${cleanErrors.toLocaleString()}  (expected/acceptable — malformed input correctly rejected)`);
console.log(`  CRASHES          : ${crashes.toLocaleString()}  (anything thrown that was NOT a clean Error)`);

if (crashes > 0) {
  console.log('\n❌ FAIL — non-Error throws detected:\n');
  for (const c of crashDetails.slice(0, 20)) {
    console.log(`  [${c.label}] context=${JSON.stringify(c.context)} thrown=${String(c.thrown)}`);
  }
  if (crashDetails.length > 20) console.log(`  ...and ${crashDetails.length - 20} more`);
  console.log(`\nReproduce with: node fuzz.js --seed=${SEED}\n`);
  process.exit(1);
} else {
  console.log('\n✅ PASS — every failure path threw a clean Error. No crashes, no hangs.\n');
  process.exit(0);
}
