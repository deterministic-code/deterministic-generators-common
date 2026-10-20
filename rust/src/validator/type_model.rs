use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use serde_json::Value;

use super::positions::{entries, single_key, string_list, ParsedYaml};
use super::schema::{SpecValidationError, SpecValidationResult};

fn spec_err(parsed: &ParsedYaml, instance_path: &str, message: impl Into<String>) -> SpecValidationError {
    let (line, col) = super::positions::position_for(parsed, instance_path);
    SpecValidationError {
        line,
        col,
        instance_path: instance_path.to_string(),
        message: message.into(),
    }
}

fn push_unique(
    seen: &mut HashSet<String>,
    name: &str,
    errors: &mut Vec<SpecValidationError>,
    parsed: &ParsedYaml,
    instance_path: &str,
    message: String,
) -> bool {
    if seen.contains(name) {
        errors.push(spec_err(parsed, instance_path, message));
        return false;
    }
    seen.insert(name.to_string());
    true
}

#[derive(Clone, Debug)]
enum FieldRef {
    One(String),
    Pair(String, String),
}

#[derive(Clone, Debug)]
struct SourcedName {
    source: String,
    name: String,
    original: String,
}

#[derive(Clone, Debug)]
struct TypeInfo {
    path: String,
    tags: Vec<String>,
    inherits: Option<String>,
    union: Option<Vec<String>>,
    mapping: Option<HashMap<String, String>>,
    mapping_path: Option<String>,
    extract: Option<Vec<String>>,
    extract_path: Option<String>,
    remove_fields: Option<Vec<String>>,
    remove_fields_path: Option<String>,
    ids: Option<Vec<String>>,
    id_fields: Vec<String>,
    fields: IndexMap<String, String>,
    field_types: HashMap<String, String>,
    field_references: HashMap<String, FieldRef>,
}

fn built_in(name: &str) -> Option<Vec<String>> {
    match name {
        "set" => Some(vec!["id".into()]),
        "dictionary" => Some(vec![]),
        _ => None,
    }
}

fn type_kind_inherit(def: &Value) -> bool {
    def.get("inherits").and_then(Value::as_str).is_some()
}

fn mapping_of(def: &Value) -> Option<HashMap<String, String>> {
    let Some(list) = def.get("mapping").and_then(entries) else {
        return None;
    };
    let mut out = HashMap::new();
    for (key, value) in list {
        if let Some(text) = value.as_str() {
            out.insert(key, text.to_string());
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

fn references_of(body: &Value) -> Option<FieldRef> {
    let raw = body.get("references")?;
    if let Some(text) = raw.as_str() {
        return Some(FieldRef::One(text.to_string()));
    }
    if let Some(items) = raw.as_array() {
        if items.len() == 2 && items.iter().all(|item| item.is_string()) {
            return Some(FieldRef::Pair(
                items[0].as_str().unwrap().to_string(),
                items[1].as_str().unwrap().to_string(),
            ));
        }
    }
    None
}

fn split_remove_field(entry: &str) -> (Option<String>, String) {
    match entry.split_once('.') {
        Some((source, name)) => (Some(source.to_string()), name.to_string()),
        None => (None, entry.to_string()),
    }
}

fn ref_parts(raw: &FieldRef) -> Vec<(String, String)> {
    let items: Vec<&str> = match raw {
        FieldRef::One(text) => vec![text],
        FieldRef::Pair(left, right) => vec![left, right],
    };
    items
        .into_iter()
        .map(|item| {
            let (source, name) = split_remove_field(item);
            (source.unwrap_or_default(), name)
        })
        .collect()
}

fn has_authored_identity(info: &TypeInfo) -> bool {
    info.ids.as_ref().is_some_and(|ids| !ids.is_empty()) || !info.id_fields.is_empty()
}

fn identity_names(name: &str, types: &IndexMap<String, TypeInfo>, stack: &mut HashSet<String>) -> HashSet<String> {
    if stack.contains(name) {
        return HashSet::new();
    }
    let Some(info) = types.get(name) else {
        return HashSet::new();
    };
    if let Some(ids) = &info.ids {
        if !ids.is_empty() {
            return ids.iter().cloned().collect();
        }
    }
    if !info.id_fields.is_empty() {
        return info.id_fields.iter().cloned().collect();
    }
    if info.inherits.as_deref() == Some("set") {
        return HashSet::from(["id".to_string()]);
    }
    if let Some(inherits) = &info.inherits {
        if inherits != "dictionary" {
            stack.insert(name.to_string());
            return identity_names(inherits, types, stack);
        }
    }
    HashSet::new()
}

fn is_owner_identity_ref(raw: &FieldRef, self_name: &str, types: &IndexMap<String, TypeInfo>) -> bool {
    let parts = ref_parts(raw);
    let Some(owner) = parts.first().map(|(ty, _)| ty.clone()) else {
        return false;
    };
    if owner.is_empty() || owner == self_name || !types.contains_key(&owner) {
        return false;
    }
    let identity = identity_names(&owner, types, &mut HashSet::new());
    parts.iter().all(|(ty, field)| ty == &owner && identity.contains(field))
}

fn object_body(value: &Value) -> Option<&Value> {
    if value.is_object() { Some(value) } else { None }
}

fn collect_types(parsed: &ParsedYaml) -> (IndexMap<String, TypeInfo>, Vec<SpecValidationError>) {
    let mut errors = Vec::new();
    let mut types = IndexMap::new();
    let Some(list) = parsed.data.get("types").and_then(Value::as_array) else {
        return (types, errors);
    };
    let mut seen = HashSet::new();
    for (ti, entry) in list.iter().enumerate() {
        let Some((key, body)) = single_key(entry) else {
            continue;
        };
        let path = format!("/types/{ti}/{key}");
        if !push_unique(
            &mut seen,
            &key,
            &mut errors,
            parsed,
            &path,
            format!("duplicate type '{key}'"),
        ) {
            continue;
        }
        if key == "set" || key == "dictionary" {
            errors.push(spec_err(parsed, &path, format!("'{key}' is a reserved type name")));
            continue;
        }
        let Some(def) = object_body(body) else {
            continue;
        };
        let mut fields = IndexMap::new();
        let mut field_types = HashMap::new();
        let mut field_references = HashMap::new();
        let mut id_fields = Vec::new();
        if let Some(field_list) = def.get("fields").and_then(Value::as_array) {
            let mut seen_fields = HashSet::new();
            for (fi, field) in field_list.iter().enumerate() {
                let Some((field_name, field_body)) = single_key(field) else {
                    continue;
                };
                let field_path = format!("{path}/fields/{fi}/{field_name}");
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
                fields.insert(field_name.clone(), field_path);
                if let Some(body) = object_body(field_body) {
                    if let Some(ty) = body.get("type").and_then(Value::as_str) {
                        field_types.insert(field_name.clone(), ty.to_string());
                    }
                    if body.get("is_id") == Some(&Value::Bool(true)) {
                        id_fields.push(field_name.clone());
                    }
                    if let Some(references) = references_of(body) {
                        field_references.insert(field_name.clone(), references);
                    }
                }
            }
        }
        types.insert(
            key.clone(),
            TypeInfo {
                path: path.clone(),
                tags: def.get("tags").and_then(string_list).unwrap_or_default(),
                inherits: def.get("inherits").and_then(Value::as_str).map(str::to_string),
                union: def.get("union").and_then(string_list),
                mapping: mapping_of(def),
                mapping_path: def.get("mapping").map(|_| format!("{path}/mapping")),
                extract: def.get("extract").and_then(string_list),
                extract_path: def.get("extract").map(|_| format!("{path}/extract")),
                remove_fields: def.get("remove_fields").and_then(string_list),
                remove_fields_path: def.get("remove_fields").map(|_| format!("{path}/remove_fields")),
                ids: def.get("ids").and_then(string_list),
                id_fields,
                fields,
                field_types,
                field_references,
            },
        );
        let _ = type_kind_inherit(def);
    }
    (types, errors)
}

fn apply_extract(fields: Vec<SourcedName>, extract: Option<&[String]>) -> Vec<SourcedName> {
    let Some(extract) = extract.filter(|items| !items.is_empty()) else {
        return fields;
    };
    let mut allow: HashMap<String, HashSet<String>> = HashMap::new();
    for item in extract {
        let (source, name) = split_remove_field(item);
        let Some(source) = source else { continue };
        allow.entry(source).or_default().insert(name);
    }
    fields
        .into_iter()
        .filter(|field| match allow.get(&field.source) {
            Some(keep) => keep.contains(&field.name),
            None => true,
        })
        .collect()
}

fn apply_mapping(fields: Vec<SourcedName>, mapping: Option<&HashMap<String, String>>) -> Vec<SourcedName> {
    let Some(mapping) = mapping else {
        return fields;
    };
    fields
        .into_iter()
        .map(|mut field| {
            if let Some(qualified) = mapping.get(&format!("{}.{}", field.source, field.name)) {
                field.name = qualified.clone();
            } else if let Some(bare) = mapping.get(&field.name) {
                field.name = bare.clone();
            }
            field
        })
        .collect()
}

fn apply_remove(fields: Vec<SourcedName>, remove: Option<&[String]>) -> Vec<SourcedName> {
    let Some(remove) = remove.filter(|items| !items.is_empty()) else {
        return fields;
    };
    fields
        .into_iter()
        .filter(|field| {
            for item in remove {
                let (source, name) = split_remove_field(item);
                if source.is_none() {
                    if field.name == name {
                        return false;
                    }
                    continue;
                }
                if field.source == source.unwrap() && field.name == name {
                    return false;
                }
            }
            true
        })
        .collect()
}

enum Compose {
    Fields(Vec<SourcedName>),
    Cycle(String),
}

fn parent_fields(name: &str, types: &IndexMap<String, TypeInfo>, stack: &mut HashSet<String>) -> Compose {
    let resolved = compose_fields(name, types, stack);
    let Compose::Fields(resolved) = resolved else {
        return resolved;
    };
    let nested = if types.get(name).and_then(|info| info.inherits.as_deref()) == Some("dictionary") {
        let info = types.get(name).expect("dictionary");
        resolved
            .into_iter()
            .filter(|field| match info.field_references.get(&field.original) {
                Some(reference) => !is_owner_identity_ref(reference, name, types),
                None => true,
            })
            .collect()
    } else {
        resolved
    };
    Compose::Fields(
        nested
            .into_iter()
            .map(|field| SourcedName {
                source: name.to_string(),
                name: field.name.clone(),
                original: field.name,
            })
            .collect(),
    )
}

fn compose_fields(name: &str, types: &IndexMap<String, TypeInfo>, stack: &mut HashSet<String>) -> Compose {
    if let Some(names) = built_in(name) {
        return Compose::Fields(
            names
                .into_iter()
                .map(|item| SourcedName {
                    source: name.to_string(),
                    name: item.clone(),
                    original: item,
                })
                .collect(),
        );
    }
    if stack.contains(name) {
        return Compose::Cycle(name.to_string());
    }
    let Some(info) = types.get(name) else {
        return Compose::Fields(Vec::new());
    };
    stack.insert(name.to_string());
    let mut fields = Vec::new();
    if let Some(inherits) = info.inherits.clone() {
        if !(inherits == "set" && has_authored_identity(info)) {
            match parent_fields(&inherits, types, stack) {
                Compose::Cycle(name) => return Compose::Cycle(name),
                Compose::Fields(part) => fields.extend(part),
            }
        }
    }
    for member in info.union.clone().unwrap_or_default() {
        match parent_fields(&member, types, stack) {
            Compose::Cycle(name) => return Compose::Cycle(name),
            Compose::Fields(part) => fields.extend(part),
        }
    }
    stack.remove(name);
    let info = types.get(name).expect("type still present");
    let kept = apply_remove(
        apply_mapping(apply_extract(fields, info.extract.as_deref()), info.mapping.as_ref()),
        info.remove_fields.as_deref(),
    );
    let mut out: Vec<SourcedName> = kept
        .into_iter()
        .map(|field| SourcedName {
            source: name.to_string(),
            name: field.name.clone(),
            original: field.name,
        })
        .collect();
    for local in info.fields.keys() {
        out.push(SourcedName {
            source: name.to_string(),
            name: local.clone(),
            original: local.clone(),
        });
    }
    Compose::Fields(out)
}

fn inherited_names(name: &str, types: &IndexMap<String, TypeInfo>, stack: &mut HashSet<String>) -> Result<HashSet<String>, String> {
    match compose_fields(name, types, stack) {
        Compose::Cycle(name) => Err(name),
        Compose::Fields(fields) => Ok(fields.into_iter().map(|field| field.name).collect()),
    }
}

fn check_composition(parsed: &ParsedYaml, types: &IndexMap<String, TypeInfo>) -> Vec<SpecValidationError> {
    let mut errors = Vec::new();
    for (name, info) in types {
        let mut sources = Vec::new();
        if let Some(inherits) = &info.inherits {
            if built_in(inherits).is_none() && !types.contains_key(inherits) {
                errors.push(spec_err(
                    parsed,
                    &format!("{}/inherits", info.path),
                    format!("unknown inherit target '{inherits}' on {name}"),
                ));
            } else {
                sources.push(inherits.clone());
            }
        }
        if let Some(union) = &info.union {
            for (i, member) in union.iter().enumerate() {
                if built_in(member).is_some() || types.contains_key(member) {
                    sources.push(member.clone());
                } else {
                    errors.push(spec_err(
                        parsed,
                        &format!("{}/union/{i}", info.path),
                        format!("unknown type '{member}' in union on {name}"),
                    ));
                }
            }
        }
        let mut sourced = Vec::new();
        let mut available = HashSet::new();
        for src in &sources {
            if src == "set" && has_authored_identity(info) {
                continue;
            }
            match parent_fields(src, types, &mut HashSet::from([name.clone()])) {
                Compose::Cycle(cycle) => errors.push(spec_err(
                    parsed,
                    &info.path,
                    format!("circular inherit/union involving '{cycle}'"),
                )),
                Compose::Fields(part) => {
                    for field in &part {
                        available.insert(field.name.clone());
                    }
                    sourced.extend(part);
                }
            }
        }
        let mut compose_sources = HashSet::new();
        if let Some(inherits) = &info.inherits {
            compose_sources.insert(inherits.clone());
        }
        for member in info.union.clone().unwrap_or_default() {
            compose_sources.insert(member);
        }
        let check_qualified = |field: &str, path: &str, label: &str, errors: &mut Vec<SpecValidationError>| -> bool {
            let (source, field_name) = split_remove_field(field);
            let Some(source) = source else {
                return false;
            };
            if built_in(&source).is_none() && !types.contains_key(&source) {
                errors.push(spec_err(
                    parsed,
                    path,
                    format!("unknown type '{source}' in {label} on {name}"),
                ));
                return true;
            }
            if !compose_sources.contains(&source) {
                errors.push(spec_err(
                    parsed,
                    path,
                    format!("{label} '{field}' is not from an inherit or union source of {name}"),
                ));
                return true;
            }
            match inherited_names(&source, types, &mut HashSet::from([name.clone()])) {
                Err(_) => true,
                Ok(names) if names.contains(&field_name) => true,
                Ok(_) => {
                    errors.push(spec_err(
                        parsed,
                        path,
                        format!("{label} '{field}' is not a field on {source}"),
                    ));
                    true
                }
            }
        };
        if let Some(extract) = &info.extract {
            for (i, field) in extract.iter().enumerate() {
                let path = format!("{}/{i}", info.extract_path.as_deref().unwrap_or(""));
                if check_qualified(field, &path, "extract", &mut errors) {
                    continue;
                }
                errors.push(spec_err(
                    parsed,
                    &path,
                    format!("extract '{field}' is not a field on the inherited or unioned shape of {name}"),
                ));
            }
        }
        if let Some(mapping) = &info.mapping {
            for from in mapping.keys() {
                let path = format!("{}/{from}", info.mapping_path.as_deref().unwrap_or(""));
                if check_qualified(from, &path, "mapping", &mut errors) {
                    continue;
                }
                let matches: Vec<_> = sourced.iter().filter(|field| field.name == *from).collect();
                if matches.is_empty() {
                    errors.push(spec_err(
                        parsed,
                        &path,
                        format!("mapping '{from}' is not a field on the inherited or unioned shape of {name}"),
                    ));
                    continue;
                }
                if matches.len() > 1 {
                    errors.push(spec_err(
                        parsed,
                        &path,
                        format!("mapping '{from}' matches more than one source on {name}; qualify it"),
                    ));
                }
            }
        }
        if let Some(remove) = &info.remove_fields {
            for (i, field) in remove.iter().enumerate() {
                let path = format!("{}/{i}", info.remove_fields_path.as_deref().unwrap_or(""));
                let (source, field_name) = split_remove_field(field);
                if source.is_none() {
                    if available.contains(&field_name) {
                        continue;
                    }
                    errors.push(spec_err(
                        parsed,
                        &path,
                        format!("remove_fields '{field}' is not a field on the inherited or unioned shape of {name}"),
                    ));
                    continue;
                }
                check_qualified(field, &path, "remove_fields", &mut errors);
            }
        }
        let composed = apply_remove(
            apply_mapping(apply_extract(sourced, info.extract.as_deref()), info.mapping.as_ref()),
            info.remove_fields.as_deref(),
        );
        let mut seen_names: HashMap<String, SourcedName> = HashMap::new();
        let report_dup = |field: SourcedName, path: &str, errors: &mut Vec<SpecValidationError>, seen_names: &mut HashMap<String, SourcedName>| {
            if let Some(prev) = seen_names.get(&field.name) {
                errors.push(spec_err(
                    parsed,
                    path,
                    format!(
                        "{}.{} and {}.{} collide on the composed shape of {name}; use mapping or remove_fields and give new names",
                        prev.source, prev.original, field.source, field.original
                    ),
                ));
                return;
            }
            seen_names.insert(field.name.clone(), field);
        };
        for field in composed {
            report_dup(field, &info.path, &mut errors, &mut seen_names);
        }
        for (field_name, field_path) in &info.fields {
            report_dup(
                SourcedName {
                    source: name.clone(),
                    name: field_name.clone(),
                    original: field_name.clone(),
                },
                field_path,
                &mut errors,
                &mut seen_names,
            );
        }
    }
    errors
}

fn field_names_of(name: &str, types: &IndexMap<String, TypeInfo>) -> HashSet<String> {
    if let Some(names) = built_in(name) {
        return names.into_iter().collect();
    }
    inherited_names(name, types, &mut HashSet::new()).unwrap_or_default()
}

fn check_references(parsed: &ParsedYaml, types: &IndexMap<String, TypeInfo>) -> Vec<SpecValidationError> {
    let mut errors = Vec::new();
    let Some(list) = parsed.data.get("types").and_then(Value::as_array) else {
        return errors;
    };
    let check_ref = |reference: &str, path: &str, check_field: bool, errors: &mut Vec<SpecValidationError>| {
        let Some((ref_type, ref_col)) = reference.split_once('.') else {
            return;
        };
        if ref_type.is_empty() || ref_col.is_empty() {
            return;
        }
        if !types.contains_key(ref_type) && built_in(ref_type).is_none() {
            errors.push(spec_err(parsed, path, format!("unknown type '{ref_type}' in references")));
            return;
        }
        if check_field && ref_col != "id" && !field_names_of(ref_type, types).contains(ref_col) {
            errors.push(spec_err(
                parsed,
                path,
                format!("unknown field '{ref_col}' on {ref_type} in references"),
            ));
        }
    };
    let is_type_name = |raw: Option<&Value>| -> bool {
        let Some(raw) = raw.and_then(Value::as_str) else {
            return false;
        };
        let base = raw.strip_suffix("[]").or_else(|| raw.strip_suffix("{}")).unwrap_or(raw);
        types.contains_key(base)
    };
    for (ti, entry) in list.iter().enumerate() {
        let Some((key, body)) = single_key(entry) else { continue };
        let Some(fields) = object_body(body).and_then(|def| def.get("fields")).and_then(Value::as_array) else {
            continue;
        };
        for (fi, field) in fields.iter().enumerate() {
            let Some((field_name, field_body)) = single_key(field) else { continue };
            let Some(body) = object_body(field_body) else { continue };
            let ref_path = format!("/types/{ti}/{key}/fields/{fi}/{field_name}/references");
            let check_field = !is_type_name(body.get("type"));
            match body.get("references") {
                Some(Value::String(reference)) => check_ref(reference, &ref_path, check_field, &mut errors),
                Some(Value::Array(items)) => {
                    for (i, item) in items.iter().enumerate() {
                        if let Some(reference) = item.as_str() {
                            check_ref(reference, &format!("{ref_path}/{i}"), check_field, &mut errors);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    errors
}

fn check_decimal_sizes(parsed: &ParsedYaml) -> Vec<SpecValidationError> {
    let mut errors = Vec::new();
    let Some(list) = parsed.data.get("types").and_then(Value::as_array) else {
        return errors;
    };
    for (ti, entry) in list.iter().enumerate() {
        let Some((key, body)) = single_key(entry) else { continue };
        let Some(fields) = object_body(body).and_then(|def| def.get("fields")).and_then(Value::as_array) else {
            continue;
        };
        for (fi, field) in fields.iter().enumerate() {
            let Some((field_name, field_body)) = single_key(field) else { continue };
            let Some(def) = object_body(field_body) else { continue };
            if def.get("type").and_then(Value::as_str) != Some("decimal") {
                continue;
            }
            let Some(size) = def.get("size").and_then(Value::as_array) else { continue };
            if size.len() != 2 {
                continue;
            }
            let (Some(precision), Some(scale)) = (size[0].as_f64(), size[1].as_f64()) else {
                continue;
            };
            if scale > precision {
                errors.push(spec_err(
                    parsed,
                    &format!("/types/{ti}/{key}/fields/{fi}/{field_name}/size"),
                    format!("decimal size scale must be <= precision ({precision})"),
                ));
            }
        }
    }
    errors
}

fn check_identity(parsed: &ParsedYaml, types: &IndexMap<String, TypeInfo>) -> Vec<SpecValidationError> {
    let mut errors = Vec::new();
    let Some(list) = parsed.data.get("types").and_then(Value::as_array) else {
        return errors;
    };
    for (ti, entry) in list.iter().enumerate() {
        let Some((key, body)) = single_key(entry) else { continue };
        let Some(def) = object_body(body) else { continue };
        let path = format!("/types/{ti}/{key}");
        let mut id_fields = Vec::new();
        if let Some(fields) = def.get("fields").and_then(Value::as_array) {
            for (fi, field) in fields.iter().enumerate() {
                let Some((field_name, field_body)) = single_key(field) else { continue };
                if object_body(field_body).and_then(|body| body.get("is_id")) != Some(&Value::Bool(true)) {
                    continue;
                }
                let field_path = format!("{path}/fields/{fi}/{field_name}/is_id");
                if !id_fields.is_empty() {
                    errors.push(spec_err(
                        parsed,
                        &field_path,
                        format!("is_id: true may appear on at most one field on {key}"),
                    ));
                }
                id_fields.push(field_path);
            }
        }
        if def.get("ids").and_then(Value::as_array).is_some() && !id_fields.is_empty() {
            errors.push(spec_err(
                parsed,
                &format!("{path}/ids"),
                format!("ids and is_id are mutually exclusive on {key}"),
            ));
        }
        let Some(ids) = def.get("ids").and_then(Value::as_array) else {
            continue;
        };
        let known = field_names_of(&key, types);
        for (i, name) in ids.iter().enumerate() {
            let Some(name) = name.as_str() else { continue };
            if known.contains(name) {
                continue;
            }
            errors.push(spec_err(
                parsed,
                &format!("{path}/ids/{i}"),
                format!("ids '{name}' is not a field on {key}"),
            ));
        }
    }
    errors
}

const PRIMITIVES: &[&str] = &[
    "string", "character", "number", "integer", "unsignedinteger", "biginteger",
    "unsignedbiginteger", "smallinteger", "unsignedsmallinteger", "float", "decimal",
    "boolean", "datetime", "binary", "uuid",
];

fn field_type_base(raw: &str) -> &str {
    raw.strip_suffix("[]").or_else(|| raw.strip_suffix("{}")).unwrap_or(raw)
}

fn dotted_ref(raw: Option<&FieldRef>) -> Option<&str> {
    match raw {
        Some(FieldRef::One(text)) => Some(text.as_str()),
        _ => None,
    }
}

fn resolve_role_column(
    dict: &TypeInfo,
    role: &str,
    table_name: &str,
    types: &IndexMap<String, TypeInfo>,
) -> Result<String, String> {
    let known = field_names_of(table_name, types);
    if let Some(reference) = dotted_ref(dict.field_references.get(role)) {
        let (source, name) = split_remove_field(reference);
        if source.as_deref() != Some(table_name) || !known.contains(&name) {
            return Err(format!("dictionary {role} must reference a column on {table_name}"));
        }
        return Ok(name);
    }
    if known.contains(role) {
        Ok(role.to_string())
    } else {
        Err(format!("{table_name} must include a {role} column"))
    }
}

fn check_dictionary(parsed: &ParsedYaml, types: &IndexMap<String, TypeInfo>) -> Vec<SpecValidationError> {
    let mut errors = Vec::new();
    for (name, info) in types {
        if info.inherits.as_deref() != Some("dictionary") {
            continue;
        }
        if !info.fields.contains_key("key") {
            errors.push(spec_err(parsed, &format!("{}/fields", info.path), format!("dictionary type {name} must include a key field")));
        }
        if !info.fields.contains_key("value") {
            errors.push(spec_err(parsed, &format!("{}/fields", info.path), format!("dictionary type {name} must include a value field")));
        }
        if info.tags.iter().any(|tag| tag == "datasource_type") {
            errors.push(spec_err(
                parsed,
                &info.path,
                format!("dictionary type {name} must not be tagged datasource_type"),
            ));
        }
        if !info.tags.iter().any(|tag| tag == "view_type") {
            errors.push(spec_err(
                parsed,
                &info.path,
                format!("dictionary type {name} must be tagged view_type"),
            ));
        }
        if info
            .field_references
            .values()
            .any(|reference| is_owner_identity_ref(reference, name, types))
        {
            errors.push(spec_err(
                parsed,
                &info.path,
                format!("dictionary type {name} must not reference an owner identity"),
            ));
        }
        if let Some(value_type) = info.field_types.get("value") {
            let base = field_type_base(value_type);
            if !PRIMITIVES.contains(&base) {
                if types.get(base).is_some_and(|info| info.tags.iter().any(|tag| tag == "datasource_type")) {
                    errors.push(spec_err(
                        parsed,
                        &format!("{}/fields", info.path),
                        format!("dictionary type {name} value must not be a datasource_type"),
                    ));
                }
            }
        }
    }
    errors
}

fn check_map_fields(parsed: &ParsedYaml, types: &IndexMap<String, TypeInfo>) -> Vec<SpecValidationError> {
    let mut errors = Vec::new();
    for (type_name, info) in types {
        for (field_name, field_path) in &info.fields {
            let Some(raw_type) = info.field_types.get(field_name) else { continue };
            let Some(dict_name) = raw_type.strip_suffix("{}") else { continue };
            let dict = types.get(dict_name);
            if dict.and_then(|item| item.inherits.as_deref()) != Some("dictionary") {
                errors.push(spec_err(
                    parsed,
                    &format!("{field_path}/type"),
                    format!("{type_name}.{field_name} type {raw_type} must name a dictionary type"),
                ));
                continue;
            }
            let dict = dict.unwrap();
            let split = dotted_ref(info.field_references.get(field_name)).map(split_remove_field);
            let table = split.as_ref().and_then(|(source, _)| source.as_ref().and_then(|name| types.get(name)));
            let owner_ref = table.and_then(|item| {
                split.as_ref().and_then(|(_, column)| item.field_references.get(column))
            });
            let table_name = split.as_ref().and_then(|(source, _)| source.as_deref());
            if table_name.is_none()
                || table.is_none_or(|item| !item.tags.iter().any(|tag| tag == "datasource_type"))
                || owner_ref.is_none_or(|reference| {
                    !is_owner_identity_ref(reference, table_name.unwrap(), types)
                })
            {
                errors.push(spec_err(
                    parsed,
                    &format!("{field_path}/references"),
                    format!("{type_name}.{field_name} must reference a datasource_type owner identity column"),
                ));
                continue;
            }
            let table_name = table_name.unwrap();
            if let Err(message) = resolve_role_column(dict, "key", table_name, types) {
                errors.push(spec_err(parsed, &format!("{field_path}/references"), message));
            }
            let nested = dict.field_types.get("value").and_then(|value_type| {
                let base = field_type_base(value_type);
                (!PRIMITIVES.contains(&base)).then(|| types.get(base)).flatten()
            });
            if let Some(nested) = nested {
                for role in nested.fields.keys() {
                    if nested.field_types.get(role).is_some_and(|raw| raw.ends_with("[]") || raw.ends_with("{}")) {
                        continue;
                    }
                    if let Err(message) = resolve_role_column(nested, role, table_name, types) {
                        errors.push(spec_err(parsed, &format!("{field_path}/references"), message));
                    }
                }
            } else if let Err(message) = resolve_role_column(dict, "value", table_name, types) {
                errors.push(spec_err(parsed, &format!("{field_path}/references"), message));
            }
        }
    }
    errors
}

pub fn check_type_model(parsed: &ParsedYaml, _options: &super::schema::ValidateOptions) -> SpecValidationResult {
    let (types, mut errors) = collect_types(parsed);
    errors.extend(check_composition(parsed, &types));
    errors.extend(check_dictionary(parsed, &types));
    errors.extend(check_map_fields(parsed, &types));
    errors.extend(check_references(parsed, &types));
    errors.extend(check_decimal_sizes(parsed));
    errors.extend(check_identity(parsed, &types));
    SpecValidationResult::fail(errors)
}

fn type_info_from_entry(entry: &Value) -> Option<(String, TypeInfo)> {
    let (key, body) = single_key(entry)?;
    let def = object_body(body)?;
    let mut fields = IndexMap::new();
    let mut field_types = HashMap::new();
    let mut field_references = HashMap::new();
    let mut id_fields = Vec::new();
    if let Some(list) = def.get("fields").and_then(Value::as_array) {
        for (fi, field) in list.iter().enumerate() {
            let Some((field_name, field_body)) = single_key(field) else { continue };
            fields.insert(field_name.clone(), format!("/types/{key}/fields/{fi}"));
            if let Some(body) = object_body(field_body) {
                if let Some(ty) = body.get("type").and_then(Value::as_str) {
                    field_types.insert(field_name.clone(), ty.to_string());
                }
                if body.get("is_id") == Some(&Value::Bool(true)) {
                    id_fields.push(field_name.clone());
                }
                if let Some(references) = references_of(body) {
                    field_references.insert(field_name, references);
                }
            }
        }
    }
    Some((
        key.clone(),
        TypeInfo {
            path: format!("/types/{key}"),
            tags: def.get("tags").and_then(string_list).unwrap_or_default(),
            inherits: def.get("inherits").and_then(Value::as_str).map(str::to_string),
            union: def.get("union").and_then(string_list),
            mapping: mapping_of(def),
            mapping_path: None,
            extract: def.get("extract").and_then(string_list),
            extract_path: None,
            remove_fields: def.get("remove_fields").and_then(string_list),
            remove_fields_path: None,
            ids: def.get("ids").and_then(string_list),
            id_fields,
            fields,
            field_types,
            field_references,
        },
    ))
}

pub fn index_type_fields(data: &Value) -> IndexMap<String, IndexMap<String, Value>> {
    let mut out = IndexMap::new();
    let Some(list) = data.get("types").and_then(Value::as_array) else {
        return out;
    };
    let mut infos = IndexMap::new();
    for entry in list {
        if let Some((name, info)) = type_info_from_entry(entry) {
            infos.insert(name, info);
        }
    }
    for entry in list {
        let Some((key, body)) = single_key(entry) else { continue };
        let def = object_body(body);
        let mut fields = IndexMap::new();
        for name in field_names_of(&key, &infos) {
            fields.insert(name, Value::Object(Default::default()));
        }
        if let Some(list) = def.and_then(|def| def.get("fields")).and_then(Value::as_array) {
            for field in list {
                let Some((field_name, field_body)) = single_key(field) else { continue };
                fields.insert(field_name, object_body(field_body).cloned().unwrap_or_else(|| Value::Object(Default::default())));
            }
        }
        out.insert(key, fields);
    }
    out
}
