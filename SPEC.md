# KRSON Wire Format Specification (v2)

**Status: Derived from the reference JS implementation (`krson-js@2.3.1`). This is a description of what the code actually does on the wire, byte for byte — not an idealized design.** If you're porting KRSON to Python, Go, Java, or any other language, this document is the contract. Match it exactly, including the quirks called out below, or buffers encoded in one language won't decode correctly in another.

This spec covers only the **wire format** — how bytes are laid out. It does not cover language-specific API shape (that's up to each implementation, the same way `defineSchema()` in JS doesn't have to look like whatever Python/Go end up calling it).

---

## 1. Packet Header (8 bytes, always present)

Every encoded KRSON buffer starts with a fixed 8-byte header:

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 byte | `magic0` | always `0x4B` (ASCII `'K'`) |
| 1 | 1 byte | `magic1` | always `0x52` (ASCII `'R'`) |
| 2 | 1 byte | `version` | always `0x02` for this spec version |
| 3 | 1 byte | `flags` | bitfield, see below |
| 4 | 4 bytes | `schemaId` | **little-endian** uint32. `0` = schemaless |

### Flags byte (offset 3)

| Bit | Constant | Meaning |
|---|---|---|
| `1 << 3` (`0x08`) | `FLAG_HAS_STRING_TABLE` | reserved — defined in the reference implementation but **not yet used** by encode/decode. Do not rely on this being functional yet. |
| `1 << 4` (`0x10`) | `FLAG_HAS_SCHEMA_ID` | set on every schema-based encode; `0` on schemaless encode |

All other bits are currently unused — must be written as `0` and ignored on read until a future version defines them.

After the 8-byte header, the payload begins immediately (no padding, no alignment).

---

## 2. Type Codes

Every value in the payload is preceded by a single **type-code byte**, then its value bytes. There is no length prefix on the *value* unless the type itself is variable-length (string).

| Type code (hex) | Name | Meaning |
|---|---|---|
| `0x00` | `NULL` | value is `null`/`undefined` — written **regardless of declared field type** if the JS value was `null`/`undefined` |
| `0x01` | `BOOL_FALSE` | boolean false |
| `0x02` | `BOOL_TRUE` | boolean true |
| `0x12` | `INT32` | signed 32-bit integer |
| `0x13` | `INT64` | reserved — defined as a constant in the reference implementation but **not currently emitted by encode**. Implementers should support decoding it as a signed 64-bit little-endian integer for forward compatibility, even though current encoders won't produce it. |
| `0x18` | `VARINT` | non-negative variable-length integer |
| `0x19` | `VARINT_NEG` | negative variable-length integer (magnitude stored as unsigned varint, sign implied by this type code) |
| `0x21` | `FLOAT64` | IEEE 754 double — ⚠️ **big-endian**, see note below |
| `0x30` | `STRING` | UTF-8 string, length-prefixed |
| `0x31` | `BYTES` | reserved — constant defined, **not currently emitted**. Treat as length-prefixed raw bytes (same layout as STRING but no UTF-8 decode) if you encounter it. |
| `0x32` | `STRING_REF` | reserved for future string-table interning. Currently decoded identically to `STRING` (length-prefixed UTF-8) since no encoder emits a string table yet. |
| `0x40` | `TIMESTAMP` | signed 64-bit integer, milliseconds since Unix epoch, **little-endian** |
| `0x50` | `ARRAY` | reserved — constant defined, **not currently emitted**. Arrays are currently encoded as type `0x30` (STRING) containing a JSON-encoded string. See §4. |
| `0x51` | `MAP` | reserved, same situation as `ARRAY` — objects are currently encoded as `STRING`/JSON, not as a native `MAP` type. |

---

## 3. Per-Type Byte Layout

### `NULL` (`0x00`)
1 byte total: just the type code. No value bytes.

### `BOOL_TRUE` / `BOOL_FALSE` (`0x01` / `0x02`)
1 byte total: just the type code. The code itself carries the value.

### `VARINT` / `VARINT_NEG` (`0x18` / `0x19`)
- 1 type-code byte, followed by a **LEB128-style unsigned varint** of the absolute value.
- Varint encoding: each byte holds 7 bits of magnitude in bits 0-6 (little-endian bit order, least-significant group first); bit 7 (`0x80`) is the continuation flag — set if another byte follows.
- Maximum 5 varint bytes are read/written (supports up to 32-bit magnitude in the reference implementation — be aware if you need full 64-bit range, the current JS implementation does not guarantee it).
- Sign is **not** encoded inside the varint bytes — it's determined entirely by whether the type code is `0x18` (treat as positive) or `0x19` (negate the decoded magnitude).

Example: encoding `30` as a varint → type code `0x18`, then varint bytes for `30` → `0x1E` (single byte, since `30 < 128`). Total: `18 1E`.

### `INT32` (`0x12`)
- 1 type-code byte + 4 bytes.
- Signed 32-bit integer, **little-endian**.

### `FLOAT64` (`0x21`)
- 1 type-code byte + 8 bytes.
- IEEE 754 double precision.
- ⚠️ **Byte order is big-endian.** This is inconsistent with every other multi-byte numeric type in the format (which are little-endian) — it appears to be an unintentional inconsistency in the reference implementation rather than a deliberate design choice. **It must be replicated exactly in every language port**, because the wire format is defined by what the reference implementation actually does, not by what would be more consistent. If this is ever "fixed," it will require a version bump (`version` byte) and is a breaking change for anything written under v2.

### `TIMESTAMP` (`0x40`)
- 1 type-code byte + 8 bytes.
- Signed 64-bit integer, **little-endian**, representing milliseconds since Unix epoch (`Date.now()` semantics in JS).

### `STRING` / `STRING_REF` (`0x30` / `0x32`)
- 1 type-code byte + 4-byte length prefix + N bytes of UTF-8 data.
- Length prefix is **unsigned 32-bit, little-endian**, and is the **byte length** of the UTF-8 data (not character count).
- `STRING_REF` is decoded identically to `STRING` today — it's a placeholder for future string-table deduplication and carries no different meaning yet.

---

## 4. Composite Types — Current (Spec v2) Behavior

`array` and `object` field types **do not** use the reserved `ARRAY` (`0x50`) / `MAP` (`0x51`) type codes in this version. Instead:

1. The value is run through the host language's JSON serializer (`JSON.stringify` in the reference implementation).
2. The resulting JSON text is UTF-8 encoded.
3. It is written using the **`STRING`** type code (`0x30`) — i.e., identical layout to a string field: 1 byte type code, 4-byte little-endian length, then the UTF-8 JSON bytes.

On decode, any `STRING`/`STRING_REF` value whose first character is `[` or `{` is opportunistically `JSON.parse()`'d back into an array/object. **This means a plain string value that happens to start with `[` or `{` will also be silently parsed as JSON on decode** — this is a known sharp edge in the reference implementation, not a deliberate feature. Implementations should replicate this exact heuristic (check first decoded character, attempt JSON parse, fall back to raw string on parse failure) for wire compatibility, but should flag it to users as something to be careful with.

A future spec version may introduce real `ARRAY`/`MAP` binary encoding using the reserved type codes; until then, treat `array`/`object` fields as "JSON-text-wrapped-in-a-STRING".

---

## 5. Schema Semantics (relevant to wire compatibility)

These rules matter for cross-language ports because they determine *byte order on the wire*, not just in-memory representation:

- **Field order in the encoded buffer is the order the schema was declared in** (i.e., `Object.keys()` order in JS — insertion order). There is no field-name tagging inside the payload; field identity is purely positional, determined by walking the schema's declared field list in order. **A decoder must know the exact same schema (same fields, same order, same types) used to encode** — KRSON has no self-describing field names on the wire for schema-based packets (only the schemaless path embeds anything resembling self-description, and that's just raw JSON).
- **Fixed-size fields** are: `bool` (1 byte), `int32` (4 bytes), `float64` (8 bytes), `timestamp` (8 bytes). These get a precomputed byte offset *only while every preceding field in the schema is also fixed-size*. The moment a variable-size field (`varint`, `string`, `array`, `object`) appears, every field after it loses precomputed-offset status and must be reached by sequential scan from the last fixed offset.
- **`schema.get(field)` / `getMany(fields)` semantics**: jump to the last known fixed offset at or before the requested field, then sequentially decode-and-skip every field between that point and the target, finally decoding the target itself. This is *not* true random access for variable-length-prefixed schemas — it's "skip forward without materializing", which is still cheaper than full decode but isn't O(1) once a variable field precedes your target.
- The internal `schemaId` (in the 8-byte header) is assigned by each process's own in-memory registry at `defineSchema()` call time (`_nextSchemaId++`, starting at 1). **It is not stable across processes, restarts, or languages** — two processes that both call `defineSchema()` for "the same" logical schema can get different numeric IDs. Don't use `schemaId` as a cross-service schema identifier; it's only meaningful within a single running process's registry, mainly used by `prettyPrint`/`inspect` for human debugging output, not for routing/dispatch decisions.

---

## 6. Worked Example

Encoding `{ name: 'Alice', age: 30, score: 98.5, active: true }` with schema:

```
name:   string
age:    varint
score:  float64
active: bool
```

Byte-by-byte:

```
4B 52                       magic "KR"
02                          version 2
10                          flags = FLAG_HAS_SCHEMA_ID
01 00 00 00                 schemaId = 1 (little-endian)
-- field: name --
30                           type = STRING
05 00 00 00                  length = 5 (little-endian)
41 6C 69 63 65                "Alice" (UTF-8)
-- field: age --
18                           type = VARINT
1E                            30 (single varint byte, no continuation)
-- field: score --
21                           type = FLOAT64
40 58 90 00 00 00 00 00       98.5 as IEEE754 double, BIG-ENDIAN bytes
-- field: active --
02                           type = BOOL_TRUE
```

Total length: 8 (header) + 10 (name) + 2 (age) + 9 (score) + 1 (active) = 30 bytes.

Use this exact byte sequence as a conformance test fixture when building a new-language port — encode the same object in your new implementation and diff the bytes against this.

---

## 7. Conformance Checklist for New-Language Implementations

Before calling a Python/Go/Java/etc. port "wire-compatible v2", verify:

- [ ] Header is exactly 8 bytes, magic `4B 52`, version `02`
- [ ] `schemaId` written/read as **little-endian** uint32
- [ ] `int32`, `varint` magnitude bytes, and `timestamp` are **little-endian**
- [ ] `float64` is **big-endian** (yes, really — see §3)
- [ ] String/JSON length prefix is **little-endian** uint32, and is a byte length, not char count
- [ ] Varint continuation bit is `0x80`, 7 data bits per byte, least-significant group first
- [ ] `array`/`object` fields round-trip through JSON text wrapped in a `STRING` type code (not a native composite type) in this version
- [ ] Decoder reproduces the "first-char `[`/`{` triggers opportunistic JSON.parse" behavior on STRING-decoded values, including its false-positive edge case on literal strings starting with those characters
- [ ] Encoding the worked example in §6 produces the exact same 30 bytes
- [ ] `defineSchema()`-equivalent in your language assigns schema IDs locally per-process and does **not** assume they're portable across services/languages

## 8. Explicitly Out of Scope for v2

These are real gaps, listed so a Python/Go/Java port doesn't accidentally invent its own answer and create a fifth incompatible dialect:

- No real binary `ARRAY`/`MAP` encoding yet (type codes `0x50`/`0x51` reserved, unused)
- No functioning string table / interning (`FLAG_HAS_STRING_TABLE` reserved, unused; `STRING_REF` behaves like `STRING`)
- No native 64-bit integer type in active use (`INT64`, `0x13`, reserved/unused by encoders)
- No schema versioning/evolution rules (adding/removing/reordering fields breaks compatibility with old buffers — there's no field-tagging to allow safe schema evolution, unlike Protobuf)
- No cross-process/cross-language schema ID registry — schema identity today is "both sides happen to declare the same fields in the same order," nothing more

If you add any of these in a new-language implementation, it must be proposed as a **v3** wire format change here first — not silently implemented in one language's port — or you'll fragment compatibility immediately.
