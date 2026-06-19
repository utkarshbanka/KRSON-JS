# KRSON

**A binary serialization format for JavaScript — built for when you only need *some* of the data, not all of it.**

> ⚠️ **Status: Testing / Early Stage.** KRSON is usable today (Node + browser), but it's new, the wire format may still change between minor versions, and it hasn't been battle-tested in production at scale. Benchmark numbers below are real, measured on this exact codebase — including the parts where KRSON is *not* faster. Read the "Honest Numbers" section before you adopt it.

---

## Table of Contents

1. [Why KRSON exists](#why-krson-exists)
2. [What problem it actually solves](#what-problem-it-actually-solves)
3. [How it works](#how-it-works)
4. [Install](#install)
5. [Step-by-step: Node.js (backend)](#step-by-step-nodejs-backend)
6. [Step-by-step: Browser (frontend)](#step-by-step-browser-frontend)
7. [Full API Reference](#full-api-reference)
8. [Benchmarks (honest numbers)](#benchmarks-honest-numbers)
9. [KRSON vs Protobuf vs MessagePack — where it fits](#krson-vs-protobuf-vs-messagepack--where-it-fits)
10. [When to use KRSON / when not to](#when-to-use-krson--when-not-to)
11. [Debugging & inspecting KRSON buffers](#debugging--inspecting-krson-buffers)
12. [Roadmap](#roadmap)

---

## Why KRSON exists

JSON is the default for almost everything in JS — and for most cases, that's fine. But JSON has one structural limitation that nothing about its design ever tries to fix:

> **To read *one* field out of a JSON payload, you must parse the *entire* payload first.**

`JSON.parse(str).age` still has to parse `name`, `score`, `active`, every nested object, every array — everything — before it can hand you `age`. There is no way to skip ahead. The format doesn't carry the information needed to skip ahead, because it's not length-prefixed and it's not schema-aware.

This doesn't matter when your payload is small. It starts to matter when:
- You're parsing the same shape of object thousands/millions of times a second (event streams, sensor data, microservice-to-microservice calls)
- You're only using 2-3 fields out of a 20+ field object (a dashboard that shows `username` from a `User` object that also has `address`, `bio`, `preferences`, `metadata`, etc.)
- You're paying for bandwidth and parse time at scale, where small % gains compound

KRSON was built to test whether a **schema-first, length-prefixed binary format** could make *partial field access* meaningfully cheaper than `JSON.parse() + field` — without needing a code-generation step, a `.proto` compiler, or a build pipeline. You just call `defineSchema()` at runtime and start encoding.

## What problem it actually solves

KRSON does **not** try to be a faster JSON replacement for "parse everything" use cases — see the [Honest Numbers](#benchmarks-honest-numbers) section, because encode/decode of the *whole* object is not where KRSON wins.

What KRSON actually solves: **random access to specific fields inside a binary buffer, without deserializing the whole thing.**

Because each field in a schema has a known type and (for fixed-size types) a known byte offset, KRSON can:
- Jump straight to a field's offset and read just that field (`schema.get()`)
- Jump to several fields in one pass, in field order, skipping the bytes in between (`schema.getMany()`)
- Skip the JS garbage-collector churn that comes from `JSON.parse()` allocating a full object graph just so you can throw most of it away

This is the same general idea behind formats like FlatBuffers (zero-copy access) — KRSON is a much smaller, pure-JS take on that idea, with a much simpler mental model (no compiler, no `.proto` file, just a plain JS object describing field types).

## How it works

1. **You define a schema once**, mapping field names to types (`string`, `varint`, `int32`, `float64`, `bool`, `timestamp`, `array`, `object`).
2. KRSON computes, ahead of time, which fields are **fixed-size** (booleans, int32, float64, timestamps) and what their **byte offset** is inside the encoded buffer. Variable-size fields (strings, arrays, objects) break the "known offset" chain after their position — KRSON has to walk forward from the last known fixed offset to find them, which is still way less work than parsing the entire object.
3. **Encoding** writes a small header (`magic bytes 'K' 'R'`, version, flags, schema ID) followed by each field's value in a compact binary type-tagged format.
4. **Decoding** can either:
   - Walk the whole buffer and rebuild the JS object (`schema.decode()`) — conceptually similar cost to `JSON.parse()`, sometimes slightly more, sometimes less, depending on the data.
   - Jump straight to one field (`schema.get()`) or a sorted list of fields (`schema.getMany()`) — **this is the actual performance win**, because it skips building any objects you don't need.
5. The same wire format is read by both the **Node build** (`index.js`, uses `Buffer`) and the **browser build** (`browser.js`, uses `ArrayBuffer`/`Uint8Array`/`DataView`) — same bytes on the wire either way, so a Node server and a browser client can talk KRSON to each other directly over `fetch`/HTTP.

---

## Install

```bash
npm install krson-js
```

Works in:
- **Node.js** (≥16) — imports `index.js` automatically via the `main` field
- **Browsers / Vite / Webpack / React / Vue** — imports `browser.js` automatically via the `browser` / `exports` field, no `Buffer` polyfill needed

---

## Step-by-step: Node.js (backend)

### 1. Import and define a schema

```js
const { defineSchema } = require('krson-js');

const userSchema = defineSchema({
  name:   'string',
  age:    'varint',
  score:  'float64',
  active: 'bool',
});
```

Define each schema **once**, at startup — not per-request. `defineSchema()` registers the schema in an internal registry and pre-computes field offsets; doing this on every request throws away that benefit and leaks schema IDs.

### 2. Encode an object

```js
const buf = userSchema.encode({
  name:   'Alice',
  age:    30,
  score:  98.5,
  active: true,
});
// buf is a Buffer — send it over HTTP, write it to a file, store it, etc.
```

### 3. Decode the whole object back

```js
const obj = userSchema.decode(buf);
// { name: 'Alice', age: 30, score: 98.5, active: true }
```

### 4. Read just one field (the actual point of KRSON)

```js
const age = userSchema.get(buf, 'age'); // → 30
```

No full object is built. This is the fast path.

### 5. Read a few fields at once

```js
const subset = userSchema.getMany(buf, ['name', 'age']);
// { name: 'Alice', age: 30 }
```

### 6. Use it in an Express route

```js
const express = require('express');
const { defineSchema } = require('krson-js');

const app = express();

const userSchema = defineSchema({
  userId:   'varint',
  username: 'string',
  email:    'string',
});

app.get('/api/user/:id', (req, res) => {
  const user = lookupUserSomehow(req.params.id);
  const buf = userSchema.encode(user);
  res.set('Content-Type', 'application/octet-stream');
  res.send(buf);
});
```

---

## Step-by-step: Browser (frontend)

The browser build exposes the **exact same API**, just operating on `Uint8Array`/`ArrayBuffer` instead of Node `Buffer`.

### 1. Import

```js
import { defineSchema } from 'krson-js';
```

(With Vite/Webpack/CRA, bundlers automatically pick `browser.js` via the package's `browser`/`exports` field — you don't need to do anything special.)

### 2. Define the **same schema** as the server

The field names, types, and order must match what the server used to encode, otherwise decoding will read garbage. Treat the schema definition as a contract between client and server — keep it in a shared file if both sides are JS, or keep it manually in sync if not.

```js
const userSchema = defineSchema({
  userId:   'varint',
  username: 'string',
  email:    'string',
});
```

### 3. Fetch and decode

```js
const res = await fetch('/api/user/42');
const buf = await res.arrayBuffer(); // ArrayBuffer, not JSON

const user = userSchema.decode(buf);
console.log(user); // { userId: 42, username: '...', email: '...' }
```

### 4. Only need one field? Skip the full decode

```js
const res = await fetch('/api/user/42');
const buf = await res.arrayBuffer();

const username = userSchema.get(buf, 'username');
```

This is the scenario KRSON is built for: a big object comes over the wire, the UI only renders 1-2 of its fields, and you don't want to pay the cost of materializing the rest.

---

## Full API Reference

```js
const {
  defineSchema,  // (def) => schema object
  encode,        // (obj) => buffer — schemaless, JSON-in-a-KRSON-envelope
  decode,        // (buf) => obj    — schemaless decode
  validate,      // (buf) => boolean — checks magic bytes + version
  inspect,       // (buf, schema?) => obj — safe decode, returns {error} instead of throwing
  prettyPrint,   // (buf, schema?) => string — human-readable dump, also console.logs it
} = require('krson-js');
```

### `defineSchema(def)`

`def` is a plain object: `{ fieldName: type, ... }`.

Supported types:

| Type        | Fixed size? | Notes |
|-------------|-------------|-------|
| `bool`      | 1 byte      | |
| `int32`     | 4 bytes     | signed 32-bit |
| `float64`   | 8 bytes     | double precision |
| `timestamp` | 8 bytes     | stored as int64 ms |
| `varint`    | variable    | compact for small numbers |
| `string`    | variable    | UTF-8, length-prefixed |
| `array`     | variable    | stored as JSON internally |
| `object`    | variable    | stored as JSON internally |

Returns a schema handle with:

| Method | Signature | What it does |
|---|---|---|
| `.encode(obj)` | `obj => buffer` | Encodes a full object |
| `.decode(buf)` | `buf => obj` | Decodes the full object |
| `.get(buf, field)` | `(buf, fieldName) => value` | Reads one field without building the full object |
| `.getMany(buf, fields)` | `(buf, fieldNames[]) => obj` | Reads several fields in one forward pass |
| `.id` | `number` | The schema's internal registry ID (also embedded in the encoded buffer's header) |

### `encode(obj)` / `decode(buf)` — schemaless

For cases where you don't want to define a schema up front. Internally this is just `JSON.stringify`/`JSON.parse` wrapped in the KRSON header/envelope, so you get the consistent magic-byte format but **none of the field-skipping speed benefit**. Use schemas if performance matters.

### `validate(buf)`

Cheap sanity check — confirms the buffer starts with the KRSON magic bytes (`0x4B 0x52`, i.e. `"KR"`) and the expected version byte. Use this before trusting a buffer came from KRSON (e.g. on a public endpoint).

### `inspect(buf, schema?)`

Same as `decode`, but never throws — returns `{ error: '...' }` instead. Useful for logging/debugging untrusted or malformed buffers.

### `prettyPrint(buf, schema?)`

Prints a human-readable box to the console and also returns the string. Good for debugging in dev tools or terminal:

```
┌─ KRSON Packet ─────────────────────────
│  magic    : KR (0x4B 0x52)
│  version  : v2
│  schema   : #1
│  size     : 47 bytes
├─ Fields ───────────────────────────────
│  name    : Alice
│  age     : 30
│  score   : 98.5
│  active  : true
└────────────────────────────────────────
```

---

## Benchmarks (honest numbers)

These are real numbers from `test.js` in this repo, run on Node 22, Windows, 1,000,000 iterations. **No numbers are cherry-picked — encode is genuinely slower than JSON, and that's stated plainly:**

```
=== Benchmark (1,000,000 iterations) ===
ENCODE:
  KRSON schema.encode()  2398ms   2.7x slower
  JSON.stringify()        880ms

DECODE:
  KRSON schema.decode()  1532ms   1.2x slower
  JSON.parse()            1319ms

SINGLE FIELD:
  KRSON schema.get()      125ms   10.7x FASTER ✅
  JSON.parse() + .field  1334ms

PAYLOAD SIZE:
  JSON:                   119 bytes
  KRSON schema-first:      91 bytes  (24% smaller ✅)

MULTIPLE FIELDS (3 fields):
  KRSON schema.getMany()  671ms   2.2x FASTER ✅
  JSON.parse() + 3 fields 1458ms
```

**What this means in plain terms:**

- **Encoding a full object** — slower right now than `JSON.stringify()`. This is the honest weak point; the per-field type-tagging and buffer allocation overhead costs more than V8's highly optimized native JSON stringifier. This is an area for future optimization, not a hidden cost.
- **Decoding a full object** — roughly comparable, slightly slower (~1.2x). Not a reason to switch on its own.
- **Reading a single field** — this is the actual point of KRSON, and it shows: **10.7x faster** than `JSON.parse()` + field access, because it skips building the rest of the object entirely.
- **Reading a few fields at once** (`getMany`) — **2.2x faster**, same underlying reason.
- **Payload size** — **24% smaller** on the wire for this sample object, mainly because numbers use compact varint/typed encoding instead of decimal text, and there's no repeated key-name text (`"name":`, `"age":`, etc.) per object.

The takeaway: **KRSON is not a general JSON replacement.** It is a tool for one specific situation — you have a binary blob and you want some of the fields in it, cheaply, without paying for the rest.

---

## KRSON vs Protobuf vs MessagePack — where it fits

This is not a "KRSON beats X" comparison — it's where KRSON sits conceptually, so you can decide what's right for your project:

| | **Protocol Buffers** | **MessagePack** | **KRSON** |
|---|---|---|---|
| Schema required? | Yes, `.proto` file + code generation | No (schemaless by default) | Yes, but plain JS object at runtime — no compiler/build step |
| Partial field access without full decode? | No — decode is a full unmarshal | No — decode is a full unmarshal | **Yes** — `get()`/`getMany()` skip building the rest |
| Cross-language? | Yes (C++, Go, Python, Java, etc.) | Yes (many languages) | Not yet — JS only today (Node + browser). Python/Go/Java ports are planned and will be wire-compatible per [`SPEC.md`](./SPEC.md), but aren't available yet. |
| Setup complexity | Higher (compiler, generated code) | Very low | Low (one `defineSchema()` call) |
| Best at | Cross-service contracts at large orgs, strict versioning | Drop-in compact JSON replacement, general use | Field-level random access inside a JS-only stack |

If you need cross-language interoperability or strict schema evolution guarantees, Protobuf is the mature, production answer. If you want a fast, schemaless, general-purpose binary JSON replacement, MessagePack is mature and well-supported. **KRSON's niche today is narrower and JS-specific:** it's for the case where your whole stack (server + client) is already JavaScript, and you specifically want cheap access to a subset of fields inside a binary buffer — without a compile step. Cross-language support (Python/Go/Java) is on the roadmap and will follow the same wire format documented in `SPEC.md`, but isn't ready yet — don't build on it for cross-language use cases until those ports exist and pass conformance testing.

---

## When to use KRSON / when not to

**✅ Good fit:**
- Both ends of the wire are JavaScript (Node backend ↔ browser/React/Vue frontend)
- You fetch objects with many fields but only render/use a few of them
- High-frequency internal calls where avoiding full `JSON.parse()` allocations matters
- You want a binary, compact wire format without setting up a `.proto` compiler

**❌ Not a good fit (yet):**
- You need cross-language support **today** — only `krson-js` exists right now. Python/Go/Java implementations are planned (see [Roadmap](#roadmap) and [`SPEC.md`](./SPEC.md) for the wire format they'll follow), but until they ship and pass conformance testing against the spec, treat KRSON as JS-only in production. Use Protobuf or MessagePack if you need cross-language today.
- You always consume every field of every object anyway — JSON or MessagePack will serve you just as well or better, with less new surface area
- You need strict backward/forward schema versioning guarantees in production — KRSON is in early/testing stage and doesn't have a mature versioning story yet
- Encoding throughput (not decoding/field-access) is your bottleneck — KRSON is currently slower than `JSON.stringify()` here

---

## Debugging & inspecting KRSON buffers

Since KRSON buffers aren't human-readable like JSON, use these while developing:

```js
const { validate, inspect, prettyPrint } = require('krson-js');

// Is this actually a KRSON buffer?
validate(buf); // true / false

// Safe decode, never throws
inspect(buf, userSchema); // { name: 'Alice', age: 30, ... } or { error: '...' }

// Pretty console dump
prettyPrint(buf, userSchema);
```

In the browser, open DevTools:
- **Console tab** — `console.log(new Uint8Array(buf))` to see raw bytes, or `console.log(userSchema.decode(buf))` to see the decoded object.
- **Network tab** — a KRSON response will show as `application/octet-stream` binary data, not readable JSON text. That's expected — it confirms the binary format is actually being used on the wire, not just in memory.

---

## Roadmap

This package is in active testing. Known next steps:
- Improve `encode()` throughput (currently the one regressed metric vs JSON)
- String interning / string table support for repeated values across records (the `FLAG_HAS_STRING_TABLE` flag already exists in the wire format for this)
- More rigorous fuzz-testing of the binary decoder against malformed input
- Versioned schema migration support
- **Python, Go, and Java implementations**, wire-compatible with `krson-js`. The exact byte-level format these ports must match is documented in [`SPEC.md`](./SPEC.md) — including a couple of quirks in the current JS implementation (e.g. `float64` is big-endian while every other multi-byte type is little-endian) that have to be replicated exactly for cross-language buffers to decode correctly. Read `SPEC.md` before starting any new-language port; it includes a byte-for-byte worked example and a conformance checklist.

Feedback, issues, and benchmarks from real usage are welcome on GitHub.

## License

MIT

## Links

- GitHub: https://github.com/utkarshbanka/KRSON
- npm: https://www.npmjs.com/package/krson-js
