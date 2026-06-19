'use strict';
const { KRSON } = require('./index.js');

const data = {
    name: 'Alice', age: 30, score: 98.5, active: true,
    tags: ['admin', 'user'],
    metadata: { ip: '192.168.1.1', country: 'IN' },
};

const schema = KRSON.defineSchema({
    name: 'string', age: 'varint', score: 'float64',
    active: 'bool', tags: 'array', metadata: 'object',
});

console.log('=== Correctness ===');
const buf = schema.encode(data);
const out = schema.decode(buf);
console.log('  name  :', out.name === 'Alice' ? '✓' : '✗', out.name);
console.log('  age   :', out.age === 30 ? '✓' : '✗', out.age);
console.log('  score :', out.score === 98.5 ? '✓' : '✗', out.score);
console.log('  active:', out.active === true ? '✓' : '✗');
console.log('  tags  :', JSON.stringify(out.tags));
console.log('  meta  :', JSON.stringify(out.metadata));
console.log('  get age:', schema.get(buf, 'age'));
console.log('  getMany:', JSON.stringify(schema.getMany(buf, ['name','age','score'])));

// JSON ↔ KRSON conversion (server compatibility)
console.log('\n=== JSON ↔ KRSON Conversion ===');
const serverJson = '{"name":"Bob","age":25,"score":77.5,"active":false,"tags":["user"],"metadata":{"ip":"10.0.0.1","country":"US"}}';

// Server JSON string → KRSON (schemaless)
const fromServerBuf = KRSON.jsonToKrson(serverJson);
const backToObj = KRSON.krsonToJson(fromServerBuf);
console.log('  jsonToKrson (string)  :', backToObj.name === 'Bob' ? '✓' : '✗', backToObj.name);

// JS object → KRSON
const fromObjBuf = KRSON.jsonToKrson(data);
const backToObj2 = KRSON.krsonToJson(fromObjBuf);
console.log('  jsonToKrson (object)  :', backToObj2.name === 'Alice' ? '✓' : '✗', backToObj2.name);

// Schema-aware JSON → KRSON (smaller, needs schema)
const schemaBuf = KRSON.jsonToKrsonSchema(schema, serverJson);
const schemaBack = KRSON.krsonToJsonSchema(schema, schemaBuf);
console.log('  jsonToKrsonSchema     :', schemaBack.name === 'Bob' ? '✓' : '✗', schemaBack.name, '(', schemaBuf.length, 'bytes)');

const N = 1_000_000;
const jsonStr = JSON.stringify(data);
const krsonBuf = schema.encode(data);

function bench(label, fn) {
    for (let i = 0; i < 1000; i++) fn();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) fn();
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6;
    console.log(`  ${label.padEnd(28)} ${ms.toFixed(0).padStart(8)}ms`);
    return ms;
}

console.log('\n=== Benchmark (1,000,000 iterations) ===\n');

console.log('ENCODE:');
const ke = bench('KRSON schema.encode()', () => schema.encode(data));
const je = bench('JSON.stringify()',      () => JSON.stringify(data));
console.log(`  → ${ke < je ? (je/ke).toFixed(1)+'x FASTER ✅' : (ke/je).toFixed(1)+'x slower'}\n`);

console.log('DECODE:');
const kd = bench('KRSON schema.decode()', () => schema.decode(krsonBuf));
const jd = bench('JSON.parse()',          () => JSON.parse(jsonStr));
console.log(`  → ${kd < jd ? (jd/kd).toFixed(1)+'x FASTER ✅' : (kd/jd).toFixed(1)+'x slower'}\n`);

console.log('SINGLE FIELD:');
const kg = bench('KRSON schema.get()',    () => schema.get(krsonBuf, 'age'));
const jg = bench('JSON.parse()+.field',   () => { const o = JSON.parse(jsonStr); void o.age; });
console.log(`  → ${kg < jg ? (jg/kg).toFixed(1)+'x FASTER ✅' : (kg/jg).toFixed(1)+'x slower'}\n`);

console.log('MULTI FIELD (3):');
const km = bench('KRSON getMany(3)',      () => schema.getMany(krsonBuf, ['name','age','score']));
const jm = bench('JSON.parse()+3fields',  () => { const o = JSON.parse(jsonStr); void o.name; void o.age; void o.score; });
console.log(`  → ${km < jm ? (jm/km).toFixed(1)+'x FASTER ✅' : (km/jm).toFixed(1)+'x slower'}\n`);

const pct = Math.round((1 - krsonBuf.length / Buffer.byteLength(jsonStr)) * 100);
console.log('PAYLOAD SIZE:');
console.log(`  JSON:  ${Buffer.byteLength(jsonStr)}B   KRSON: ${krsonBuf.length}B  (${pct}% smaller)`);
