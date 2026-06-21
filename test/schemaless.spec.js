import { describe, it, expect } from 'vitest';
const { encode, decode, get, validate } = require('../index.js');

describe('schemaless encode/decode', () => {
  it('round-trips a flat object with mixed types', () => {
    const obj = { name: 'Alice', age: 30, score: 98.5, active: true };
    const buf = encode(obj);
    const dec = decode(buf);
    expect(dec.name).toBe('Alice');
    expect(dec.age).toBe(30);
    expect(dec.score).toBe(98.5);
    expect(dec.active).toBe(true);
  });

  it('round-trips nested arrays', () => {
    const obj = { tags: ['admin', 'user', 'editor'] };
    const dec = decode(encode(obj));
    expect(dec.tags).toEqual(['admin', 'user', 'editor']);
  });

  it('round-trips nested objects', () => {
    const obj = { meta: { country: 'IN', ip: '192.168.1.1' } };
    const dec = decode(encode(obj));
    expect(dec.meta).toEqual({ country: 'IN', ip: '192.168.1.1' });
  });

  it('round-trips deeply nested mixed structures', () => {
    const obj = {
      orders: [
        { id: 1, items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 1 }] },
        { id: 2, items: [{ sku: 'C', qty: 5 }] },
      ],
    };
    const dec = decode(encode(obj));
    expect(dec).toEqual(obj);
  });

  it('handles null and undefined values', () => {
    const obj = { a: null, b: undefined, c: 'present' };
    const dec = decode(encode(obj));
    expect(dec.a).toBeNull();
    expect(dec.c).toBe('present');
  });

  it('handles empty object and empty array', () => {
    expect(decode(encode({}))).toEqual({});
    expect(decode(encode({ arr: [] }))).toEqual({ arr: [] });
  });

  it('handles empty string', () => {
    expect(decode(encode({ s: '' })).s).toBe('');
  });

  it('handles unicode strings', () => {
    const obj = { greeting: 'नमस्ते 👋 こんにちは' };
    expect(decode(encode(obj)).greeting).toBe(obj.greeting);
  });

  it('preserves negative numbers', () => {
    const obj = { a: -1, b: -42, c: -0.5, d: -999999 };
    const dec = decode(encode(obj));
    expect(dec.a).toBe(-1);
    expect(dec.b).toBe(-42);
    expect(dec.c).toBe(-0.5);
    expect(dec.d).toBe(-999999);
  });

  it('preserves zero correctly (not confused with null)', () => {
    const dec = decode(encode({ a: 0 }));
    expect(dec.a).toBe(0);
    expect(dec.a).not.toBeNull();
  });

  it('preserves float precision for common decimal values', () => {
    const obj = { a: 3.14159, b: 0.1, c: 100.001 };
    const dec = decode(encode(obj));
    expect(dec.a).toBeCloseTo(3.14159, 9);
    expect(dec.b).toBeCloseTo(0.1, 9);
    expect(dec.c).toBeCloseTo(100.001, 9);
  });
});

describe('schemaless get()', () => {
  it('retrieves a single field without full decode', () => {
    const buf = encode({ name: 'Bob', age: 42 });
    expect(get(buf, 'age')).toBe(42);
    expect(get(buf, 'name')).toBe('Bob');
  });

  it('returns undefined for a missing field', () => {
    const buf = encode({ name: 'Bob' });
    expect(get(buf, 'doesNotExist')).toBeUndefined();
  });

  it('works correctly when the target field is declared after a large string', () => {
    const buf = encode({ junk: 'x'.repeat(10000), wanted: 777 });
    expect(get(buf, 'wanted')).toBe(777);
  });
});

describe('validate()', () => {
  it('returns true for a buffer produced by encode()', () => {
    expect(validate(encode({ a: 1 }))).toBe(true);
  });

  it('returns false for garbage input', () => {
    expect(validate(Buffer.from([1, 2, 3]))).toBe(false);
  });

  it('returns false for an empty buffer', () => {
    expect(validate(Buffer.alloc(0))).toBe(false);
  });

  it('does not throw on non-buffer input', () => {
    expect(() => validate(null)).not.toThrow();
    expect(() => validate(undefined)).not.toThrow();
    expect(() => validate('not a buffer')).not.toThrow();
  });
});
