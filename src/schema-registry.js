'use strict';

let _nextSchemaId = 1;
const _schemas = new Map(); // id → schema metadata

function fixedSize(type) {
  // +1 for the leading type-code byte every value carries on the wire.
  // bool needs no separate value byte (TRUE/FALSE is encoded in the
  // type-code itself), so it's exactly 1.
  switch (type) {
    case 'bool':      return 1;       // type-code only
    case 'int32':     return 1 + 4;   // type-code + int32
    case 'float64':   return 1 + 8;   // type-code + float64
    case 'timestamp': return 1 + 8;   // type-code + int64
    default:          return null;    // varint, string, array, object = variable
  }
}

// `encodeFn`/`decodeFn`/`getFn`/`getManyFn` are injected by index.js so this
// module doesn't need to know about Buffer-vs-Uint8Array specifics — it only
// owns the registry and the field-reorder/offset logic, which is identical
// for both the Node and browser builds.
function defineSchema(def, options = {}, hooks) {
  const id = _nextSchemaId++;
  const declaredFields = Object.keys(def);
  const declaredTypes  = declaredFields.map(f => def[f]);
  const useCrc = !!options.crc;

  // Fields kept the user's declared order originally. Only a *prefix* of
  // fixed-size types (bool/int32/float64/timestamp) got true O(1) offsets
  // — the moment a variable-length field (string/varint/array/object)
  // appeared, every field after it lost the fast path, even other
  // fixed-size fields declared later. That made schema.get()'s "O(1) random
  // access" claim misleading for any schema that didn't happen to list all
  // fixed-size fields first.
  //
  // Fix: reorder fields internally so ALL fixed-size fields are written
  // first (true O(1) offsets for every one of them), followed by
  // variable-length fields in their original relative order. The reorder is
  // internal/structural only — encode()/decode() still take and return
  // objects keyed by field name, so calling code is unaffected.
  const fixedIdx = [];
  const variableIdx = [];
  for (let i = 0; i < declaredFields.length; i++) {
    if (fixedSize(declaredTypes[i]) !== null) fixedIdx.push(i);
    else variableIdx.push(i);
  }
  const order = fixedIdx.concat(variableIdx);
  const fields = order.map(i => declaredFields[i]);
  const types  = order.map(i => declaredTypes[i]);

  // Precompute fixed offsets (for schema.get() fast path)
  const offsets = new Array(fields.length).fill(null);
  let cursor = 0;
  let fixedSoFar = true;

  for (let i = 0; i < fields.length; i++) {
    if (!fixedSoFar) break;
    offsets[i] = cursor;
    const sz = fixedSize(types[i]);
    if (sz === null) { fixedSoFar = false; }
    else { cursor += sz; }
  }

  const fieldIndex = {};
  fields.forEach((f, i) => fieldIndex[f] = i);

  _schemas.set(id, { id, fields, types, offsets, fieldIndex, useCrc });

  return {
    encode(obj)           { return hooks.encode(id, obj); },
    decode(buf)            { return hooks.decode(id, buf); },
    get(buf, field)        { return hooks.get(id, buf, field); },
    getMany(buf, fields)   { return hooks.getMany(id, buf, fields); },
    dispose()               { return disposeSchema(id); },
    id,
  };
}

// defineSchema() registers every schema in the module-level `_schemas` Map
// and never removes entries from it. The intended usage pattern is
// module-load-time, once-per-shape (the common, recommended way), which is
// fine — but a long-running server that *accidentally* calls defineSchema()
// per-request or per-tenant would leak memory unboundedly with no way to
// recover it. disposeSchema() lets such cases clean up explicitly.
function disposeSchema(schemaId) {
  return _schemas.delete(schemaId);
}

function getSchema(schemaId) {
  return _schemas.get(schemaId);
}

module.exports = { defineSchema, disposeSchema, getSchema, fixedSize };
