use std::collections::{HashMap, HashSet};
use std::path::Path;

use indexmap::IndexMap;
use serde_json::Value;

use super::include::with_include_file_path;
use super::positions::{position_for, single_key, ParsedYaml};
use super::schema::{read_if_present, SpecValidationError, SpecValidationResult, ValidateOptions};
use super::type_model::index_type_fields;

fn spec_err(parsed: &ParsedYaml, path: &str, message: impl Into<String>) -> SpecValidationError {
    let (line, col) = position_for(parsed, path);
    SpecValidationError {
        line,
        col,
        instance_path: path.to_string(),
        message: message.into(),
    }
}

fn push_unique(
    seen: &mut HashSet<String>,
    name: &str,
    errors: &mut Vec<SpecValidationError>,
    parsed: &ParsedYaml,
    path: &str,
    message: String,
) -> bool {
    if !seen.insert(name.to_string()) {
        errors.push(spec_err(parsed, path, message));
        false
    } else {
        true
    }
}

pub fn with_sibling_types(path: &str, options: &ValidateOptions) -> ValidateOptions {
    let mut next = with_include_file_path(path, options);
    if next.types.is_none() {
        next.types = if let Some(types_path) = &next.types_path {
            std::fs::read_to_string(types_path).ok()
        } else {
            read_if_present(&Path::new(path).parent().unwrap_or(Path::new(".")).join("types.yaml"))
        };
    }
    next
}

pub fn check_datasource(parsed: &ParsedYaml, options: &ValidateOptions) -> SpecValidationResult {
    let companion = options.types.as_deref().map(|text| super::positions::parse_yaml_with_positions(text).data);
    check_datasource_model(parsed, companion.as_ref())
}

fn check_datasource_model(parsed: &ParsedYaml, companion: Option<&Value>) -> SpecValidationResult {
    let (tables, mut errors) = collect_tables(parsed);
    let companion_fields = companion.map(index_type_fields);
    errors.extend(check_indexes(parsed, &tables, companion_fields.as_ref()));
    if let Some(companion) = companion {
        errors.extend(check_companion_types(parsed, companion));
        errors.extend(check_occ_companion(parsed, companion));
    }
    SpecValidationResult::fail(errors)
}

#[inline(never)]
fn collect_tables(parsed: &ParsedYaml) -> (HashMap<String, (String, IndexMap<String, String>)>, Vec<SpecValidationError>) {
    let mut errors = Vec::new();
    let mut tables = HashMap::new();
    if let Some(types) = parsed.data.get("types").and_then(Value::as_array) {
    let mut seen = HashSet::new();
    for (ti, entry) in types.iter().enumerate() {
        let Some((key, body)) = single_key(entry) else { continue };
        let table_path = format!("/types/{ti}/{key}");
        if !push_unique(&mut seen, &key, &mut errors, parsed, &table_path, format!("duplicate type '{key}'")) {
            continue;
        }
        let def = if body.is_object() { body } else { &Value::Null };
        let mut fields = IndexMap::new();
        let mut occ_count = 0;
        if let Some(list) = def.get("fields").and_then(Value::as_array) {
            let mut seen_fields = HashSet::new();
            for (fi, field) in list.iter().enumerate() {
                let Some((field_name, field_body)) = single_key(field) else { continue };
                let field_path = format!("{table_path}/fields/{fi}/{field_name}");
                if !push_unique(
                    &mut seen_fields,
                    &field_name,
                    &mut errors,
                    parsed,
                    &field_path,
                    format!("duplicate field '{field_name}' on {key}"),
                ) {
                    continue;
                }
                let fdef = if field_body.is_object() { field_body } else { &Value::Null };
                if fdef.get("is_fixed_id") == Some(&Value::Bool(true)) && fdef.get("is_readonly") != Some(&Value::Bool(true)) {
                    errors.push(spec_err(parsed, &format!("{field_path}/is_fixed_id"), format!("is_fixed_id on '{field_name}' requires is_readonly: true")));
                }
                if fdef.get("use_native_row_version") == Some(&Value::Bool(true))
                    && fdef.get("is_optimistic_concurrency") != Some(&Value::Bool(true))
                {
                    errors.push(spec_err(
                        parsed,
                        &format!("{field_path}/use_native_row_version"),
                        format!("use_native_row_version on '{field_name}' requires is_optimistic_concurrency: true"),
                    ));
                }
                if fdef.get("is_optimistic_concurrency") == Some(&Value::Bool(true)) {
                    occ_count += 1;
                }
                fields.insert(field_name, field_path);
            }
        }
        if occ_count > 1 {
            errors.push(spec_err(parsed, &table_path, format!("at most one is_optimistic_concurrency field on {key}")));
        }
        tables.insert(key, (table_path, fields));
    }
    }
    (tables, errors)
}

#[inline(never)]
fn check_indexes(
    parsed: &ParsedYaml,
    tables: &HashMap<String, (String, IndexMap<String, String>)>,
    companion: Option<&IndexMap<String, IndexMap<String, Value>>>,
) -> Vec<SpecValidationError> {
    let mut errors = Vec::new();
    if let Some(types) = parsed.data.get("types").and_then(Value::as_array) {
    for (ti, entry) in types.iter().enumerate() {
        let Some((key, body)) = single_key(entry) else { continue };
        let Some(indexes) = body.get("indexes").and_then(Value::as_array) else { continue };
        let table_path = format!("/types/{ti}/{key}");
        let mut known = HashSet::new();
        if let Some((_, fields)) = tables.get(&key) {
            known.extend(fields.keys().cloned());
        }
        if let Some(fields) = companion.and_then(|map| map.get(&key)) {
            known.extend(fields.keys().cloned());
        }
        let mut seen = HashSet::new();
        for (ii, index) in indexes.iter().enumerate() {
            let Some((index_name, index_body)) = single_key(index) else { continue };
            let index_path = format!("{table_path}/indexes/{ii}/{index_name}");
            if !push_unique(&mut seen, &index_name, &mut errors, parsed, &index_path, format!("duplicate index '{index_name}' on {key}")) {
                continue;
            }
            let Some(cols) = index_body.get("fields").and_then(Value::as_array) else { continue };
            for (ci, col) in cols.iter().enumerate() {
                let Some(col) = col.as_str() else { continue };
                if known.contains(col) {
                    continue;
                }
                errors.push(spec_err(
                    parsed,
                    &format!("{index_path}/fields/{ci}"),
                    format!("unknown field '{col}' on {key} in index '{index_name}'"),
                ));
            }
        }
    }
    }
    errors
}

#[inline(never)]
fn check_companion_types(parsed: &ParsedYaml, companion: &Value) -> Vec<SpecValidationError> {
    let mut errors = Vec::new();
    let type_fields = index_type_fields(companion);
    if let Some(types) = parsed.data.get("types").and_then(Value::as_array) {
        for (ti, entry) in types.iter().enumerate() {
            let Some((key, body)) = single_key(entry) else { continue };
            let table_path = format!("/types/{ti}/{key}");
            let Some(known) = type_fields.get(&key) else {
                errors.push(spec_err(parsed, &table_path, format!("unknown type '{key}' (not in types.yaml)")));
                continue;
            };
            let Some(fields) = body.get("fields").and_then(Value::as_array) else { continue };
            for (fi, field) in fields.iter().enumerate() {
                let Some((field_name, _)) = single_key(field) else { continue };
                if known.contains_key(&field_name) {
                    continue;
                }
                errors.push(spec_err(
                    parsed,
                    &format!("{table_path}/fields/{fi}/{field_name}"),
                    format!("unknown field '{field_name}' on {key} (not in types.yaml)"),
                ));
            }
        }
    }
    errors
}

const OCC_TYPES: &[&str] = &["integer", "number", "datetime", "binary"];

#[inline(never)]
fn inherit_by_type(companion: &Value) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Some(list) = companion.get("types").and_then(Value::as_array) {
    for entry in list {
        let Some((key, body)) = single_key(entry) else { continue };
        if let Some(inherits) = body.get("inherits").and_then(Value::as_str) {
            out.insert(key, inherits.to_string());
        }
    }
    }
    out
}

#[inline(never)]
fn companion_field_type(
    fields: &IndexMap<String, IndexMap<String, Value>>,
    inherits: &HashMap<String, String>,
    type_name: &str,
    field_name: &str,
) -> Option<String> {
    let mut current = Some(type_name.to_string());
    let mut seen = HashSet::new();
    while let Some(name) = current {
        if !seen.insert(name.clone()) {
            break;
        }
        if let Some(ty) = fields.get(&name).and_then(|map| map.get(field_name)).and_then(|def| def.get("type")).and_then(Value::as_str) {
            return Some(ty.to_string());
        }
        current = inherits.get(&name).cloned();
    }
    None
}

#[inline(never)]
fn check_occ_companion(parsed: &ParsedYaml, companion: &Value) -> Vec<SpecValidationError> {
    let mut errors = Vec::new();
    let fields = index_type_fields(companion);
    let inherits = inherit_by_type(companion);
    if let Some(types) = parsed.data.get("types").and_then(Value::as_array) {
    for (ti, entry) in types.iter().enumerate() {
        let Some((key, body)) = single_key(entry) else { continue };
        let Some(list) = body.get("fields").and_then(Value::as_array) else { continue };
        let known = fields.get(&key);
        for (fi, field) in list.iter().enumerate() {
            let Some((field_name, field_body)) = single_key(field) else { continue };
            if field_body.get("is_optimistic_concurrency") != Some(&Value::Bool(true)) {
                continue;
            }
            let field_path = format!("/types/{ti}/{key}/fields/{fi}/{field_name}");
            if known.is_none_or(|map| !map.contains_key(&field_name)) {
                errors.push(spec_err(parsed, &field_path, format!("unknown field '{field_name}' on {key} (not in types.yaml)")));
                continue;
            }
            let field_type = companion_field_type(&fields, &inherits, &key, &field_name);
            if field_type.as_ref().is_some_and(|ty| !OCC_TYPES.contains(&ty.as_str())) {
                errors.push(spec_err(
                    parsed,
                    &field_path,
                    format!("is_optimistic_concurrency field '{field_name}' on {key} must be integer, number, datetime, or binary"),
                ));
            }
            if field_body.get("use_native_row_version") == Some(&Value::Bool(true)) && field_type.as_deref() != Some("binary") {
                errors.push(spec_err(
                    parsed,
                    &format!("{field_path}/use_native_row_version"),
                    format!("use_native_row_version on '{field_name}' requires a binary field"),
                ));
            }
        }
    }
    }
    errors
}
