'use strict';

/**
 * KRSON v6 — Binary format for high-throughput systems
 * Pure JS implementation — no native dependencies, works everywhere
 *
 * This file is the public entry point: it wires together the modules in
 * src/ and exposes the documented API. The actual wire-format logic
 * (varint/zigzag math, encode/decode passes, schema registry, etc.) lives
 * in src/ — see those files for implementation details and inline
 * explanations of past bugs/fixes.
 */

const { defineSchema, disposeSchema } = require('./src/schema-registry');
const { schemaEncode, encode } = require('./src/encode');
const { schemaDecode, schemaGet, schemaGetMany, decode, get } = require('./src/decode');
const { validate } = require('./src/validate');
const { inspect: _inspectImpl, prettyPrint: _prettyPrintImpl } = require('./src/debug');

// defineSchema() needs to call back into encode/decode/get/getMany without
// src/schema-registry.js importing src/encode.js and src/decode.js directly
// (which would create a circular require: encode/decode both need
// getSchema() from the registry). Wiring the hooks here, at the top level,
// keeps the dependency graph one-directional.
const schemaHooks = {
  encode: schemaEncode,
  decode: schemaDecode,
  get: schemaGet,
  getMany: schemaGetMany,
};

function defineSchemaWired(def, options) {
  return defineSchema(def, options, schemaHooks);
}

function inspect(buf, schema) {
  return _inspectImpl(buf, schema, decode);
}

function prettyPrint(buf, schema) {
  return _prettyPrintImpl(buf, schema, decode);
}

const KRSON = {
  defineSchema: defineSchemaWired,
  disposeSchema,
  encode,
  decode,
  get,
  validate,
  inspect,
  prettyPrint,
};

module.exports = {
  KRSON,
  defineSchema: defineSchemaWired,
  disposeSchema,
  encode,
  decode,
  get,
  validate,
  inspect,
  prettyPrint,
};

// ─── npx krson inspect — CLI support ─────────────────────────────────────────

function _cliInspect() {
  const fs = require('fs');
  const file = process.argv[3];
  if (!file) { console.error('Usage: npx krson inspect <file.krson>'); process.exit(1); }
  const buf = fs.readFileSync(file);
  prettyPrint(buf, null);
}

if (require.main === module && process.argv[2] === 'inspect') {
  _cliInspect();
}
