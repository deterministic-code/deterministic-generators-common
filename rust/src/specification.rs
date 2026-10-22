use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;

use crate::error::Error;
use crate::yaml_node::{YamlLiteral, YamlNode};

pub const TYPES_YAML: &str = "types.yaml";
pub const DATASOURCE_YAML: &str = "datasource.yaml";
pub const DATASOURCE_SEEDS_YAML: &str = "datasource_seeds.yaml";
pub const SERVICES_YAML: &str = "services.yaml";
pub const ROUTES_YAML: &str = "routes.yaml";

#[derive(Debug, Clone, PartialEq)]
pub enum SeedValue {
    String(String),
    Number(f64),
    Bool(bool),
    Null,
}

impl From<YamlLiteral> for Option<SeedValue> {
    fn from(value: YamlLiteral) -> Self {
        match value {
            YamlLiteral::String(value) => Some(SeedValue::String(value)),
            YamlLiteral::Number(value) => Some(SeedValue::Number(value)),
            YamlLiteral::Bool(value) => Some(SeedValue::Bool(value)),
            YamlLiteral::Null => Some(SeedValue::Null),
            YamlLiteral::EmptyArray | YamlLiteral::EmptyMap => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SeedRow {
    pub id: i64,
    pub row: IndexMap<String, SeedValue>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldKind {
    Primitive,
    Type,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FieldSize {
    Unlimited,
    Num(f64),
    Range(f64, f64),
}

#[derive(Debug, Clone, PartialEq)]
pub enum References {
    One(String),
    Pair(String, String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct TypeField {
    pub name: String,
    pub type_name: String,
    pub kind: FieldKind,
    pub base: String,
    pub is_array: bool,
    pub is_map: bool,
    pub is_nullable: bool,
    pub is_id: bool,
    pub size: Option<FieldSize>,
    pub min_size: Option<i64>,
    pub references: Option<References>,
    pub has_default: bool,
    pub default_value: Option<YamlLiteral>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TypeKind {
    Inherit,
    Union,
    Shaped,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Type {
    pub name: String,
    pub tags: Vec<String>,
    pub kind: TypeKind,
    pub inherits: Option<String>,
    pub union: Option<Vec<String>>,
    pub mapping: Option<IndexMap<String, String>>,
    pub extract: Option<Vec<String>>,
    pub remove_fields: Option<Vec<String>>,
    pub ids: Option<Vec<String>>,
    pub fields: Vec<TypeField>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DatasourceFieldOverlay {
    pub name: String,
    pub is_readonly: Option<bool>,
    pub is_unique: Option<bool>,
    pub mapping: Option<String>,
    pub is_fixed_id: Option<bool>,
    pub include_in_create: Option<bool>,
    pub include_in_update: Option<bool>,
    pub is_optimistic_concurrency: Option<bool>,
    pub use_native_row_version: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatasourceIndex {
    pub name: String,
    pub fields: Vec<String>,
    pub is_unique: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DatasourceTable {
    pub name: String,
    pub mapping: Option<String>,
    pub fields: Vec<DatasourceFieldOverlay>,
    pub indexes: Vec<DatasourceIndex>,
    pub unique_index_fields: Vec<String>,
    pub use_optimistic_concurrency: Option<bool>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ServiceByField {
    pub field: String,
    pub type_name: String,
    pub size: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ServiceCandidate {
    pub name: String,
    pub tags: Vec<String>,
    pub inherits: Option<String>,
    pub by_fields: Vec<ServiceByField>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomServiceEntry {
    pub name: String,
    pub module: Option<String>,
    pub methods: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedServices {
    pub generics: Vec<ServiceCandidate>,
    pub customs: Vec<CustomServiceEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteByField {
    pub by_field: String,
    pub methods: Option<Vec<String>>,
    pub by_field_unique: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteCandidate {
    pub name: String,
    pub tags: Vec<String>,
    pub inherits: Option<String>,
    pub by_fields: Vec<RouteByField>,
    pub eager_read_path: Option<Vec<String>>,
    pub eager_update_path: Option<Vec<String>>,
    pub eager_read_member_only: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomRouteEntry {
    pub name: String,
    pub path: Option<String>,
    pub method: Option<String>,
    pub entity: Option<String>,
    pub request: Option<String>,
    pub response: Option<String>,
    pub module: Option<String>,
    pub route_class: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectFkDescriptor {
    pub parent: String,
    pub parent_param: String,
    pub parent_base_path: String,
    pub segment: String,
    pub segment_tail: String,
    pub child: String,
    pub fk_column: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct M2mDescriptor {
    pub parent: String,
    pub parent_param: String,
    pub parent_base_path: String,
    pub segment: String,
    pub segment_tail: String,
    pub junction: String,
    pub target: String,
    pub target_param: String,
    pub parent_fk_field: String,
    pub child_fk_field: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NestedRouteDescriptor {
    DirectFk(DirectFkDescriptor),
    M2m(M2mDescriptor),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedRoutes {
    pub candidates: Vec<RouteCandidate>,
    pub customs: Vec<CustomRouteEntry>,
    pub nested: Vec<NestedRouteDescriptor>,
    pub children_only: HashSet<String>,
    pub datasource: Vec<DatasourceTable>,
}

const PRIMITIVES: &[&str] = &[
    "string",
    "character",
    "number",
    "integer",
    "unsignedinteger",
    "biginteger",
    "unsignedbiginteger",
    "smallinteger",
    "unsignedsmallinteger",
    "float",
    "decimal",
    "boolean",
    "datetime",
    "binary",
    "uuid",
    "reference",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedFieldType {
    pub kind: FieldKind,
    pub base: String,
    pub is_array: bool,
    pub is_map: bool,
}

pub fn parse_field_type(raw: &str) -> ParsedFieldType {
    let is_array = raw.ends_with("[]");
    let is_map = raw.ends_with("{}");
    let base = if is_array || is_map {
        raw[..raw.len() - 2].to_string()
    } else {
        raw.to_string()
    };
    ParsedFieldType {
        kind: if PRIMITIVES.contains(&base.as_str()) {
            FieldKind::Primitive
        } else {
            FieldKind::Type
        },
        base,
        is_array,
        is_map,
    }
}

fn set_id_field() -> TypeField {
    TypeField {
        name: "id".to_string(),
        type_name: "integer".to_string(),
        kind: FieldKind::Primitive,
        base: "integer".to_string(),
        is_array: false,
        is_map: false,
        is_nullable: false,
        is_id: false,
        size: None,
        min_size: None,
        references: None,
        has_default: false,
        default_value: None,
    }
}

fn marked_ids(type_def: &Type) -> Vec<String> {
    type_def
        .fields
        .iter()
        .filter(|field| field.is_id)
        .map(|field| field.name.clone())
        .collect()
}

pub fn has_authored_identity(type_def: &Type) -> bool {
    type_def.ids.as_ref().is_some_and(|ids| !ids.is_empty()) || !marked_ids(type_def).is_empty()
}

pub fn identity_columns(type_def: Option<&Type>) -> Vec<String> {
    let Some(type_def) = type_def else {
        return vec!["id".to_string()];
    };
    if let Some(ids) = type_def.ids.as_ref().filter(|ids| !ids.is_empty()) {
        return ids.clone();
    }
    let marked = marked_ids(type_def);
    if !marked.is_empty() {
        return marked;
    }
    if type_def.inherits.as_deref() == Some("set") {
        vec!["id".to_string()]
    } else {
        Vec::new()
    }
}

pub fn primary_key_column(_table: Option<&DatasourceTable>, type_def: Option<&Type>) -> String {
    identity_columns(type_def)
        .into_iter()
        .next()
        .unwrap_or_else(|| "id".to_string())
}

pub fn unique_lookup_fields(type_def: &Type, table: Option<&DatasourceTable>) -> Vec<ServiceByField> {
    let mut out = Vec::new();
    let mut add = |name: &str| {
        if out.iter().any(|entry: &ServiceByField| entry.field == name) {
            return;
        }
        let field = type_def.fields.iter().find(|field| field.name == name);
        let size = field.and_then(|field| match field.size {
            Some(FieldSize::Num(value)) => Some(value),
            _ => None,
        });
        out.push(ServiceByField {
            field: name.to_string(),
            type_name: field
                .map(|field| field.type_name.clone())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "string".to_string()),
            size,
        });
    };
    for name in identity_columns(Some(type_def)) {
        add(&name);
    }
    if let Some(table) = table {
        for overlay in &table.fields {
            if overlay.is_unique == Some(true) {
                add(&overlay.name);
            }
        }
        for name in &table.unique_index_fields {
            add(name);
        }
    }
    out
}

pub fn type_has_tag(type_def: &Type, tag: &str) -> bool {
    type_def.tags.iter().any(|item| item == tag)
}

#[derive(Clone)]
struct SourcedField {
    field: TypeField,
    source: String,
    original: String,
}

fn split_dot(value: &str) -> Option<(&str, &str)> {
    value.split_once('.')
}

fn identity_field_names(type_def: Option<&Type>, by_name: &HashMap<String, Type>, stack: &mut HashSet<String>) -> HashSet<String> {
    let Some(type_def) = type_def else {
        return HashSet::new();
    };
    if stack.contains(&type_def.name) {
        return HashSet::new();
    }
    let local = identity_columns(Some(type_def));
    if !local.is_empty() {
        return local.into_iter().collect();
    }
    if let Some(parent) = type_def.inherits.as_ref().filter(|name| name.as_str() != "dictionary") {
        stack.insert(type_def.name.clone());
        return identity_field_names(by_name.get(parent), by_name, stack);
    }
    HashSet::new()
}

fn ref_parts(references: &References) -> Vec<(String, String)> {
    let raw: Vec<&str> = match references {
        References::One(value) => vec![value.as_str()],
        References::Pair(left, right) => vec![left.as_str(), right.as_str()],
    };
    raw.into_iter()
        .map(|item| match split_dot(item) {
            Some((type_name, field)) => (type_name.to_string(), field.to_string()),
            None => (String::new(), item.to_string()),
        })
        .collect()
}

fn is_owner_identity_ref(references: &References, self_name: &str, by_name: &HashMap<String, Type>) -> bool {
    let parts = ref_parts(references);
    let Some(owner) = parts.first().map(|(type_name, _)| type_name.clone()) else {
        return false;
    };
    if owner.is_empty() || owner == self_name {
        return false;
    }
    let identity = identity_field_names(by_name.get(&owner), by_name, &mut HashSet::new());
    parts.iter().all(|(type_name, field)| type_name == &owner && identity.contains(field))
}

fn extract_fields(fields: Vec<SourcedField>, extract: Option<&[String]>) -> Vec<SourcedField> {
    let Some(extract) = extract.filter(|items| !items.is_empty()) else {
        return fields;
    };
    let mut allow: HashMap<String, HashSet<String>> = HashMap::new();
    for item in extract {
        let Some((source, name)) = split_dot(item) else {
            continue;
        };
        allow.entry(source.to_string()).or_default().insert(name.to_string());
    }
    fields
        .into_iter()
        .filter(|field| match allow.get(&field.source) {
            Some(keep) => keep.contains(&field.field.name),
            None => true,
        })
        .collect()
}

fn rename_fields(fields: Vec<SourcedField>, mapping: Option<&IndexMap<String, String>>) -> Vec<SourcedField> {
    let Some(mapping) = mapping else {
        return fields;
    };
    fields
        .into_iter()
        .map(|mut field| {
            let qualified = format!("{}.{}", field.source, field.field.name);
            if let Some(name) = mapping.get(&qualified).or_else(|| mapping.get(&field.field.name)) {
                field.field.name = name.clone();
            }
            field
        })
        .collect()
}

fn assert_unique_field_names(fields: &[SourcedField], type_name: &str) -> Result<(), Error> {
    let mut seen: HashMap<String, &SourcedField> = HashMap::new();
    for field in fields {
        if let Some(prev) = seen.get(&field.field.name) {
            return Err(Error::new(format!(
                "{}.{} and {}.{} collide on the composed shape of {type_name}; use mapping or remove_fields and give new names",
                prev.source, prev.original, field.source, field.original
            )));
        }
        seen.insert(field.field.name.clone(), field);
    }
    Ok(())
}

fn keep_fields(fields: Vec<SourcedField>, remove: Option<&[String]>) -> Vec<SourcedField> {
    let Some(remove) = remove.filter(|items| !items.is_empty()) else {
        return fields;
    };
    fields
        .into_iter()
        .filter(|field| {
            !remove.iter().any(|item| match split_dot(item) {
                Some((source, name)) => field.field.name == name && field.source == source,
                None => field.field.name == *item,
            })
        })
        .collect()
}

pub fn expand_types(types: &[Type]) -> Result<Vec<Type>, Error> {
    let by_name: HashMap<String, Type> = types.iter().map(|type_def| (type_def.name.clone(), type_def.clone())).collect();
    let mut cache: HashMap<String, Vec<TypeField>> = HashMap::new();

    fn resolve(
        name: &str,
        stack: &mut HashSet<String>,
        by_name: &HashMap<String, Type>,
        cache: &mut HashMap<String, Vec<TypeField>>,
    ) -> Result<Vec<TypeField>, Error> {
        if let Some(hit) = cache.get(name) {
            return Ok(hit.clone());
        }
        if name == "set" {
            let fields = vec![set_id_field()];
            cache.insert(name.to_string(), fields.clone());
            return Ok(fields);
        }
        if stack.contains(name) {
            return Err(Error::new(format!(
                "circular inherit/union involving \"{name}\""
            )));
        }
        let Some(type_def) = by_name.get(name) else {
            return Ok(Vec::new());
        };
        stack.insert(name.to_string());
        let compose_source = |source: &str,
                              stack: &mut HashSet<String>,
                              cache: &mut HashMap<String, Vec<TypeField>>|
         -> Result<Vec<SourcedField>, Error> {
            let fields = resolve(source, stack, by_name, cache)?;
            let sourced: Vec<SourcedField> = fields
                .into_iter()
                .map(|field| SourcedField {
                    original: field.name.clone(),
                    source: source.to_string(),
                    field,
                })
                .collect();
            let filtered = if by_name.get(source).and_then(|item| item.inherits.as_deref()) == Some("dictionary") {
                sourced
                    .into_iter()
                    .filter(|field| match &field.field.references {
                        Some(references) => !is_owner_identity_ref(references, source, by_name),
                        None => true,
                    })
                    .collect()
            } else {
                sourced
            };
            Ok(filtered)
        };
        let skip_set_id = type_def.inherits.as_deref() == Some("set") && has_authored_identity(type_def);
        let mut inherited = Vec::new();
        if let Some(parent) = type_def.inherits.as_ref() {
            if !skip_set_id {
                inherited.extend(compose_source(parent, stack, cache)?);
            }
        }
        if let Some(members) = &type_def.union {
            for member in members {
                inherited.extend(compose_source(member, stack, cache)?);
            }
        }
        stack.remove(name);
        let merged_prefix = keep_fields(
            rename_fields(extract_fields(inherited, type_def.extract.as_deref()), type_def.mapping.as_ref()),
            type_def.remove_fields.as_deref(),
        );
        let mut merged = merged_prefix;
        for field in &type_def.fields {
            merged.push(SourcedField {
                original: field.name.clone(),
                source: name.to_string(),
                field: field.clone(),
            });
        }
        assert_unique_field_names(&merged, name)?;
        let result = merged.into_iter().map(|field| field.field).collect::<Vec<_>>();
        cache.insert(name.to_string(), result.clone());
        Ok(result)
    }

    fn resolve_ids(name: &str, stack: &mut HashSet<String>, by_name: &HashMap<String, Type>) -> Option<Vec<String>> {
        if stack.contains(name) {
            return None;
        }
        let type_def = by_name.get(name)?;
        if let Some(ids) = type_def.ids.as_ref().filter(|ids| !ids.is_empty()) {
            return Some(ids.clone());
        }
        if type_def.fields.iter().any(|field| field.is_id) {
            return None;
        }
        if let Some(parent) = type_def.inherits.as_ref() {
            if parent != "set" && parent != "dictionary" {
                stack.insert(name.to_string());
                let ids = resolve_ids(parent, stack, by_name);
                stack.remove(name);
                return ids;
            }
        }
        None
    }

    types
        .iter()
        .map(|type_def| {
            let ids = if type_def.ids.is_some() {
                type_def.ids.clone()
            } else {
                resolve_ids(&type_def.name, &mut HashSet::new(), &by_name)
            };
            let mut expanded = type_def.clone();
            if let Some(ids) = ids.filter(|ids| !ids.is_empty()) {
                expanded.ids = Some(ids);
            }
            expanded.fields = resolve(&type_def.name, &mut HashSet::new(), &by_name, &mut cache)?;
            Ok(expanded)
        })
        .collect()
}

pub fn read_type_field(name: &str, node: &YamlNode) -> TypeField {
    let raw_type = node.str("type").unwrap_or_else(|| "string".to_string());
    let parsed = parse_field_type(&raw_type);
    let references = references_of(node);
    let size = size_of(node);
    let min_size = node.finite_int("min_size");
    let authored = node.has("default_value");
    let default_value = if authored {
        node.literal("default_value")
    } else if parsed.is_array {
        Some(YamlLiteral::EmptyArray)
    } else if parsed.is_map {
        Some(YamlLiteral::EmptyMap)
    } else {
        None
    };
    TypeField {
        name: name.to_string(),
        type_name: raw_type,
        kind: parsed.kind,
        base: parsed.base,
        is_array: parsed.is_array,
        is_map: parsed.is_map,
        is_nullable: node.bool("is_nullable"),
        is_id: node.bool("is_id"),
        size,
        min_size,
        references,
        has_default: authored || default_value.is_some(),
        default_value,
    }
}

fn references_of(node: &YamlNode) -> Option<References> {
    let child = node.child("references");
    let raw = child.value()?;
    match raw {
        crate::yaml_node::YamlValue::String(value) => Some(References::One(value.clone())),
        crate::yaml_node::YamlValue::Array(items) => {
            let strings: Vec<String> = items
                .iter()
                .filter_map(|item| match item {
                    crate::yaml_node::YamlValue::String(value) => Some(value.clone()),
                    _ => None,
                })
                .collect();
            if strings.len() == 2 && strings.len() == items.len() {
                Some(References::Pair(strings[0].clone(), strings[1].clone()))
            } else {
                None
            }
        }
        _ => None,
    }
}

fn size_of(node: &YamlNode) -> Option<FieldSize> {
    let child = node.child("size");
    let raw = child.value()?;
    match raw {
        crate::yaml_node::YamlValue::String(value) if value == "unlimited" => Some(FieldSize::Unlimited),
        crate::yaml_node::YamlValue::Number(value) if value.is_finite() => Some(FieldSize::Num(*value)),
        crate::yaml_node::YamlValue::Array(items) => {
            let numbers: Vec<f64> = items
                .iter()
                .filter_map(|item| match item {
                    crate::yaml_node::YamlValue::Number(value) if value.is_finite() => Some(*value),
                    _ => None,
                })
                .collect();
            if numbers.len() == 2 && numbers.len() == items.len() {
                Some(FieldSize::Range(numbers[0], numbers[1]))
            } else {
                None
            }
        }
        _ => None,
    }
}

pub fn mapping_of(node: &YamlNode) -> Option<IndexMap<String, String>> {
    let child = node.child("mapping");
    let record = child.record()?;
    let mut out = IndexMap::new();
    for (key, value) in record {
        if let crate::yaml_node::YamlValue::String(text) = value {
            out.insert(key.clone(), text.clone());
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ty(name: &str, inherits: Option<&str>, ids: Option<Vec<String>>) -> Type {
        Type {
            name: name.into(),
            tags: vec![],
            kind: TypeKind::Inherit,
            inherits: inherits.map(str::to_string),
            union: None,
            mapping: None,
            extract: None,
            remove_fields: None,
            ids,
            fields: vec![],
        }
    }

    #[test]
    fn identity_and_yaml_edges() {
        let mut by_name = HashMap::new();
        by_name.insert("a".into(), ty("a", Some("b"), None));
        by_name.insert("b".into(), ty("b", Some("a"), None));
        assert!(identity_field_names(by_name.get("a"), &by_name, &mut HashSet::new()).is_empty());
        assert!(identity_field_names(None, &by_name, &mut HashSet::new()).is_empty());
        let expanded = expand_types(&[
            ty("parent", None, Some(vec!["code".into()])),
            ty("child", Some("parent"), None),
        ])
        .unwrap();
        assert_eq!(expanded[1].ids.as_deref(), Some(["code".to_string()].as_slice()));
        let node = YamlNode::from_yaml("references: [1, 2]\nsize: [a, b]\nextract: [email]\n").unwrap();
        assert!(references_of(&node).is_none());
        assert!(size_of(&node).is_none());
        let parts = ref_parts(&References::One("noid".into()));
        assert!(parts[0].0.is_empty());
        assert!(!is_owner_identity_ref(&References::One(".id".into()), "self", &by_name));
        let extracted = extract_fields(vec![], Some(&["email".into()]));
        assert!(extracted.is_empty());
    }
}
