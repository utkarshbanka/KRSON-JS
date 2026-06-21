'use strict';
/**
 * test2.js — Large-Data Field-Order & O(1) Verification Suite
 * =============================================================
 * Purpose: this file exists specifically to validate the v6 field-reorder
 * fix (fixed-size fields auto-sorted first → true O(1) offsets for ALL of
 * them, not just a declared-order prefix) at realistic/large data sizes,
 * before publishing.
 *
 * It checks three things the earlier test files don't directly cover:
 *   1. CORRECTNESS at scale — large payloads, scrambled field declaration
 *      order, deeply nested data, big string/array fields — round-trip
 *      exactly, and get()/getMany() return the right values regardless of
 *      where a field sits relative to variable-length fields.
 *   2. O(1) PROOF — a fixed-size field's access time stays flat as a
 *      neighboring variable-length field grows, while the variable field's
 *      own access time grows linearly. This is timed, not assumed.
 *   3. JSON COMPARISON — the same "field after a big string" pattern,
 *      measuring KRSON's real advantage over JSON.parse(str).field as
 *      payload size increases (KRSON's actual selling point).
 *
 * Run: node --expose-gc test2.js
 */

const { defineSchema, encode, decode, get } = require('./index.js');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(name + (extra ? ` (${extra})` : ''));
    console.log('  ✗ FAIL:', name, extra ? `— ${extra}` : '');
  }
}
function section(title) {
  console.log('\n' + '='.repeat(70));
  console.log(title);
  console.log('='.repeat(70));
}

function timeOp(fn, iterations, warmup = Math.min(1000, iterations)) {
  for (let i = 0; i < warmup; i++) fn();
  if (global.gc) global.gc();
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const end = process.hrtime.bigint();
  return Number(end - start) / 1e6; // ms
}

function randStr(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[(Math.random() * chars.length) | 0];
  return s;
}

// ─────────────────────────────────────────────────────────────────────────
section('1. CORRECTNESS AT SCALE — scrambled field order, large payloads');
// ─────────────────────────────────────────────────────────────────────────

{
  // Deliberately declare fixed and variable fields interleaved, in an order
  // that would have broken under the pre-v6 "only a declared-order prefix
  // gets offsets" behavior. The fix should make every fixed field O(1)
  // regardless of this order.
  const schema = defineSchema({
    description: 'string',   // variable
    id: 'int32',
    tags: 'array',           // variable
    score: 'float64',
    createdAt: 'timestamp',
    metadata: 'object',      // variable
    isActive: 'bool',
    notes: 'string',         // variable
    priority: 'int32',
    rating: 'float64',
    isVerified: 'bool',
  });

  const N = 20_000;
  console.log(`  Encoding ${N.toLocaleString()} records with scrambled fixed/variable field order...`);

  const records = [];
  const bufs = [];
  for (let i = 0; i < N; i++) {
    const rec = {
      description: randStr(50 + (i % 200)),
      id: i,
      tags: ['tag' + (i % 5), 'tag' + (i % 7), 'category' + (i % 3)],
      score: Math.random() * 1000,
      createdAt: Date.now() + i,
      metadata: { region: 'r' + (i % 10), source: 'test', batch: i % 100 },
      isActive: i % 2 === 0,
      notes: randStr(20 + (i % 100)),
      priority: i % 5,
      rating: Math.round(Math.random() * 500) / 100,
      isVerified: i % 3 === 0,
    };
    records.push(rec);
    bufs.push(schema.encode(rec));
  }

  // Spot-check every Nth record with full decode + get() on every field
  let allDecodeOk = true;
  let allGetOk = true;
  const step = Math.max(1, Math.floor(N / 500)); // ~500 spot checks
  for (let i = 0; i < N; i += step) {
    const rec = records[i];
    const buf = bufs[i];
    const dec = schema.decode(buf);

    if (
      dec.description !== rec.description ||
      dec.id !== rec.id ||
      JSON.stringify(dec.tags) !== JSON.stringify(rec.tags) ||
      Math.abs(dec.score - rec.score) > 1e-9 ||
      dec.createdAt !== rec.createdAt ||
      JSON.stringify(dec.metadata) !== JSON.stringify(rec.metadata) ||
      dec.isActive !== rec.isActive ||
      dec.notes !== rec.notes ||
      dec.priority !== rec.priority ||
      dec.rating !== rec.rating ||
      dec.isVerified !== rec.isVerified
    ) {
      allDecodeOk = false;
      console.log(`    decode mismatch at record ${i}`);
      break;
    }

    // get() on every field individually — this is where the offset bug
    // would surface (wrong field, wrong type, garbage value).
    if (
      schema.get(buf, 'id') !== rec.id ||
      schema.get(buf, 'score') !== rec.score ||
      schema.get(buf, 'createdAt') !== rec.createdAt ||
      schema.get(buf, 'isActive') !== rec.isActive ||
      schema.get(buf, 'priority') !== rec.priority ||
      schema.get(buf, 'rating') !== rec.rating ||
      schema.get(buf, 'isVerified') !== rec.isVerified ||
      schema.get(buf, 'description') !== rec.description ||
      schema.get(buf, 'notes') !== rec.notes
    ) {
      allGetOk = false;
      console.log(`    get() mismatch at record ${i}`);
      break;
    }
  }

  check(`full decode() correct across ${N.toLocaleString()} records (spot-checked)`, allDecodeOk);
  check(`get() correct on every field type across spot-checked records`, allGetOk);

  // getMany with a mix of fixed fields declared in scrambled order
  const sample = bufs[Math.floor(N / 2)];
  const sampleRec = records[Math.floor(N / 2)];
  const many = schema.getMany(sample, ['isVerified', 'id', 'rating', 'isActive', 'priority']);
  check('getMany() returns correct values for scrambled fixed-field request',
    many.isVerified === sampleRec.isVerified &&
    many.id === sampleRec.id &&
    many.rating === sampleRec.rating &&
    many.isActive === sampleRec.isActive &&
    many.priority === sampleRec.priority
  );
}

// ─────────────────────────────────────────────────────────────────────────
section('2. O(1) PROOF — fixed-field access time vs. neighboring data size');
// ─────────────────────────────────────────────────────────────────────────

{
  // A fixed field declared AFTER a string that we'll grow progressively.
  // After the v6 reorder fix, `flag` and `count` should be moved before
  // `bigString` internally, so their access time should stay flat no
  // matter how large bigString gets.
  function buildBuf(padSize) {
    const schema = defineSchema({
      bigString: 'string',
      flag: 'bool',
      count: 'int32',
      ratio: 'float64',
    });
    return { schema, buf: schema.encode({ bigString: 'x'.repeat(padSize), flag: true, count: 999, ratio: 4.25 }) };
  }

  const sizes = [1_000, 50_000, 500_000, 5_000_000];
  const fixedTimes = [];
  const varTimes = [];

  console.log('  pad bytes'.padEnd(14), 'bufLen'.padEnd(12), 'get(count) ms'.padEnd(16), 'get(bigString) ms');
  for (const size of sizes) {
    const { schema, buf } = buildBuf(size);
    const iterFixed = 200_000;
    const iterVar = size > 1_000_000 ? 200 : 20_000;

    const tFixed = timeOp(() => schema.get(buf, 'count'), iterFixed);
    const tVar = timeOp(() => schema.get(buf, 'bigString'), iterVar);

    fixedTimes.push(tFixed / iterFixed);
    varTimes.push(tVar / iterVar);

    console.log(
      String(size).padEnd(14),
      String(buf.length).padEnd(12),
      (tFixed / iterFixed * 1000).toFixed(3).padEnd(16) + 'µs',
      (tVar / iterVar * 1000).toFixed(3) + 'µs'
    );
  }

  // O(1) check: per-call time for the fixed field should not grow more
  // than ~5x across a 5000x increase in padding size (generous slack for
  // noise/JIT/GC; a truly O(n) access would grow ~5000x).
  const fixedGrowth = fixedTimes[fixedTimes.length - 1] / fixedTimes[0];
  const varGrowth = varTimes[varTimes.length - 1] / varTimes[0];

  console.log(`\n  Fixed-field time growth (smallest→largest pad): ${fixedGrowth.toFixed(1)}x`);
  console.log(`  Variable-field time growth (smallest→largest pad): ${varGrowth.toFixed(1)}x`);

  check('fixed-size field access time stays ~flat (O(1)) as neighboring data grows 5000x',
    fixedGrowth < 10,
    `growth was ${fixedGrowth.toFixed(1)}x, expected < 10x`);
  check('variable-size field access time grows with its own size (O(n), expected)',
    varGrowth > 50,
    `growth was ${varGrowth.toFixed(1)}x, expected > 50x to confirm it is NOT O(1)`);
}

// ─────────────────────────────────────────────────────────────────────────
section('3. KRSON vs JSON — single-field read after large leading data');
// ─────────────────────────────────────────────────────────────────────────

{
  function makeData(padSize) {
    return { junk: 'x'.repeat(padSize), wanted: 424242 };
  }
  const schema = defineSchema({ junk: 'string', wanted: 'int32' });

  const sizes = [1_000, 100_000, 1_000_000, 5_000_000];
  console.log('  pad bytes'.padEnd(12), 'JSON ms/op'.padEnd(14), 'KRSON ms/op'.padEnd(14), 'speedup');

  let lastSpeedup = 0;
  for (const size of sizes) {
    const data = makeData(size);
    const jsonStr = JSON.stringify(data);
    const buf = schema.encode(data);
    const iter = size > 1_000_000 ? 500 : 20_000;

    const tJson = timeOp(() => JSON.parse(jsonStr).wanted, iter) / iter;
    const tKrson = timeOp(() => schema.get(buf, 'wanted'), iter) / iter;

    lastSpeedup = tJson / tKrson;
    console.log(
      String(size).padEnd(12),
      (tJson * 1000).toFixed(2).padEnd(14) + 'µs',
      (tKrson * 1000).toFixed(2).padEnd(14) + 'µs',
      lastSpeedup.toFixed(1) + 'x'
    );
  }

  check('KRSON get() meaningfully outperforms JSON.parse+field at large payload size (5MB)',
    lastSpeedup > 10,
    `speedup was only ${lastSpeedup.toFixed(1)}x, expected > 10x`);
}

// ─────────────────────────────────────────────────────────────────────────
section('4. LARGE NESTED PAYLOAD — schemaless encode/decode round-trip');
// ─────────────────────────────────────────────────────────────────────────

{
  // Build a large, deeply-ish nested structure: array of order objects,
  // each with nested line items — a realistic "API response" shape.
  const N_ORDERS = 5_000;
  const orders = [];
  for (let i = 0; i < N_ORDERS; i++) {
    orders.push({
      orderId: 100000 + i,
      customer: { name: randStr(10), email: randStr(8) + '@example.com', region: 'r' + (i % 12) },
      items: Array.from({ length: 3 + (i % 4) }, (_, j) => ({
        sku: 'SKU-' + (i * 10 + j),
        qty: 1 + (j % 5),
        price: Math.round(Math.random() * 10000) / 100,
      })),
      total: Math.round(Math.random() * 100000) / 100,
      placedAt: Date.now() - i * 1000,
      tags: ['order', i % 2 === 0 ? 'priority' : 'standard'],
    });
  }
  const payload = { orders, generatedAt: Date.now(), count: orders.length };

  const jsonStr = JSON.stringify(payload);
  const krsonBuf = encode(payload);

  console.log(`  ${N_ORDERS.toLocaleString()} nested order records`);
  console.log(`  JSON size : ${jsonStr.length.toLocaleString()} bytes`);
  console.log(`  KRSON size: ${krsonBuf.length.toLocaleString()} bytes`);
  console.log(`  Reduction : ${((1 - krsonBuf.length / jsonStr.length) * 100).toFixed(1)}%`);

  const decoded = decode(krsonBuf);
  check('large nested payload count matches', decoded.orders.length === N_ORDERS);

  let nestedOk = true;
  const checkStep = Math.max(1, Math.floor(N_ORDERS / 200));
  for (let i = 0; i < N_ORDERS; i += checkStep) {
    const a = orders[i], b = decoded.orders[i];
    if (
      a.orderId !== b.orderId ||
      a.customer.name !== b.customer.name ||
      a.customer.email !== b.customer.email ||
      a.items.length !== b.items.length ||
      Math.abs(a.total - b.total) > 1e-9 ||
      a.placedAt !== b.placedAt ||
      JSON.stringify(a.tags) !== JSON.stringify(b.tags)
    ) {
      nestedOk = false;
      console.log(`    mismatch at order ${i}`);
      break;
    }
    for (let j = 0; j < a.items.length; j++) {
      if (a.items[j].sku !== b.items[j].sku || a.items[j].qty !== b.items[j].qty || Math.abs(a.items[j].price - b.items[j].price) > 1e-9) {
        nestedOk = false;
        console.log(`    line-item mismatch at order ${i}, item ${j}`);
        break;
      }
    }
    if (!nestedOk) break;
  }
  check('large nested payload round-trips correctly (spot-checked)', nestedOk);

  // get() on the schemaless top-level payload (not orders[i], just top fields)
  check('schemaless get() on large-payload top-level field', get(krsonBuf, 'count') === N_ORDERS);
}

// ─────────────────────────────────────────────────────────────────────────
section('5. 64-BIT INTEGERS AT SCALE — timestamps & big IDs across many records');
// ─────────────────────────────────────────────────────────────────────────

{
  const N = 50_000;
  const schema = defineSchema({ bigId: 'varint', ts: 'varint', label: 'string' });
  let allOk = true;
  const bigBase = Number.MAX_SAFE_INTEGER - N - 5;

  for (let i = 0; i < N; i++) {
    const rec = { bigId: bigBase + i, ts: Date.now() + i, label: 'rec' + i };
    const buf = schema.encode(rec);
    const dec = schema.decode(buf);
    if (dec.bigId !== rec.bigId || dec.ts !== rec.ts || dec.label !== rec.label) {
      allOk = false;
      console.log(`    64-bit mismatch at record ${i}: expected bigId=${rec.bigId} got ${dec.bigId}`);
      break;
    }
  }
  check(`${N.toLocaleString()} records with near-MAX_SAFE_INTEGER ids + ms timestamps round-trip exactly`, allOk);
}

// ─────────────────────────────────────────────────────────────────────────
section('6. CRC32 + SCHEMA VALIDATION UNDER LOAD');
// ─────────────────────────────────────────────────────────────────────────

{
  const N = 5_000;
  const schema = defineSchema({ id: 'int32', value: 'float64' }, { crc: true });
  let cleanOk = true, corruptCaught = 0;

  for (let i = 0; i < N; i++) {
    const buf = schema.encode({ id: i, value: i * 1.5 });
    const dec = schema.decode(buf);
    if (dec.id !== i || dec.value !== i * 1.5) { cleanOk = false; break; }

    // Corrupt ~1 in 10 buffers and confirm CRC catches it every time
    if (i % 10 === 0) {
      const corrupted = Buffer.from(buf);
      corrupted[9] ^= 0xFF;
      try {
        schema.decode(corrupted);
        // did not throw — bad
      } catch (e) {
        if (e.message.includes('CRC')) corruptCaught++;
      }
    }
  }
  check(`${N.toLocaleString()} CRC-enabled records decode cleanly when uncorrupted`, cleanOk);
  check('all corrupted buffers (1 in 10 sample) were caught by CRC32', corruptCaught === Math.ceil(N / 10));
}

// ─────────────────────────────────────────────────────────────────────────
section('SUMMARY');
// ─────────────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) {
  console.log('Failed checks:');
  for (const f of failures) console.log('  -', f);
  console.log('\n❌ NOT ready to publish — fix the above before pushing.\n');
  process.exit(1);
} else {
  console.log('✅ All large-data checks passed. Looks good to publish.\n');
  process.exit(0);
}
