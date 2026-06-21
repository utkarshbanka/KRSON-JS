import { describe, it, expect } from 'vitest';
const { encode, decode, get } = require('../index.js');

describe('STRING vs JSON_FALLBACK disambiguation (v5 fix)', () => {
  // Regression tests for the bug where a genuine string starting with
  // '[' or '{' was heuristically re-parsed as JSON on decode, silently
  // changing its type. STRING and JSON_FALLBACK are now distinct wire
  // type codes so this can never happen.

  it('preserves a string that looks like a JSON array', () => {
    const dec = decode(encode({ tag: '[urgent]' }));
    expect(dec.tag).toBe('[urgent]');
    expect(typeof dec.tag).toBe('string');
  });

  it('preserves a string that looks like a JSON object', () => {
    const dec = decode(encode({ code: '{ABC}' }));
    expect(dec.code).toBe('{ABC}');
    expect(typeof dec.code).toBe('string');
  });

  it('preserves a string that is actually valid JSON text', () => {
    const dec = decode(encode({ payload: '{"a":1,"b":2}' }));
    expect(dec.payload).toBe('{"a":1,"b":2}');
    expect(typeof dec.payload).toBe('string');
  });

  it('still correctly JSON-fallback-encodes genuinely unsupported types (e.g. Date)', () => {
    const obj = { when: new Date('2024-01-01T00:00:00Z') };
    const dec = decode(encode(obj));
    // Date serializes via JSON.stringify fallback (no enumerable own props),
    // so it comes back as an empty object — that's expected JS/JSON behavior,
    // not a KRSON bug. The key behavior under test: it does NOT come back
    // as a string, and it does not throw.
    expect(typeof dec.when).toBe('object');
  });

  it('get() can skip over a JSON_FALLBACK-typed field without crashing', () => {
    const buf = encode({ when: new Date(), tag: '[urgent]', extra: 'hello' });
    expect(get(buf, 'extra')).toBe('hello');
    expect(get(buf, 'tag')).toBe('[urgent]');
  });
});
