import { describe, it, expect } from 'vitest';
const { encode, decode, get, validate, defineSchema } = require('../index.js');

// ─────────────────────────────────────────────────────────────────────────
// Structured malformed-input cases — specific, hand-crafted buffers that
// target known risk areas (truncation, oversized length claims, unknown
// type codes, wrong magic, etc). These are the "known dangerous shapes"
// for a binary parser.
// ─────────────────────────────────────────────────────────────────────────

describe('malformed input: structured edge cases', () => {
  it('rejects an empty buffer instead of crashing', () => {
    expect(() => decode(Buffer.alloc(0))).toThrow();
    expect(validate(Buffer.alloc(0))).toBe(false);
  });

  it('rejects a buffer shorter than the header', () => {
    expect(() => decode(Buffer.from([0x4B, 0x52, 0x06]))).toThrow();
  });

  it('rejects wrong magic bytes with a clear error, not a crash', () => {
    expect(() => decode(Buffer.from([0x00, 0x00, 0x06, 0, 0, 0, 0, 0]))).toThrow(/magic/i);
  });

  it('rejects a buffer from a different wire-format version', () => {
    const buf = Buffer.from(encode({ a: 1 }));
    buf[2] = 0x05; // pretend it's an old v5 buffer
    expect(() => decode(buf)).toThrow(/version/i);
  });

  it('rejects a STRING field that claims a length far exceeding the buffer', () => {
    const buf = Buffer.alloc(20);
    buf[0] = 0x4B; buf[1] = 0x52; buf[2] = 0x06; buf[3] = 0;
    buf[8] = 0x30; // TC.STRING
    buf.writeUInt32LE(0xFFFFFFFF, 9); // claims a 4GB string in a 20-byte buffer
    expect(() => decode(buf)).toThrow();
  });

  it('rejects an ARRAY that claims more elements than the buffer could hold', () => {
    const buf = Buffer.alloc(15);
    buf[0] = 0x4B; buf[1] = 0x52; buf[2] = 0x06; buf[3] = 0;
    buf[8] = 0x50; // TC.ARRAY
    buf[9] = 0xFF; buf[10] = 0xFF; buf[11] = 0xFF; buf[12] = 0xFF; buf[13] = 0x0F;
    expect(() => decode(buf)).toThrow();
  });

  it('rejects an unknown type code with a clear error', () => {
    const buf = Buffer.alloc(10);
    buf[0] = 0x4B; buf[1] = 0x52; buf[2] = 0x06; buf[3] = 0;
    buf[8] = 0xEE; // not a real type code
    expect(() => decode(buf)).toThrow(/type code/i);
  });

  it('get() on a non-object top-level value fails clearly instead of returning garbage', () => {
    const buf = encode([1, 2, 3]);
    expect(() => get(buf, 'foo')).toThrow();
  });

  it('schema.get() / schema.decode() reject a buffer from the wrong schema', () => {
    const a = defineSchema({ age: 'int32' });
    const b = defineSchema({ price: 'float64' });
    const bufA = a.encode({ age: 30 });
    expect(() => b.get(bufA, 'price')).toThrow(/Schema mismatch/);
  });

  it('validate() never throws, even on garbage', () => {
    const garbageCases = [
      null, undefined, 'a string', 42, {}, [], Buffer.from([1, 2]),
      Buffer.alloc(0), Buffer.alloc(1000), Buffer.from('not krson at all'),
    ];
    for (const g of garbageCases) {
      expect(() => validate(g)).not.toThrow();
    }
  });

  it('does not hang or crash on a circular reference (throws instead, like JSON.stringify)', () => {
    const circular = { a: 1 };
    circular.self = circular;
    expect(() => encode(circular)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Randomized fuzzing — throw N random byte buffers at decode()/get() and
// assert the library NEVER does anything worse than throw a clean Error:
// no unhandled crash, no hang (each call is bounded by the surrounding
// test timeout), no silent wrong-type return for a >=8-byte buffer that
// happens to start with valid magic+version bytes.
// ─────────────────────────────────────────────────────────────────────────

describe('fuzzing: random byte buffers never crash the process', () => {
  function randomBuffer(len) {
    const buf = Buffer.alloc(len);
    for (let i = 0; i < len; i++) buf[i] = (Math.random() * 256) | 0;
    return buf;
  }

  // Fully random buffers of varying length — magic bytes will almost
  // never match, so this exercises the "reject quickly" path.
  it('handles 500 fully-random buffers of varying length without throwing anything other than Error', () => {
    for (let i = 0; i < 500; i++) {
      const len = (Math.random() * 200) | 0;
      const buf = randomBuffer(len);
      try {
        decode(buf);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    }
  });

  // Random buffers that DO start with valid magic+version+flags, but have
  // random garbage after the header — this is the more dangerous case,
  // since it passes the first gate and exercises the actual value decoder.
  it('handles 500 buffers with valid header + random body without throwing anything other than Error', () => {
    for (let i = 0; i < 500; i++) {
      const len = 8 + ((Math.random() * 100) | 0);
      const buf = randomBuffer(len);
      buf[0] = 0x4B; buf[1] = 0x52; buf[2] = 0x06; buf[3] = 0; // valid magic/version, no flags
      try {
        decode(buf);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    }
  });

  // Take real, validly-encoded buffers and flip random bytes — simulates
  // network/storage corruption. Must never crash the process; either
  // decodes to *something* without throwing, or throws a clean Error.
  it('handles 300 randomly-bit-flipped versions of valid buffers without crashing', () => {
    const seeds = [
      { name: 'Alice', age: 30, score: 98.5, active: true, tags: ['a', 'b'], meta: { x: 1 } },
      { orders: [{ id: 1, items: [1, 2, 3] }, { id: 2, items: [] }] },
      { a: 'x'.repeat(500), b: 12345, c: -9999.5 },
    ];
    for (const seed of seeds) {
      const original = Buffer.from(encode(seed));
      for (let i = 0; i < 100; i++) {
        const corrupted = Buffer.from(original);
        const flipPos = (Math.random() * corrupted.length) | 0;
        corrupted[flipPos] = (Math.random() * 256) | 0;
        try {
          decode(corrupted);
        } catch (e) {
          expect(e).toBeInstanceOf(Error);
        }
      }
    }
  });

  // Fuzz get() the same way — separate code path (lazy/partial decode)
  // from decode(), and historically a likely place for bounds bugs.
  it('fuzzes get() with random field names against valid and corrupted buffers', () => {
    const buf = Buffer.from(encode({ name: 'Alice', age: 30, nested: { x: 1, y: [1, 2, 3] } }));
    const randomFieldNames = ['', 'a'.repeat(1000), '\x00\x01\x02', '__proto__', 'constructor', 'toString'];
    for (const field of randomFieldNames) {
      try {
        get(buf, field);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    }
  });

  // Fuzz schema.decode()/get() with corrupted buffers too.
  it('fuzzes schema-mode decode/get against corrupted buffers', () => {
    const schema = defineSchema({ id: 'int32', name: 'string', score: 'float64', active: 'bool' });
    const original = Buffer.from(schema.encode({ id: 1, name: 'x', score: 1.5, active: true }));
    for (let i = 0; i < 100; i++) {
      const corrupted = Buffer.from(original);
      const flipPos = (Math.random() * corrupted.length) | 0;
      corrupted[flipPos] = (Math.random() * 256) | 0;
      try {
        schema.decode(corrupted);
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
      try {
        schema.get(corrupted, 'name');
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Adversarial-shaped inputs on the ENCODE side — things a caller might
// pass in that aren't malicious per se, but are unusual/edge-of-spec.
// ─────────────────────────────────────────────────────────────────────────

describe('fuzzing: unusual encode-side inputs', () => {
  it('handles very long strings without corruption', () => {
    const s = 'a'.repeat(1_000_000);
    const dec = decode(encode({ s }));
    expect(dec.s).toBe(s);
    expect(dec.s.length).toBe(1_000_000);
  });

  it('handles objects with many keys', () => {
    const obj = {};
    for (let i = 0; i < 5000; i++) obj['key' + i] = i;
    const dec = decode(encode(obj));
    expect(Object.keys(dec).length).toBe(5000);
    expect(dec.key2500).toBe(2500);
  });

  it('handles arrays with many elements', () => {
    const arr = Array.from({ length: 50000 }, (_, i) => i);
    const dec = decode(encode({ arr }));
    expect(dec.arr.length).toBe(50000);
    expect(dec.arr[49999]).toBe(49999);
  });

  it('handles keys with unusual characters', () => {
    const obj = { 'key with spaces': 1, 'key-with-dashes': 2, 'key.with.dots': 3, '': 4 };
    const dec = decode(encode(obj));
    expect(dec).toEqual(obj);
  });

  it('does not let a field literally named "__proto__" pollute the prototype', () => {
    const obj = JSON.parse('{"__proto__": {"polluted": true}}');
    encode(obj); // must not throw or pollute Object.prototype
    expect({}.polluted).toBeUndefined();
  });
});
