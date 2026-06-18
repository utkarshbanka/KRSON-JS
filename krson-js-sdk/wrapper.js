'use strict';
const native = require('./index.js');

function defineSchema(def) {
  const id = native.defineSchema(def);
  return {
    encode(obj)     { return native.schemaEncodeJson(id, JSON.stringify(obj)); },
    decode(buf)     { return JSON.parse(native.schemaDecodeJson(id, buf)); },
    get(buf, field) { return native.schemaGet(id, buf, field); },
    id,
  };
}

function encode(obj)   { return native.encodeJson(JSON.stringify(obj)); }
function decode(buf)   { return JSON.parse(native.decodeToJson(buf)); }
function validate(buf) { return native.validateBuf(buf); }

const KRSON = { defineSchema, encode, decode, validate };
module.exports = { KRSON };