# krson

> Binary format that's faster than JSON for field access. Pure JS, zero dependencies.

## Why KRSON?

JSON.parse() always parses the *entire* object, even if you only need one field. KRSON lets you read individual fields directly from the binary buffer — without parsing the rest.

| Operation | vs JSON | 
|---|---|
| Single field read | **~10x faster** |
| Multiple field read (3 fields) | **~2.5x faster** |
| Payload size | **~26% smaller** |
| Full encode | ~1.2x slower |
| Full decode | ~1.4x slower |

**Best for:** APIs/caches/queues where consumers usually need only a few fields out of a larger object (user IDs, timestamps, status flags, etc.) — not for cases where you always need the full object.

## Install

```bash
npm install krson
```

## Quick Start

```js
const { KRSON } = require('krson');

// 1. Define a schema once (at startup)
const userSchema = KRSON.defineSchema({
  name:   'string',
  age:    'varint',
  score:  'float64',
  active: 'bool',
  tags:   'array',
  meta:   'object',
});

// 2. Encode
const buf = userSchema.encode({
  name: 'Alice', age: 30, score: 98.5, active: true,
  tags: ['admin'], meta: { country: 'IN' }
});

// 3. Decode — full object
const obj = userSchema.decode(buf);

// 4. Get ONE field — the fast path (10x faster than JSON.parse + .field)
const age = userSchema.get(buf, 'age');

// 5. Get SEVERAL fields in one pass (2.5x faster than JSON.parse + multiple reads)
const { name, age, score } = userSchema.getMany(buf, ['name', 'age', 'score']);
```

## JSON Compatibility

Most servers still send JSON. KRSON converts both ways:

```js
// Server sent JSON → convert to KRSON for storage/caching
const buf = KRSON.jsonToKrson(serverJsonString); // or pass a JS object directly

// Need to send JSON to an old API → convert back
const obj = KRSON.krsonToJson(buf);

// With a known schema (smaller payload, but you must define the schema first)
const buf2 = KRSON.jsonToKrsonSchema(userSchema, serverJsonString);
const obj2 = KRSON.krsonToJsonSchema(userSchema, buf2);
```

## Schemaless Mode

No schema needed — works like JSON.stringify/parse, with binary output:

```js
const buf = KRSON.encode(anyObject);
const obj = KRSON.decode(buf);
```

## Field Types

| Type | JS value | Notes |
|---|---|---|
| `'string'` | string | UTF-8 |
| `'varint'` | number (integer) | 1-5 bytes — smallest for small ints |
| `'int32'` | number (integer) | fixed 4 bytes |
| `'float64'` | number | fixed 8 bytes |
| `'bool'` | boolean | 1 byte |
| `'timestamp'` | number (ms or µs) | fixed 8 bytes |
| `'array'` | array | stored as embedded JSON |
| `'object'` | object | stored as embedded JSON |

## When NOT to use KRSON

- If you always need the *entire* object every time (no selective field reads) — `JSON.parse()` is simpler and roughly comparable in speed.
- If human-readability of the wire payload matters (e.g. debugging raw network captures).

## License

MIT
