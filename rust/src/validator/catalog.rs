use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{LazyLock, Mutex};

use serde_json::Value;

use super::positions::{parse_yaml_with_positions, single_key};
use super::resolve::{default_start, find_spec_path};

#[derive(Clone, Debug)]
pub struct DefaultToken {
    pub token: String,
    pub regex: String,
}

#[derive(Clone, Debug)]
pub struct FieldType {
    pub name: String,
    pub min_value: Option<String>,
    pub max_value: Option<String>,
    pub defaults: Vec<DefaultToken>,
}

fn parse_defaults(raw: Option<&Value>) -> Vec<DefaultToken> {
    let Some(items) = raw.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in items {
        let Some((token, body)) = single_key(entry) else { continue };
        let Some(regex) = body.get("regex").and_then(Value::as_str) else { continue };
        let _ = body.get("description");
        out.push(DefaultToken {
            token,
            regex: regex.to_string(),
        });
    }
    out
}

fn bound(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Null) => None,
        _ => None,
    }
}

fn parse_type(entry: &Value) -> Option<FieldType> {
    let (name, body) = single_key(entry)?;
    let _ = body.get("supports_size");
    let _ = body.get("implicit_default");
    Some(FieldType {
        name,
        min_value: bound(body.get("min_value")),
        max_value: bound(body.get("max_value")),
        defaults: parse_defaults(body.get("defaults")),
    })
}

pub fn parse_field_type_catalog(text: &str) -> HashMap<String, FieldType> {
    let parsed = parse_yaml_with_positions(text);
    let mut out = HashMap::new();
    let Some(types) = parsed.data.get("types").and_then(Value::as_array) else {
        return out;
    };
    for entry in types {
        if let Some(field) = parse_type(entry) {
            out.insert(field.name.clone(), field);
        }
    }
    out
}

const CATALOG_KEYS: &[&str] = &[
    "supports_size",
    "implicit_default",
    "min_value",
    "max_value",
    "defaults",
];

fn assert_catalog_complete(text: &str) -> Result<(), String> {
    let parsed = parse_yaml_with_positions(text);
    let Some(types) = parsed.data.get("types").and_then(Value::as_array) else {
        return Err("field type catalog missing types array".to_string());
    };
    for entry in types {
        let Some((name, body)) = single_key(entry) else {
            return Err("field type catalog has a malformed type entry".to_string());
        };
        for key in CATALOG_KEYS {
            if body.get(*key).is_none() {
                return Err(format!("field type '{name}' is missing {key}"));
            }
        }
    }
    Ok(())
}

#[inline(never)]
pub fn load_field_type_catalog(start: &Path) -> Result<HashMap<String, FieldType>, String> {
    static CACHE: LazyLock<Mutex<HashMap<std::path::PathBuf, HashMap<String, FieldType>>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    let key = start.to_path_buf();
    let mut cache = CACHE.lock().unwrap_or_else(|err| err.into_inner());
    if let Some(hit) = cache.get(&key).cloned() {
        return Ok(hit);
    }
    let path = find_spec_path("backend", "types.yaml", start)
        .ok_or_else(|| "field type catalog not found: backend/types.yaml".to_string())?;
    let text = fs::read_to_string(path).map_err(|err| err.to_string())?;
    assert_catalog_complete(&text)?;
    let catalog = parse_field_type_catalog(&text);
    cache.insert(key, catalog.clone());
    Ok(catalog)
}

pub fn load_default_catalog() -> Result<HashMap<String, FieldType>, String> {
    load_field_type_catalog(&default_start())
}
