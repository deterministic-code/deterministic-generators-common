use std::collections::HashSet;
use std::path::Path;

use serde_json::Value;

use crate::compile_filter::FilterCandidate;

use super::include::match_types_filter;
use super::positions::{entries, parse_yaml_with_positions, position_for, single_key, ParsedYaml};
use super::schema::{read_if_present, SpecValidationError, SpecValidationResult, SpecValidator, ValidateOptions};
use super::type_model::index_type_fields;

const AUTO: &[&str] = &["id", "created", "updated"];
const STRINGS: &[&str] = &["string", "character", "datetime", "uuid", "binary"];
const NUMBERS: &[&str] = &["number", "integer", "unsignedinteger", "smallinteger", "unsignedsmallinteger", "float"];
const STRING_OR_NUMBER: &[&str] = &["biginteger", "unsignedbiginteger", "decimal"];
const INTEGERS: &[&str] = &["integer", "unsignedinteger", "smallinteger", "unsignedsmallinteger"];
const UNSIGNED: &[&str] = &["unsignedinteger", "unsignedbiginteger", "unsignedsmallinteger"];

fn err(parsed: &ParsedYaml, path: &str, message: impl Into<String>) -> SpecValidationError {
    let (line, col) = position_for(parsed, path);
    SpecValidationError {
        line,
        col,
        instance_path: path.to_string(),
        message: message.into(),
    }
}

pub fn with_sibling_companions(path: &str, options: &ValidateOptions) -> ValidateOptions {
    let mut next = options.clone();
    let dir = Path::new(path).parent().unwrap_or(Path::new("."));
    if next.types.is_none() {
        next.types = if let Some(types_path) = &next.types_path {
            std::fs::read_to_string(types_path).ok()
        } else {
            read_if_present(&dir.join("types.yaml"))
        };
    }
    if next.datasource.is_none() {
        next.datasource = if let Some(datasource_path) = &next.datasource_path {
            std::fs::read_to_string(datasource_path).ok()
        } else {
            read_if_present(&dir.join("datasource.yaml"))
        };
    }
    next
}

pub fn seeds_need_companions(data: &Value) -> bool {
    !data.get("seeds").and_then(Value::as_array).is_none_or(|items| items.is_empty())
}

fn companion_error(parsed: &ParsedYaml, message: impl Into<String>) -> SpecValidationResult {
    SpecValidationResult::fail(vec![err(parsed, "/seeds", message)])
}

pub fn check_seeds(parsed: &ParsedYaml, options: &ValidateOptions) -> SpecValidationResult {
    let Some(types_text) = &options.types else {
        if !seeds_need_companions(&parsed.data) {
            return SpecValidationResult::ok();
        }
        return companion_error(
            parsed,
            "types.yaml is required to validate seeds (pass types, or place types.yaml next to the seeds file)",
        );
    };
    let types_result = SpecValidator::from_ref("backend", "types.spec.yaml").validate(types_text, &ValidateOptions::default());
    if !types_result.valid {
        let message = types_result.errors.first().map(|err| err.message.as_str()).unwrap_or("");
        return companion_error(parsed, format!("companion types.yaml is invalid: {message}"));
    }
    if let Some(datasource_text) = &options.datasource {
        let datasource_result = SpecValidator::from_ref("backend", "datasource.spec.yaml").validate(datasource_text, &ValidateOptions::default());
        if !datasource_result.valid {
            let message = datasource_result.errors.first().map(|err| err.message.as_str()).unwrap_or("");
            return companion_error(parsed, format!("companion datasource.yaml is invalid: {message}"));
        }
    }
    let types_data = parse_yaml_with_positions(types_text).data;
    let datasource_data = options.datasource.as_deref().map(|text| parse_yaml_with_positions(text).data);
    check_seed_semantics(parsed, &types_data, datasource_data.as_ref())
}

fn table_names(data: &Value) -> HashSet<String> {
    data.get("types")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| single_key(entry).map(|(name, _)| name))
        .collect()
}

fn types_filter(data: &Value) -> Option<String> {
    data.get("includes")
        .and_then(Value::as_array)?
        .iter()
        .find_map(|entry| {
            entry
                .get("types")
                .and_then(|types| types.get("filter"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

fn allowed_tables(types_data: &Value, datasource: Option<&Value>) -> Option<HashSet<String>> {
    let datasource = datasource?;
    let Some(filter) = types_filter(datasource) else {
        return Some(table_names(datasource));
    };
    let mut allowed = HashSet::new();
    let Some(types) = types_data.get("types").and_then(Value::as_array) else {
        return Some(allowed);
    };
    for entry in types {
        let Some((name, body)) = single_key(entry) else { continue };
        let tags = body
            .get("tags")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let cand = FilterCandidate {
            name: name.clone(),
            tags,
            inherits: body.get("inherits").and_then(Value::as_str).map(str::to_string),
        };
        if match_types_filter(Some(&filter), &cand) {
            allowed.insert(name);
        }
    }
    Some(allowed)
}

#[inline(never)]
fn field_type_name(def: &Value, tables: &indexmap::IndexMap<String, indexmap::IndexMap<String, Value>>) -> Option<String> {
    if let Some(ty) = def.get("type").and_then(Value::as_str) {
        return Some(ty.to_string());
    }
    let reference = def.get("references").and_then(Value::as_str)?;
    let (table, column) = reference.split_once('.')?;
    if table.is_empty() || column.is_empty() {
        return None;
    }
    if column == "id" {
        return Some("number".into());
    }
    tables
        .get(table)
        .and_then(|fields| fields.get(column))
        .and_then(|parent| parent.get("type"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| Some("number".into()))
}

#[inline(never)]
fn type_message(name: &str) -> &'static str {
    if STRINGS.contains(&name) {
        "string"
    } else if name == "boolean" {
        "boolean"
    } else if STRING_OR_NUMBER.contains(&name) {
        "string or number"
    } else if INTEGERS.contains(&name) {
        "integer"
    } else {
        "number"
    }
}

#[inline(never)]
fn value_matches(value: &Value, name: &str) -> bool {
    if STRINGS.contains(&name) {
        return value.is_string();
    }
    if name == "boolean" {
        return value.is_boolean();
    }
    if STRING_OR_NUMBER.contains(&name) {
        if value.is_string() {
            return true;
        }
        let Some(n) = value.as_f64() else { return false };
        if UNSIGNED.contains(&name) && n < 0.0 {
            return false;
        }
        return true;
    }
    if !NUMBERS.contains(&name) {
        return true;
    }
    let Some(n) = value.as_f64() else { return false };
    if INTEGERS.contains(&name) && n.fract() != 0.0 {
        return false;
    }
    if UNSIGNED.contains(&name) && n < 0.0 {
        return false;
    }
    true
}

fn check_seed_semantics(parsed: &ParsedYaml, types_data: &Value, datasource: Option<&Value>) -> SpecValidationResult {
    let tables = index_type_fields(types_data);
    let allowed = allowed_tables(types_data, datasource);
    let Some(seeds) = parsed.data.get("seeds").and_then(Value::as_array) else {
        return SpecValidationResult::ok();
    };
    let mut errors = Vec::new();
    let mut seen_tables = HashSet::new();
    for (table_index, entry) in seeds.iter().enumerate() {
        let Some((table_name, rows_value)) = single_key(entry) else { continue };
        let table_path = format!("/seeds/{table_index}/{table_name}");
        if !seen_tables.insert(table_name.clone()) {
            errors.push(err(parsed, &table_path, format!("duplicate seed table '{table_name}'")));
            continue;
        }
        if allowed.as_ref().is_some_and(|set| !set.contains(&table_name)) {
            errors.push(err(parsed, &table_path, format!("unknown type '{table_name}' (not in datasource.yaml)")));
            continue;
        }
        let Some(fields) = tables.get(&table_name) else {
            errors.push(err(parsed, &table_path, format!("unknown type '{table_name}' (not in types.yaml)")));
            continue;
        };
        let Some(rows) = rows_value.as_array() else { continue };
        let mut seen_ids = HashSet::new();
        for (row_index, row_wrap) in rows.iter().enumerate() {
            let Some((row_id, row_body)) = single_key(row_wrap) else { continue };
            let row_path = format!("{table_path}/{row_index}/{row_id}");
            if !seen_ids.insert(row_id.clone()) {
                errors.push(err(parsed, &row_path, format!("duplicate seed id '{row_id}'")));
                continue;
            }
            let row = if row_body.is_object() { row_body } else { &Value::Null };
            if let Some(pairs) = entries(row) {
                for (key, value) in pairs {
                    let field_path = format!("{row_path}/{key}");
                    if AUTO.contains(&key.as_str()) {
                        errors.push(err(parsed, &field_path, format!("'{key}' is auto-injected and is not seeded here")));
                        continue;
                    }
                    let Some(def) = fields.get(&key) else {
                        errors.push(err(parsed, &field_path, format!("unknown field '{key}' on {table_name}")));
                        continue;
                    };
                    if value.is_null() {
                        if def.get("is_nullable") != Some(&Value::Bool(true)) {
                            errors.push(err(parsed, &field_path, format!("'{key}' is not nullable")));
                        }
                        continue;
                    }
                    if let Some(declared) = field_type_name(def, &tables) {
                        if !value_matches(value, &declared) {
                            errors.push(err(parsed, &field_path, format!("'{key}' must be {}", type_message(&declared))));
                        }
                    }
                }
            }
            if let Some(pairs) = entries(row) {
                for (name, def) in fields {
                    if AUTO.contains(&name.as_str()) {
                        continue;
                    }
                    let present = pairs.iter().any(|(key, _)| key == name);
                    let omittable = def.get("is_nullable") == Some(&Value::Bool(true))
                        || def.as_object().is_some_and(|map| map.contains_key("default_value"))
                        || def.as_object().is_some_and(|map| map.is_empty());
                    if present || omittable {
                        continue;
                    }
                    errors.push(err(
                        parsed,
                        &row_path,
                        format!("missing required field '{name}' on {table_name} (not nullable and has no default)"),
                    ));
                }
            }
        }
    }
    SpecValidationResult::fail(errors)
}
