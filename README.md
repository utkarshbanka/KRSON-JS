# KRSON
A binary serialization format for JavaScript — built for when you only need some of the data, not all of it.

> ⚠️ **Status: Testing / Early Stage.** KRSON is usable today (Node + browser), but it's new, the wire format may still change between minor versions, and it hasn't been battle-tested in production at scale. Benchmark numbers below are real, measured on this exact codebase — including the parts where KRSON is not faster. Read the "Honest Numbers" section before you adopt it.

## Table of Contents
- [Why KRSON exists](#why-krson-exists)
- [What problem it actually solves](#what-problem-it-actually-solves)
- [How it works](#how-it-works)
- [Install](#install)
- [Step-by-step: Node.js (backend)](#step-by-step-nodejs-backend)
- [Step-by-step: Browser (frontend)](#step-by-step-browser-frontend)
- [Full API Reference](#full-api-reference)
- [Benchmarks (honest numbers)](#benchmarks-honest-numbers)
- [KRSON vs Protobuf vs MessagePack — where it fits](#krson-vs-protobuf-vs-messagepack--where-it-fits)
- [When to use KRSON / when not to](#when-to-use-krson--when-not-to)
- [Debugging & inspecting KRSON buffers](#debugging--inspecting-krson-buffers)
- [Roadmap](#roadmap)

---

## Why KRSON exists

JSON is the default for almost everything in JS — and for most cases, that's fine. But JSON has one structural limitation that nothing about its design ever tries to fix:

**To read one field out of a JSON payload, you must parse the entire payload first.**

`JSON.parse(str).age` still has to parse `name`, `score`, `active`, every nested object, every array — everything — before it can hand you `age`. There is no way to skip ahead. The format doesn't carry the information needed to skip ahead, because it's not length-prefixed and it's not schema-aware.

This doesn't matter when your payload is small. It starts to matter when:

- You're parsing the same shape of object thousands/millions of times a second (event streams, sensor data, microservice-to-microservice calls)
- You're only using 2–3 fields out of a 20+ field object (a dashboard that shows `username` from a `User` object that also has `address`, `bio`, `preferences`, `metadata`, etc.)
- You're paying for bandwidth and parse time at scale, where small % gains compound

KRSON was built to test whether a schema-first, length-prefixed binary format could make partial field access meaningfully cheaper than `JSON.parse() + field` — without needing a code-generation step, a `.proto` compiler, or a build pipeline. You just call `defineSchema()` at runtime and start encoding.

---

## What problem it actually solves

KRSON does not try to be a faster JSON replacement for "parse everything" use cases — see the Honest Numbers section, because encode/decode of the whole object is not where KRSON wins.

**What KRSON actually solves: random access to specific fields inside a binary buffer, without deserializing the whole thing.**

Because each field in a schema has a known type and (for fixed-size types) a known byte offset, KRSON can:

- Jump straight to a field's offset and read just that field (`schema.get()`)
- Jump to several fields in one pass, in field order, skipping the bytes in between (`schema.getMany()`)
- Skip the JS garbage-collector churn that comes from `JSON.parse()` allocating a full object graph just so you can throw most of it away

This is the same general idea behind formats like FlatBuffers (zero-copy access) — KRSON is a much smaller, pure-JS take on that idea, with a much simpler mental model (no compiler, no `.proto` file, just a plain JS object describing field types).

---

## How it works

1. You define a schema once, mapping field names to types (`string`, `varint`, `int32`, `float64`, `bool`, `timestamp`, `array`, `object`).
2. KRSON computes, ahead of time, which fields are fixed-size (booleans, int32, float64, timestamps) and what their byte offset is inside the encoded buffer. Variable-size fields (strings, arrays, objects) break the "known offset" chain after their position — KRSON has to walk forward from the last known fixed offset to find them, which is still far less work than parsing the entire object.
3. Encoding writes a small header (`magic bytes 'K' 'R'`, version, flags, schema ID) followed by each field's value in a compact binary type-tagged format.
4. Decoding can either:
   - Walk the whole buffer and rebuild the JS object (`schema.decode()`) — conceptually similar cost to `JSON.parse()`, sometimes slightly more, sometimes less, depending on the data.
   - Jump straight to one field (`schema.get()`) or a sorted list of fields (`schema.getMany()`) — this is the actual performance win, because it skips building any objects you don't need.

The same wire format is read by both the Node build (`index.js`, uses `Buffer`) and the browser build (`browser.js`, uses `ArrayBuffer`/`Uint8Array`/`DataView`) — same bytes on the wire either way, so a Node server and a browser client can talk KRSON to each other directly over `fetch`/HTTP.

---

## Install

```bash
npm install krson-js
```

Works in:
- **Node.js (≥16)** — imports `index.js` automatically via the `main` field
- **Browsers / Vite / Webpack / React / Vue** — imports `browser.js` automatically via the `browser` / `exports` field, no `Buffer` polyfill needed

---

## Step-by-step: Node.js (backend)

### 1. Import and define a schema

```javascript
const { defineSchema } = require('krson-js');

const userSchema = defineSchema({
  name:   'string',
  age:    'varint',
  score:  'float64',
  active: 'bool',
});
```

Define each schema **once, at startup** — not per-request. `defineSchema()` registers the schema in an internal registry and pre-computes field offsets; doing this on every request throws away that benefit and leaks schema IDs.

### 2. Encode an object

```javascript
const buf = userSchema.encode({
  name:   'Alice',
  age:    30,
  score:  98.5,
  active: true,
});
// buf is a Buffer — send it over HTTP, write it to a file, store it, etc.
```

### 3. Decode the whole object back

```javascript
const obj = userSchema.decode(buf);
// { name: 'Alice', age: 30, score: 98.5, active: true }
```

### 4. Read just one field (the actual point of KRSON)

```javascript
const age = userSchema.get(buf, 'age'); // → 30
```

No full object is built. This is the fast path.

### 5. Read a few fields at once

```javascript
const subset = userSchema.getMany(buf, ['name', 'age']);
// { name: 'Alice', age: 30 }
```

### 6. Use it in an Express route

```javascript
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

The browser build exposes the exact same API, just operating on `Uint8Array`/`ArrayBuffer` instead of Node `Buffer`.

### 1. Import

```javascript
import { defineSchema } from 'krson-js';
```

(With Vite/Webpack/CRA, bundlers automatically pick `browser.js` via the package's `browser`/`exports` field — you don't need to do anything special.)

### 2. Define the same schema as the server

The field names, types, and **order** must match what the server used to encode, otherwise decoding will read garbage. Treat the schema definition as a contract between client and server — keep it in a shared file if both sides are JS, or keep it manually in sync if not.

```javascript
const userSchema = defineSchema({
  userId:   'varint',
  username: 'string',
  email:    'string',
});
```

### 3. Fetch and decode

```javascript
const res = await fetch('/api/user/42');
const buf = await res.arrayBuffer();

const user = userSchema.decode(buf);
console.log(user); // { userId: 42, username: '...', email: '...' }
```

### 4. Only need one field? Skip the full decode

```javascript
const res = await fetch('/api/user/42');
const buf = await res.arrayBuffer();

const username = userSchema.get(buf, 'username');
```

This is the scenario KRSON is built for: a big object comes over the wire, the UI only renders 1–2 of its fields, and you don't want to pay the cost of materializing the rest.

---

## Full API Reference

```javascript
const {
  defineSchema,   // (def, options?) => schema object
  encode,         // (obj) => buffer  — schemaless encode
  decode,         // (buf) => obj     — schemaless decode
  get,            // (buf, field) => value — schemaless single-field access
  validate,       // (buf) => boolean — checks magic bytes + version
  inspect,        // (buf, schema?) => obj — safe decode, returns {error} instead of throwing
  prettyPrint,    // (buf, schema?) => string — human-readable dump, also console.logs it
} = require('krson-js');
```

### `defineSchema(def, options?)`

`def` is a plain object: `{ fieldName: type, ... }`.

Supported types:

| Type | Fixed size? | Notes |
|---|---|---|
| `bool` | 1 byte | |
| `int32` | 4 bytes | signed 32-bit |
| `float64` | 8 bytes | double precision |
| `timestamp` | 8 bytes | stored as int64 ms |
| `varint` | variable | compact for small integers; correct for full ±2⁵³ safe-integer range |
| `string` | variable | UTF-8, length-prefixed |
| `array` | variable | native binary encoding |
| `object` | variable | native binary encoding |

Options:

```javascript
defineSchema({ ... }, { crc: true }) // enable CRC32 integrity check on every buffer
```

Returns a schema handle with:

| Method | Signature | What it does |
|---|---|---|
| `.encode(obj)` | `obj => buffer` | Encodes a full object |
| `.decode(buf)` | `buf => obj` | Decodes the full object |
| `.get(buf, field)` | `(buf, field) => value` | Reads one field without building the full object |
| `.getMany(buf, fields)` | `(buf, fields[]) => obj` | Reads several fields in one forward pass |
| `.dispose()` | `() => void` | Removes schema from registry — call this if you create schemas dynamically (e.g. per-tenant), otherwise they accumulate in memory |
| `.id` | `number` | The schema's internal registry ID (also embedded in the encoded buffer's header) |

### `encode(obj)` / `decode(buf)` / `get(buf, field)` — schemaless

For cases where you don't want to define a schema up front. Uses a string interning table (deduplication of repeated keys/values) so repeated field names aren't written multiple times. `get(buf, field)` does single-field access without decoding the string table or the rest of the value tree.

### `validate(buf)`

Cheap sanity check — confirms the buffer starts with the KRSON magic bytes (`0x4B 0x52`, i.e. `"KR"`) and the expected version byte. Use this before trusting a buffer came from KRSON (e.g. on a public endpoint).

### `inspect(buf, schema?)`

Same as decode, but never throws — returns `{ error: '...' }` instead. Useful for logging/debugging untrusted or malformed buffers.

### `prettyPrint(buf, schema?)`

Prints a human-readable box to the console and also returns the string. Good for debugging in dev tools or terminal:

```
┌─ KRSON Packet ─────────────────────────
│  magic    : KR (0x4B 0x52)
│  version  : v5
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

Real numbers from `test.js` in this repo, run on **Node 22, Windows, 1,000,000 iterations**. No numbers are cherry-picked — encode is genuinely slower than JSON, and that's stated plainly.

```
=== Core Benchmark (1,000,000 iterations) ===

ENCODE:
  KRSON encode             891ms   1.4x slower
  JSON stringify           634ms

DECODE:
  KRSON decode            1153ms   1.1x slower
  JSON parse              1003ms

SINGLE FIELD ACCESS:
  KRSON get(age)           135ms   7.6x FASTER ✅
  JSON parse + field      1032ms

MULTIPLE FIELDS (3 fields):
  KRSON getMany            476ms   2.1x FASTER ✅
  JSON parse + 3 fields    990ms

PAYLOAD SIZE:
  JSON                   119 bytes
  KRSON                   95 bytes   20% smaller ✅

READ HEAVY (1 write + 100 reads):
  KRSON read-heavy        1391ms   7.2x FASTER ✅
  JSON read-heavy        10047ms

READ RATIO (1 write : 100 reads):
  KRSON ratio             1176ms   8.4x FASTER ✅
  JSON ratio              9861ms

ANALYTICS (1M records):
  KRSON analytics           16ms   6.4x FASTER ✅
  JSON analytics           103ms

API GATEWAY:
  KRSON gateway            456ms   2.2x FASTER ✅
  JSON gateway            1005ms

MEMORY (encode-discard throughput, 100k records):
  KRSON Heap Used          0.89 MB
  JSON Heap Used          12.54 MB
```

**What this means in plain terms:**

- **Encoding a full object** — slower than `JSON.stringify()`. The per-field type-tagging overhead costs more than V8's native JSON stringifier. This is the honest weak point, and an area for future optimization.
- **Decoding a full object** — roughly comparable (~1.1x slower). Not a reason to switch on its own.
- **Single field access** — 7.6x faster than `JSON.parse() + field`. This is what KRSON is for.
- **Read-heavy workloads** — 7–8x faster when you write once and read many times. This is the primary use case.
- **Payload size** — 20% smaller on the wire for this sample object.
- **Memory** — 14x less heap churn in encode-discard throughput mode (encode → use → GC).

The takeaway: KRSON is not a general JSON replacement. It is a tool for one specific situation — you have a binary blob and you want some of the fields in it, cheaply, without paying for the rest.

---

## KRSON vs Protobuf vs MessagePack — where it fits

|  | Protocol Buffers | MessagePack | KRSON |
|---|---|---|---|
| Schema required? | Yes, `.proto` file + code generation | No (schemaless by default) | Yes, but plain JS object at runtime — no compiler/build step |
| Partial field access without full decode? | No — decode is a full unmarshal | No — decode is a full unmarshal | Yes — `get()`/`getMany()` skip building the rest |
| Cross-language? | Yes (C++, Go, Python, Java, etc.) | Yes (many languages) | Not yet — JS only today (Node + browser). Python/Go/Java ports planned, wire-compatible per SPEC.md, not available yet. |
| Setup complexity | Higher (compiler, generated code) | Very low | Low (one `defineSchema()` call) |
| Best at | Cross-service contracts at large orgs, strict versioning | Drop-in compact JSON replacement, general use | Field-level random access inside a JS-only stack |

If you need cross-language interoperability or strict schema evolution guarantees today, Protobuf is the mature answer. If you want a fast schemaless binary JSON replacement, MessagePack is mature and well-supported. KRSON's niche is narrower and JS-specific: schema-aware partial field access without a compile step.

---

## When to use KRSON / when not to

**✅ Good fit:**
- Both ends of the wire are JavaScript (Node backend ↔ browser/React/Vue frontend)
- You fetch objects with many fields but only render/use a few of them
- High-frequency internal calls where avoiding full `JSON.parse()` allocations matters
- You want a binary, compact wire format without setting up a `.proto` compiler

**❌ Not a good fit (yet):**
- You need cross-language support today — only `krson-js` exists right now. Python/Go/Java are planned but not ready.
- You always consume every field of every object anyway — JSON or MessagePack will serve you just as well
- You need strict backward/forward schema versioning guarantees — KRSON is early stage, no mature versioning story yet
- Encoding throughput is your bottleneck — KRSON is currently slower than `JSON.stringify()` here

---

## Debugging & inspecting KRSON buffers

Since KRSON buffers aren't human-readable like JSON, use these while developing:

```javascript
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
- **Network tab** — a KRSON response will show as `application/octet-stream` binary data, not readable JSON text. That's expected — it confirms the binary format is actually being used on the wire.

---

## Roadmap

- Improve `encode()` throughput (currently the one regressed metric vs JSON)
- More rigorous fuzz-testing of the binary decoder against malformed input
- Versioned schema migration support
- Python, Go, and Java implementations — wire-compatible with `krson-js`. The exact byte-level format is documented in `SPEC.md`, including quirks that must be replicated exactly (e.g. `float64` is big-endian while every other multi-byte type is little-endian). Read `SPEC.md` before starting any new-language port.

Feedback, issues, and benchmarks from real usage are welcome on GitHub.

---

## License

MIT

## Links

- GitHub: https://github.com/utkarshbanka/KRSON
- npm: https://www.npmjs.com/package/krson-js
