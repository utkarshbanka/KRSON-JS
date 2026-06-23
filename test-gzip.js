'use strict';
/**
 * test-gzip.js — KRSON vs JSON, raw AND gzip-compressed, across dataset shapes
 * ================================================================================
 * Run: node test-gzip.js
 *
 * Why this exists: gzip closes (and sometimes reverses) KRSON's raw size
 * advantage over JSON, because gzip's DEFLATE algorithm is very good at
 * compressing repeated TEXT patterns (key names, repeated string values) —
 * exactly the redundancy KRSON already removes via string-interning before
 * gzip even sees the bytes. So there's less left for gzip to squeeze out of
 * a KRSON buffer than out of raw JSON text.
 *
 * The result depends heavily on the SHAPE of the data:
 *   - Text/string-heavy data (names, emails, repeated categories): gzip is
 *     very effective on JSON's repeated text, sometimes enough to beat
 *     KRSON's raw binary size even after KRSON is also gzipped.
 *   - Numeric-heavy data (timestamps, floats, sensor readings, IDs, GPS
 *     coordinates): JSON still stores these as decimal-text digit strings,
 *     which gzip compresses far less efficiently than KRSON's binary
 *     varint/float64 encoding. KRSON tends to win here even after gzip.
 *
 * This script measures both regimes directly so you can see where the
 * crossover is for data shapes similar to your own.
 */

const zlib = require('zlib');
const { encode } = require('./index.js');

function fmt(n) {
  return n.toLocaleString().padStart(10);
}

function pct(a, b) {
  // how much smaller b is than a, as a percentage
  return ((1 - b / a) * 100).toFixed(1) + '%';
}

function compare(label, payload) {
  const jsonStr = JSON.stringify(payload);
  const jsonBuf = Buffer.from(jsonStr, 'utf8');
  const krsonBuf = encode(payload);

  const jsonGz = zlib.gzipSync(jsonBuf);
  const krsonGz = zlib.gzipSync(krsonBuf);

  console.log(`\n=== ${label} ===`);
  console.log('                  raw bytes      gzip bytes');
  console.log('JSON         ' + fmt(jsonBuf.length) + '     ' + fmt(jsonGz.length));
  console.log('KRSON        ' + fmt(krsonBuf.length) + '     ' + fmt(krsonGz.length));
  console.log('');
  console.log('Raw:    KRSON is ' + pct(jsonBuf.length, krsonBuf.length) + ' smaller than JSON');

  const gzipDiff = krsonGz.length < jsonGz.length
    ? 'KRSON is ' + pct(jsonGz.length, krsonGz.length) + ' smaller'
    : 'JSON is ' + pct(krsonGz.length, jsonGz.length) + ' smaller';
  console.log('Gzip:   ' + gzipDiff + ' than the other, after both are gzipped');

  const winner = krsonGz.length < jsonGz.length ? '✅ KRSON wins after gzip' : '⚠️  JSON wins after gzip';
  console.log(winner);
}

function randomString(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[(Math.random() * chars.length) | 0];
  return s;
}

const N = 5000; // adjust this for a bigger/smaller dataset

console.log(`KRSON vs JSON — raw size AND gzip-compressed size, ${N.toLocaleString()} records per dataset\n`);
console.log('(Run with: node test-gzip.js   — no dependencies beyond what krson-js already needs)');

// ── Dataset 1: text-heavy — names, emails, repeated categories ───────────────
{
  const records = [];
  for (let i = 0; i < N; i++) {
    records.push({
      id: i,
      name: 'User' + i,
      email: 'user' + i + '@example.com',
      country: ['IN', 'US', 'UK', 'DE'][i % 4],
      active: i % 2 === 0,
    });
  }
  compare('Dataset 1: TEXT-HEAVY (user records — names, emails, repeated categories)', { records });
}

// ── Dataset 2a: numeric-heavy, ROUNDED floats (e.g. prices, percentages) ─────
{
  const records = [];
  let ts = 1700000000000;
  for (let i = 0; i < N; i++) {
    ts += 1000;
    records.push({
      ts,
      temp: Math.round((20 + Math.random() * 10) * 100) / 100,
      humidity: Math.round((40 + Math.random() * 20) * 100) / 100,
      pressure: Math.round((1000 + Math.random() * 50) * 100) / 100,
      lat: Math.round((12.97 + Math.random()) * 1e6) / 1e6,
      lng: Math.round((77.59 + Math.random()) * 1e6) / 1e6,
    });
  }
  compare('Dataset 2a: NUMERIC, ROUNDED (2-6 decimal places — e.g. prices, percentages, rounded sensor readings)', { records });
}

// ── Dataset 2b: numeric-heavy, FULL-PRECISION floats (raw sensor/scientific) ─
{
  const records = [];
  let ts = 1700000000000;
  for (let i = 0; i < N; i++) {
    ts += 1000;
    records.push({
      ts,
      temp: 20 + Math.random() * 10,       // full float64 precision, unrounded
      humidity: 40 + Math.random() * 20,
      pressure: 1000 + Math.random() * 50,
      lat: 12.97 + Math.random(),
      lng: 77.59 + Math.random(),
    });
  }
  compare('Dataset 2b: NUMERIC, FULL PRECISION (unrounded — raw sensor/scientific/calculated values)', { records });
  console.log('   ^ Note: rounded vs full-precision floats can FLIP the gzip winner — JSON\'s short');
  console.log('     decimal text (e.g. "23.85") compresses well; long unrounded text (e.g.');
  console.log('     "23.847291038472651") does not, while KRSON\'s fixed 8-byte float64 stays the same size either way.');
}

// ── Dataset 3: mixed — a realistic API response shape ────────────────────────
{
  const records = [];
  for (let i = 0; i < N; i++) {
    records.push({
      orderId: 100000 + i,
      customerName: 'Customer ' + (i % 500), // some repetition, some not
      total: Math.round(Math.random() * 100000) / 100,
      placedAt: 1700000000000 + i * 5000,
      status: ['pending', 'shipped', 'delivered', 'cancelled'][i % 4],
    });
  }
  compare('Dataset 3: MIXED (e-commerce orders — some repeated text, some unique numbers)', { records });
}

// ── Dataset 4: free-text-ish — low redundancy, harder for gzip ───────────────
{
  const records = [];
  for (let i = 0; i < N; i++) {
    records.push({
      id: i,
      note: randomString(40), // random, not repeated — gzip can't find patterns
      score: Math.random() * 100,
    });
  }
  compare('Dataset 4: LOW-REDUNDANCY TEXT (random strings — worst case for gzip on either format)', { records });
}

console.log('\n' + '='.repeat(70));
console.log('Takeaway: compare "Raw" and "Gzip" lines above for the dataset shape');
console.log('closest to your real data. Gzip narrows or reverses KRSON\'s raw-size');
console.log('lead on text-heavy data; KRSON tends to keep its lead on numeric-heavy');
console.log('data even after both sides are gzipped.');
console.log('='.repeat(70));
