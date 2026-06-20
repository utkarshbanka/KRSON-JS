// ============================================================================
// test1.js — REAL memory benchmark (low-noise)
//
// Why this file exists:
// test.js's memory benchmark does ONE before/after heapUsed snapshot.
// A single snapshot is noisy — V8's GC timing, string interning, and heap
// segmentation (new-space vs old-space) can make one run say "9 MB" and the
// next say "-0.00 MB" for the exact same code. That's not a real result.
//
// This file fixes that by:
//   1. Warming up the JIT before measuring (so we're not timing compilation).
//   2. Running multiple independent trials, not one.
//   3. Forcing GC immediately before AND after each trial.
//   4. Reporting median + min + max across trials, not a single number.
//   5. Keeping every result reachable (push to an array) so V8 can't dead-
//      code-eliminate the work and lie to us with an artificially low number.
//
// Run with: node --expose-gc test1.js
// (Without --expose-gc, global.gc is undefined and results are meaningless —
//  this script will refuse to run rather than print fake numbers.)
// ============================================================================

const { defineSchema, encode: krEncode } = require('./index.js');

if (typeof global.gc !== 'function') {
  console.error('ERROR: run with --expose-gc, e.g.:');
  console.error('  node --expose-gc test1.js');
  console.error('Without forced GC, heap numbers are noise, not data.');
  process.exit(1);
}

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
  meta: { country: 'IN', ip: '192.168.1.1' },
};

const N = 100_000;       // records per trial
const TRIALS = 7;        // independent measurements
const WARMUP = 20_000;    // JIT warm-up iterations, results discarded

function bytesToMB(b) {
  return b / 1024 / 1024;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function settle() {
  // Force GC twice — V8 sometimes needs two passes to fully reclaim
  // weakly-referenced / finalizer-pending objects from the previous trial.
  global.gc();
  global.gc();
}

// Runs `fn()` N times per trial, keeping all results alive in `out` so the
// engine can't optimize the work away. Returns the retained-heap delta
// for that trial, in bytes.
function measureTrial(fn, n) {
  const out = new Array(n);
  settle();
  const before = process.memoryUsage().heapUsed;

  for (let i = 0; i < n; i++) {
    out[i] = fn();
  }

  settle();
  const after = process.memoryUsage().heapUsed;

  // Sanity: keep a reference to `out` until after the measurement so it's
  // never collected mid-loop, then explicitly drop it before next trial.
  const size = out.length; // touch it so it's not "unused" to any tooling
  out.length = 0;

  return after - before;
}

function runBenchmark(label, fn, n) {
  console.log(`\n${label}`);
  console.log('  warming up...');
  for (let i = 0; i < WARMUP; i++) fn();
  settle();

  const deltas = [];
  for (let t = 0; t < TRIALS; t++) {
    const d = measureTrial(fn, n);
    deltas.push(d);
    console.log(`  trial ${t + 1}/${TRIALS}: ${bytesToMB(d).toFixed(3)} MB for ${n.toLocaleString()} records`);
  }

  const med = median(deltas);
  const min = Math.min(...deltas);
  const max = Math.max(...deltas);
  const perRecord = med / n;

  console.log(`  ── median: ${bytesToMB(med).toFixed(3)} MB | min: ${bytesToMB(min).toFixed(3)} MB | max: ${bytesToMB(max).toFixed(3)} MB`);
  console.log(`  ── ~${perRecord.toFixed(1)} bytes/record (median)`);

  return { label, deltas, median: med, min, max, perRecord };
}

console.log('='.repeat(70));
console.log(`MEMORY BENCHMARK (real) — ${TRIALS} trials × ${N.toLocaleString()} records, --expose-gc forced`);
console.log('='.repeat(70));

const resKrSchema = runBenchmark(
  'KRSON schema-mode encode  (userSchema.encode)',
  () => userSchema.encode(user),
  N
);

const resKrSchemaless = runBenchmark(
  'KRSON schemaless encode   (encode)',
  () => krEncode(user),
  N
);

const resJson = runBenchmark(
  'JSON.stringify',
  () => JSON.stringify(user),
  N
);

console.log('\n' + '='.repeat(70));
console.log('SUMMARY (median heap delta per run, lower is better)');
console.log('='.repeat(70));

const rows = [resKrSchema, resKrSchemaless, resJson];
const widest = Math.max(...rows.map(r => r.label.length));
for (const r of rows) {
  console.log(
    `  ${r.label.padEnd(widest)}  ${bytesToMB(r.median).toFixed(3).padStart(8)} MB  (${r.perRecord.toFixed(1)} B/record)`
  );
}

console.log('\nNote: actual encoded sizes (from earlier benchmark) are ~95-119 bytes/record,');
console.log('so per-record heap numbers above include retained array-slot + V8 object overhead,');
console.log('not just the raw payload bytes. That overhead is expected and identical in kind');
console.log('for both libraries — what matters is the relative comparison, not the absolute number.');
console.log('='.repeat(70));
