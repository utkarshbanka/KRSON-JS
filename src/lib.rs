#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;
use napi::{Env, JsUnknown, JsObject, ValueType};
use krson_core::{
    KrsonValue,
    Schema, FieldType, SchemaRegistry,
    encode_schemaless, decode_schemaless,
    encode_with_schema, decode_with_schema,
    get_field_with_schema, validate,
};
use std::sync::Mutex;

static REGISTRY: std::sync::OnceLock<Mutex<SchemaRegistry>> = std::sync::OnceLock::new();

fn registry() -> std::sync::MutexGuard<'static, SchemaRegistry> {
    REGISTRY.get_or_init(|| Mutex::new(SchemaRegistry::new()))
        .lock().unwrap()
}

fn to_napi_err(e: krson_core::KrsonError) -> napi::Error {
    napi::Error::new(Status::GenericFailure, e.to_string())
}

// ─── JSON string → KrsonValue (fastest encode path) ──────────────────────────
// Uses serde_json for parsing — pure Rust, no NAPI bridge per field
fn json_to_krson(value: &serde_json::Value) -> KrsonValue {
    match value {
        serde_json::Value::Null       => KrsonValue::Null,
        serde_json::Value::Bool(b)    => KrsonValue::Bool(*b),
        serde_json::Value::Number(n)  => {
            if let Some(i) = n.as_i64() {
                if i >= i32::MIN as i64 && i <= i32::MAX as i64 {
                    KrsonValue::VarInt(i)
                } else {
                    KrsonValue::Int64(i)
                }
            } else {
                KrsonValue::Float64(n.as_f64().unwrap_or(0.0))
            }
        }
        serde_json::Value::String(s)  => KrsonValue::String(s.clone()),
        serde_json::Value::Array(arr) => {
            KrsonValue::Array(arr.iter().map(json_to_krson).collect())
        }
        serde_json::Value::Object(obj) => {
            KrsonValue::Map(obj.iter().map(|(k, v)| (k.clone(), json_to_krson(v))).collect())
        }
    }
}

// ─── KrsonValue → JS (decode path) ───────────────────────────────────────────
fn krson_to_js(env: Env, value: &KrsonValue) -> napi::Result<JsUnknown> {
    Ok(match value {
        KrsonValue::Null          => env.get_null()?.into_unknown(),
        KrsonValue::Bool(b)       => env.get_boolean(*b)?.into_unknown(),
        KrsonValue::Int32(v)      => env.create_int32(*v)?.into_unknown(),
        KrsonValue::Int64(v)      => env.create_int64(*v)?.into_unknown(),
        KrsonValue::VarInt(v)     => env.create_int64(*v)?.into_unknown(),
        KrsonValue::Float32(v)    => env.create_double(*v as f64)?.into_unknown(),
        KrsonValue::Float64(v)    => env.create_double(*v)?.into_unknown(),
        KrsonValue::String(s)     => env.create_string(s)?.into_unknown(),
        KrsonValue::Bytes(b)      => env.create_buffer_with_data(b.clone())?.into_unknown(),
        KrsonValue::Timestamp(v)  => env.create_int64(*v)?.into_unknown(),
        KrsonValue::Date(v)       => env.create_int32(*v)?.into_unknown(),
        KrsonValue::Array(arr)    => {
            let mut js_arr: JsObject = env.create_array_with_length(arr.len())?;
            for (i, item) in arr.iter().enumerate() {
                js_arr.set_element(i as u32, krson_to_js(env, item)?)?;
            }
            js_arr.into_unknown()
        }
        KrsonValue::Map(fields)   => {
            let mut obj: JsObject = env.create_object()?;
            for (k, v) in fields {
                obj.set_named_property(k, krson_to_js(env, v)?)?;
            }
            obj.into_unknown()
        }
    })
}

// ─── KrsonValue → JSON string (fastest decode path) ──────────────────────────
// Returns JSON string — JS side uses JSON.parse() which is pure V8
fn krson_to_json_str(value: &KrsonValue) -> String {
    match value {
        KrsonValue::Null          => "null".to_string(),
        KrsonValue::Bool(b)       => b.to_string(),
        KrsonValue::Int32(v)      => v.to_string(),
        KrsonValue::Int64(v)      => v.to_string(),
        KrsonValue::VarInt(v)     => v.to_string(),
        KrsonValue::Float32(v)    => v.to_string(),
        KrsonValue::Float64(v)    => {
            // Ensure decimal point for JS float
            let s = v.to_string();
            if s.contains('.') { s } else { format!("{}.0", s) }
        }
        KrsonValue::String(s)     => {
            // Escape JSON string
            let escaped = s.replace('\\', "\\\\").replace('"', "\\\"")
                .replace('\n', "\\n").replace('\r', "\\r").replace('\t', "\\t");
            format!("\"{}\"", escaped)
        }
        KrsonValue::Bytes(_)      => "null".to_string(),
        KrsonValue::Timestamp(v)  => v.to_string(),
        KrsonValue::Date(v)       => v.to_string(),
        KrsonValue::Array(arr)    => {
            let items: Vec<String> = arr.iter().map(krson_to_json_str).collect();
            format!("[{}]", items.join(","))
        }
        KrsonValue::Map(fields)   => {
            let items: Vec<String> = fields.iter()
                .map(|(k, v)| format!("\"{}\":{}", k, krson_to_json_str(v)))
                .collect();
            format!("{{{}}}", items.join(","))
        }
    }
}

fn parse_field_type(s: &str) -> FieldType { FieldType::from_str(s) }

// ─── NAPI exports ─────────────────────────────────────────────────────────────

#[napi]
pub fn define_schema(_env: Env, def: JsObject) -> Result<u32> {
    let keys = def.get_property_names()?;
    let key_len = keys.get_array_length()?;
    let mut builder = Schema::builder();
    for i in 0..key_len {
        let key: napi::JsString = keys.get_element(i)?;
        let key_str = key.into_utf8()?.into_owned()?;
        let type_str: napi::JsString = def.get_named_property(&key_str)?;
        let type_s = type_str.into_utf8()?.into_owned()?;
        builder = builder.field(&key_str, parse_field_type(&type_s));
    }
    let schema = builder.build();
    let id = registry().register(schema);
    Ok(id)
}

/// schemaEncodeJson(id, jsonString) → Buffer  ← FASTEST ENCODE PATH
/// Call as: schema.encode(obj) where wrapper does JSON.stringify first
#[napi]
pub fn schema_encode_json(schema_id: u32, json_str: String) -> Result<Buffer> {
    let json_val: serde_json::Value = serde_json::from_str(&json_str)
        .map_err(|e| napi::Error::new(Status::InvalidArg, format!("invalid JSON: {e}")))?;

    let krson_val = json_to_krson(&json_val);
    let fields = match krson_val {
        KrsonValue::Map(f) => f,
        _ => return Err(napi::Error::new(Status::InvalidArg, "expected object")),
    };

    let reg = registry();
    let schema = reg.get(schema_id).map_err(to_napi_err)?;
    let buf = encode_with_schema(schema, &fields).map_err(to_napi_err)?;
    Ok(buf.into())
}

/// schemaDecode → JSON string (JS does JSON.parse) ← FASTEST DECODE PATH
#[napi]
pub fn schema_decode_json(schema_id: u32, buf: Buffer) -> Result<String> {
    let reg = registry();
    let schema = reg.get(schema_id).map_err(to_napi_err)?;
    let fields = decode_with_schema(schema, &buf).map_err(to_napi_err)?;
    let map = KrsonValue::Map(fields);
    Ok(krson_to_json_str(&map))
}

/// schemaGet → single field value as JS (50ns Rust side!)
#[napi]
pub fn schema_get(env: Env, schema_id: u32, buf: Buffer, field_name: String) -> Result<JsUnknown> {
    let reg = registry();
    let schema = reg.get(schema_id).map_err(to_napi_err)?;
    let value = get_field_with_schema(schema, &buf, &field_name).map_err(to_napi_err)?;
    krson_to_js(env, &value)
}

/// encodeJson(jsonString) → Buffer [schemaless, fast path]
#[napi]
pub fn encode_json(json_str: String) -> Result<Buffer> {
    let json_val: serde_json::Value = serde_json::from_str(&json_str)
        .map_err(|e| napi::Error::new(Status::InvalidArg, format!("invalid JSON: {e}")))?;
    let krson_val = json_to_krson(&json_val);
    let buf = encode_schemaless(&krson_val).map_err(to_napi_err)?;
    Ok(buf.into())
}

/// decodeToJson(buf) → JSON string [schemaless, fast path]
#[napi]
pub fn decode_to_json(buf: Buffer) -> Result<String> {
    let value = decode_schemaless(&buf).map_err(to_napi_err)?;
    Ok(krson_to_json_str(&value))
}

/// validate
#[napi]
pub fn validate_buf(buf: Buffer) -> bool {
    validate(&buf)
}
