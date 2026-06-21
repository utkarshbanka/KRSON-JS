import { describe, it, expect } from 'vitest';
const { defineSchema, disposeSchema } = require('../index.js');

describe('schema mode: basic encode/decode', () => {
  it('round-trips all field types', () => {
    const schema = defineSchema({
      name: 'string', age: 'varint', score: 'float64',
      active: 'bool', joined: 'timestamp', id: 'int32',
    });
    const obj = { name: 'Alice', age: 30, score: 98.5, active: true, joined: 1700000000000, id: 12345 };
    const buf = schema.encode(obj);
    const dec = schema.decode(buf);
    expect(dec).toEqual(obj);
  });

  it('round-trips array and object field types', () => {
    const schema = defineSchema({ tags: 'array', meta: 'object' });
    const obj = { tags: ['a', 'b', 'c'], meta: { x: 1, y: 2 } };
    const dec = schema.decode(schema.encode(obj));
    expect(dec).toEqual(obj);
  });
});

describe('schema mode: get() / getMany()', () => {
  const schema = defineSchema({
    name: 'string', age: 'varint', score: 'float64', active: 'bool',
  });
  const obj = { name: 'Alice', age: 30, score: 98.5, active: true };
  const buf = schema.encode(obj);

  it('get() returns the correct value for every field', () => {
    expect(schema.get(buf, 'name')).toBe('Alice');
    expect(schema.get(buf, 'age')).toBe(30);
    expect(schema.get(buf, 'score')).toBe(98.5);
    expect(schema.get(buf, 'active')).toBe(true);
  });

  it('get() throws for an unknown field name', () => {
    expect(() => schema.get(buf, 'nope')).toThrow(/Field not found/);
  });

  it('getMany() returns correct values for a subset of fields, any order', () => {
    const many = schema.getMany(buf, ['score', 'name', 'active']);
    expect(many).toEqual({ score: 98.5, name: 'Alice', active: true });
  });
});

describe('schema mode: field auto-reorder (v6 fix)', () => {
  // Fixed-size fields (bool/int32/float64/timestamp) are stored before
  // variable-length fields (string/varint/array/object) internally,
  // regardless of declaration order, so all of them get true O(1) offsets.
  it('correctly round-trips when variable fields are declared before fixed fields', () => {
    const schema = defineSchema({
      description: 'string',
      id: 'int32',
      tags: 'array',
      score: 'float64',
      createdAt: 'timestamp',
      metadata: 'object',
      isActive: 'bool',
    });
    const obj = {
      description: 'a product description',
      id: 42,
      tags: ['x', 'y'],
      score: 9.99,
      createdAt: 1700000000000,
      metadata: { region: 'in' },
      isActive: true,
    };
    const dec = schema.decode(schema.encode(obj));
    expect(dec).toEqual(obj);
  });

  it('get() is correct on every fixed field regardless of declared position', () => {
    const schema = defineSchema({
      bigString: 'string',
      flagA: 'bool',
      numB: 'int32',
      notes: 'string',
      ratioC: 'float64',
      whenD: 'timestamp',
      flagLast: 'bool', // declared LAST, after multiple variable fields
    });
    const obj = {
      bigString: 'x'.repeat(500),
      flagA: true,
      numB: 777,
      notes: 'some notes here',
      ratioC: 9.99,
      whenD: 1700000000000,
      flagLast: true,
    };
    const buf = schema.encode(obj);
    expect(schema.get(buf, 'flagA')).toBe(true);
    expect(schema.get(buf, 'numB')).toBe(777);
    expect(schema.get(buf, 'ratioC')).toBe(9.99);
    expect(schema.get(buf, 'whenD')).toBe(1700000000000);
    expect(schema.get(buf, 'flagLast')).toBe(true);
    expect(schema.get(buf, 'bigString')).toBe(obj.bigString);
    expect(schema.get(buf, 'notes')).toBe(obj.notes);
  });

  it('correctly handles a schema with multiple fixed-size fields back to back (offset-math regression check)', () => {
    // Regression test for the byte-count bug where int32/float64/timestamp
    // were under-counted by 1 byte (missing the type-code byte), which
    // corrupted offsets for any 2nd+ fixed field.
    const schema = defineSchema({ a: 'bool', b: 'int32', c: 'float64', d: 'timestamp', e: 'bool' });
    const obj = { a: true, b: 7, c: 3.14, d: 1000, e: false };
    const buf = schema.encode(obj);
    expect(schema.get(buf, 'a')).toBe(true);
    expect(schema.get(buf, 'b')).toBe(7);
    expect(schema.get(buf, 'c')).toBe(3.14);
    expect(schema.get(buf, 'd')).toBe(1000);
    expect(schema.get(buf, 'e')).toBe(false);
  });
});

describe('schema mode: schema-ID mismatch protection', () => {
  it('throws when reading a buffer with the wrong schema', () => {
    const schemaA = defineSchema({ age: 'int32' });
    const schemaB = defineSchema({ price: 'float64' });
    const bufA = schemaA.encode({ age: 30 });
    expect(() => schemaB.get(bufA, 'price')).toThrow(/Schema mismatch/);
    expect(() => schemaB.decode(bufA)).toThrow(/Schema mismatch/);
  });
});

describe('schema mode: CRC32 (opt-in)', () => {
  it('decodes cleanly when uncorrupted', () => {
    const schema = defineSchema({ age: 'int32' }, { crc: true });
    const buf = schema.encode({ age: 5 });
    expect(schema.decode(buf).age).toBe(5);
  });

  it('detects single-byte corruption', () => {
    const schema = defineSchema({ age: 'int32', name: 'string' }, { crc: true });
    const buf = schema.encode({ age: 30, name: 'Alice' });
    const corrupted = Buffer.from(buf);
    corrupted[9] ^= 0xFF;
    expect(() => schema.decode(corrupted)).toThrow(/CRC/);
  });

  it('does not add CRC overhead when not requested', () => {
    const withCrc = defineSchema({ age: 'int32' }, { crc: true });
    const withoutCrc = defineSchema({ age: 'int32' });
    const bufWith = withCrc.encode({ age: 5 });
    const bufWithout = withoutCrc.encode({ age: 5 });
    expect(bufWith.length).toBe(bufWithout.length + 4);
  });
});

describe('schema mode: disposeSchema (memory leak fix)', () => {
  it('removes a schema so it can no longer be used', () => {
    const schema = defineSchema({ a: 'int32' });
    const buf = schema.encode({ a: 1 });
    expect(schema.decode(buf).a).toBe(1);
    schema.dispose();
    expect(() => schema.decode(buf)).toThrow(/Unknown schema/);
  });

  it('disposeSchema() works by id directly', () => {
    const schema = defineSchema({ a: 'int32' });
    expect(disposeSchema(schema.id)).toBe(true);
    expect(disposeSchema(999999)).toBe(false); // already-gone / never-existed id
  });
});
