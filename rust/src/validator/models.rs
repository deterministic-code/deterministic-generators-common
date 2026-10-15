use std::collections::HashSet;

use serde_json::Value;

use super::positions::{position_for, single_key, ParsedYaml};
use super::schema::{SpecValidationError, SpecValidationResult, ValidateOptions};

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

pub fn check_service_model(parsed: &ParsedYaml, _options: &ValidateOptions) -> SpecValidationResult {
    let mut errors = Vec::new();
    let Some(services) = parsed.data.get("services").and_then(Value::as_array) else {
        return SpecValidationResult::ok();
    };
    let mut seen = HashSet::new();
    for (i, entry) in services.iter().enumerate() {
        let Some(name) = entry.get("name").and_then(Value::as_str).filter(|name| !name.is_empty()) else {
            continue;
        };
        push_unique(&mut seen, name, &mut errors, parsed, &format!("/services/{i}/name"), format!("duplicate service '{name}'"));
    }
    SpecValidationResult::fail(errors)
}

fn route_name(entry: &Value) -> Option<(String, String)> {
    if let Some(name) = entry.as_str().filter(|name| !name.is_empty()) {
        return Some((name.to_string(), String::new()));
    }
    let (key, _) = single_key(entry)?;
    Some((key.clone(), format!("/{key}")))
}

fn dispatch_kinds(shape: &Value) -> Vec<&'static str> {
    let mut kinds = Vec::new();
    if shape.get("service").is_some() {
        kinds.push("service");
    }
    if shape.get("services").is_some() {
        kinds.push("services");
    }
    if shape.get("routeClass").is_some() || shape.get("module").is_some() {
        kinds.push("routeClass/module");
    }
    kinds
}

pub fn check_route_model(parsed: &ParsedYaml, _options: &ValidateOptions) -> SpecValidationResult {
    let mut errors = Vec::new();
    let Some(routes) = parsed.data.get("routes").and_then(Value::as_array) else {
        return SpecValidationResult::ok();
    };
    let mut seen = HashSet::new();
    for (i, entry) in routes.iter().enumerate() {
        let Some((name, suffix)) = route_name(entry) else { continue };
        let path = format!("/routes/{i}{suffix}");
        push_unique(&mut seen, &name, &mut errors, parsed, &path, format!("duplicate route '{name}'"));
        let Some((_, body)) = single_key(entry) else { continue };
        if !body.is_object() {
            continue;
        }
        let kinds = dispatch_kinds(body);
        if kinds.len() > 1 {
            errors.push(spec_err(parsed, &path, format!("custom route cannot combine {}", kinds.join(" and "))));
        }
    }
    SpecValidationResult::fail(errors)
}
