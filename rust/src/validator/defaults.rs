use serde_json::Value;

use super::catalog::{load_default_catalog, FieldType};
use super::positions::{position_for, single_key, ParsedYaml};
use super::schema::{SpecValidationError, SpecValidationResult, ValidateOptions};

fn err(parsed: &ParsedYaml, path: &str, message: impl Into<String>) -> SpecValidationError {
    let (line, col) = position_for(parsed, path);
    SpecValidationError {
        line,
        col,
        instance_path: path.to_string(),
        message: message.into(),
    }
}

fn visit_field_def(data: &Value, mut visit: impl FnMut(&str, &Value)) {
    if let Some(types) = data.get("types").and_then(Value::as_array) {
        for (ti, entry) in types.iter().enumerate() {
            let Some((table, body)) = single_key(entry) else { continue };
            let Some(fields) = body.get("fields").and_then(Value::as_array) else { continue };
            for (fi, field) in fields.iter().enumerate() {
                let Some((name, def)) = single_key(field) else { continue };
                if def.is_object() {
                    visit(&format!("/types/{ti}/{table}/fields/{fi}/{name}"), def);
                }
            }
        }
    }
    let Some(includes) = data.get("includes").and_then(Value::as_array) else {
        return;
    };
    for (ii, inc) in includes.iter().enumerate() {
        let Some(opts) = inc.get("combine_options").filter(|value| value.is_object()) else {
            continue;
        };
        for side in ["source", "destination"] {
            let Some(side_opts) = opts.get(side).filter(|value| value.is_object()) else {
                continue;
            };
            if let Some(modify) = side_opts.get("modify_fields").and_then(Value::as_array) {
                for (mi, op) in modify.iter().enumerate() {
                    if let Some(def) = op.get("def").filter(|value| value.is_object()) {
                        visit(
                            &format!("/includes/{ii}/combine_options/{side}/modify_fields/{mi}/def"),
                            def,
                        );
                    }
                }
            }
            let Some(add) = side_opts.get("add_fields").and_then(Value::as_array) else {
                continue;
            };
            for (ai, op) in add.iter().enumerate() {
                let Some(add_field) = op.get("add_field").filter(|value| value.is_object()) else {
                    continue;
                };
                let Some((name, def)) = single_key(add_field) else { continue };
                if def.is_object() {
                    visit(
                        &format!("/includes/{ii}/combine_options/{side}/add_fields/{ai}/add_field/{name}"),
                        def,
                    );
                }
            }
        }
    }
}

fn token_error(catalog: &FieldType, value: &str) -> Option<String> {
    if catalog.defaults.is_empty() {
        return None;
    }
    if catalog.defaults.iter().any(|tok| regex::Regex::new(&tok.regex).is_ok_and(|re| re.is_match(value))) {
        return None;
    }
    let allowed = catalog
        .defaults
        .iter()
        .map(|tok| tok.token.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!(
        "default_value '{value}' is not a valid {} default — allowed forms: {allowed}",
        catalog.name
    ))
}

fn range_error(catalog: &FieldType, value: &Value) -> Option<String> {
    if catalog.min_value.is_none() && catalog.max_value.is_none() {
        return None;
    }
    if value.is_null() {
        return None;
    }
    let raw = match value {
        Value::String(text) => text.clone(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    if !regex::Regex::new(r"^-?\d+$").unwrap().is_match(&raw) {
        return None;
    }
    let n: i128 = raw.parse().ok()?;
    let min = catalog.min_value.as_deref().and_then(|text| text.parse::<i128>().ok());
    let max = catalog.max_value.as_deref().and_then(|text| text.parse::<i128>().ok());
    if min.is_some_and(|min| n < min) || max.is_some_and(|max| n > max) {
        return Some(format!(
            "default_value '{raw}' is out of range for {} (allowed {}..{})",
            catalog.name,
            catalog.min_value.as_deref().unwrap_or(""),
            catalog.max_value.as_deref().unwrap_or("")
        ));
    }
    None
}

pub fn check_field_default_semantics(parsed: &ParsedYaml, _options: &ValidateOptions) -> SpecValidationResult {
    let catalog = load_default_catalog().unwrap_or_default();
    let mut errors = Vec::new();
    visit_field_def(&parsed.data, |base, def| {
        if !def.as_object().is_some_and(|map| map.contains_key("default_value")) {
            return;
        }
        let Some(type_name) = def.get("type").and_then(Value::as_str) else {
            return;
        };
        let Some(field) = catalog.get(type_name) else {
            return;
        };
        let value = &def["default_value"];
        let path = format!("{base}/default_value");
        if let Some(text) = value.as_str() {
            if let Some(message) = token_error(field, text) {
                errors.push(err(parsed, &path, message));
            }
        }
        if type_name == "character" {
            if let Some(text) = value.as_str() {
                let size = def.get("size").and_then(Value::as_f64).unwrap_or(1.0) as usize;
                if text.chars().count() != size {
                    errors.push(err(
                        parsed,
                        &path,
                        format!("character default_value length must equal size ({size})"),
                    ));
                }
            }
        }
        if let Some(message) = range_error(field, value) {
            errors.push(err(parsed, &path, message));
        }
    });
    SpecValidationResult::fail(errors)
}
