import { describe, it, expect } from 'vitest';
const { encode, decode, defineSchema } = require('../index.js');

describe('64-bit / large integer support', () => {
  it('round-trips a millisecond timestamp beyond 32-bit range (schemaless)', () => {
    const bigTimestamp = 1781984801656;
    const dec = decode(encode({ ts: bigTimestamp }));
    expect(dec.ts).toBe(bigTimestamp);
  });

  it('round-trips Number.MAX_SAFE_INTEGER (schemaless)', () => {
    const dec = decode(encode({ id: Number.MAX_SAFE_INTEGER }));
    expect(dec.id).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('round-trips a large negative integer (schemaless)', () => {
    const dec = decode(encode({ n: -9007199254740991 }));
    expect(dec.n).toBe(-9007199254740991);
  });

  it('round-trips large integers in schema "varint" fields', () => {
    const schema = defineSchema({ bigId: 'varint', ts: 'varint' });
    const obj = { bigId: Number.MAX_SAFE_INTEGER, ts: 1781984801656 };
    const dec = schema.decode(schema.encode(obj));
    expect(dec.bigId).toBe(obj.bigId);
    expect(dec.ts).toBe(obj.ts);
  });

  it('round-trips many distinct large values without cross-contamination', () => {
    const schema = defineSchema({ a: 'varint', b: 'varint', c: 'varint' });
    const base = Number.MAX_SAFE_INTEGER - 10;
    for (let i = 0; i < 20; i++) {
      const obj = { a: base + i, b: base - i, c: i };
      const dec = schema.decode(schema.encode(obj));
      expect(dec).toEqual(obj);
    }
  });

  it('still encodes small integers efficiently (fast path, no BigInt overhead)', () => {
    const dec = decode(encode({ a: 1, b: -1, c: 0, d: 1000000 }));
    expect(dec).toEqual({ a: 1, b: -1, c: 0, d: 1000000 });
  });
});

describe('NaN / Infinity handling', () => {
  it('round-trips NaN, Infinity, and -Infinity', () => {
    const dec = decode(encode({ a: NaN, b: Infinity, c: -Infinity }));
    expect(Number.isNaN(dec.a)).toBe(true);
    expect(dec.b).toBe(Infinity);
    expect(dec.c).toBe(-Infinity);
  });
});
