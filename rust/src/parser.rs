use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use regex::Regex;

use crate::compile_filter::{compile_types_filter, FilterCandidate, FilterPredicate};
use crate::datasource_type_tree::compare_by_datasource_type_order_with;
use crate::deterministic::{empty_routes, empty_services, ensure_health, Deterministic};
use crate::error::Error;
use crate::pluralize::{plural, singular};
use crate::reader::DeterministicReader;
use crate::specification::{
    mapping_of, primary_key_column, read_type_field, unique_lookup_fields, CustomRouteEntry,
    CustomServiceEntry, DatasourceFieldOverlay, DatasourceIndex, DatasourceTable, DirectFkDescriptor,
    M2mDescriptor, NestedRouteDescriptor, ParsedRoutes, ParsedServices, References, RouteByField,
    RouteCandidate, SeedRow, SeedValue, ServiceCandidate, Type, TypeKind, DATASOURCE_SEEDS_YAML,
    DATASOURCE_YAML, ROUTES_YAML, SERVICES_YAML, TYPES_YAML,
};
use crate::yaml_node::{YamlNode, YamlValue};

const SHORTHAND_VERB_RE: &str = r"^(?i)(get|put|delete)_";

pub struct DeterministicParser {
    reader: Box<dyn DeterministicReader>,
}

impl DeterministicParser {
    pub fn new(reader: impl DeterministicReader + 'static) -> Self {
        Self {
            reader: Box::new(reader),
        }
    }

    pub fn parse(&self, settings: &HashMap<String, String>) -> Result<Deterministic, Error> {
        self.parse_with(settings, |entity| entity.to_string())
    }

    pub fn parse_with(
        &self,
        settings: &HashMap<String, String>,
        service_class_name: impl Fn(&str) -> String,
    ) -> Result<Deterministic, Error> {
        let _ = settings;
        let reader = &self.reader;
        let has_types = reader.exists(TYPES_YAML);
        let has_ds = reader.exists(DATASOURCE_YAML);
        let has_seeds = reader.exists(DATASOURCE_SEEDS_YAML);
        let has_services = reader.exists(SERVICES_YAML);
        let has_routes = reader.exists(ROUTES_YAML);
        let types_yaml = if has_types { Some(reader.read(TYPES_YAML)?) } else { None };
        let datasource_yaml = if has_ds { Some(reader.read(DATASOURCE_YAML)?) } else { None };
        let seeds_yaml = if has_seeds {
            Some(reader.read(DATASOURCE_SEEDS_YAML)?)
        } else {
            None
        };
        let services_yaml = if has_services { Some(reader.read(SERVICES_YAML)?) } else { None };
        let routes_yaml = if has_routes { Some(reader.read(ROUTES_YAML)?) } else { None };

        let types = match &types_yaml {
            Some(yaml) => parse_types(yaml)?,
            None => Vec::new(),
        };
        let expanded_types = crate::specification::expand_types(&types)?;
        let datasource = match &datasource_yaml {
            Some(yaml) => parse_datasource(yaml, &expanded_types)?,
            None => Vec::new(),
        };
        let seeds = match &seeds_yaml {
            Some(yaml) => parse_datasource_seeds(yaml)?,
            None => IndexMap::new(),
        };
        let services = match &services_yaml {
            Some(yaml) => parse_services(yaml, &expanded_types, &datasource, routes_yaml.as_deref(), &service_class_name)?,
            None => empty_services(),
        };
        let routes = match &routes_yaml {
            Some(yaml) => parse_routes(yaml, &expanded_types, &datasource)?,
            None => empty_routes(datasource.clone()),
        };
        Ok(ensure_health(Deterministic::new(
            types,
            expanded_types,
            datasource,
            seeds,
            services,
            routes,
        )))
    }
}

pub fn inherits_chain(name: &str, type_by_name: &IndexMap<String, Type>) -> Vec<String> {
    let mut chain = Vec::new();
    let mut seen = HashSet::from([name.to_string()]);
    let mut current = type_by_name.get(name).and_then(|type_def| type_def.inherits.clone());
    while let Some(next) = current {
        if next == "set" || next == "dictionary" || seen.contains(&next) {
            break;
        }
        seen.insert(next.clone());
        chain.push(next.clone());
        current = type_by_name.get(&next).and_then(|type_def| type_def.inherits.clone());
    }
    chain
}

fn parse_types(yaml: &str) -> Result<Vec<Type>, Error> {
    let root = YamlNode::from_yaml(yaml)?;
    Ok(root
        .named_list("types")
        .into_iter()
        .map(|entry| {
            let kind = if entry.node.str("inherits").is_some() {
                TypeKind::Inherit
            } else if matches!(entry.node.child("union").value(), Some(YamlValue::Array(_))) {
                TypeKind::Union
            } else {
                TypeKind::Shaped
            };
            let mapping = mapping_of(&entry.node);
            let extract = nonempty_strings(&entry.node, "extract");
            let remove_fields = nonempty_strings(&entry.node, "remove_fields");
            let ids = nonempty_strings(&entry.node, "ids");
            let union = if matches!(entry.node.child("union").value(), Some(YamlValue::Array(_))) {
                Some(entry.node.strings("union"))
            } else {
                None
            };
            Type {
                name: entry.name,
                tags: entry.node.strings("tags"),
                kind,
                inherits: entry.node.str("inherits"),
                union,
                mapping,
                extract,
                remove_fields,
                ids,
                fields: entry
                    .node
                    .named_list("fields")
                    .into_iter()
                    .map(|field| read_type_field(&field.name, &field.node))
                    .collect(),
            }
        })
        .collect())
}

fn nonempty_strings(node: &YamlNode, key: &str) -> Option<Vec<String>> {
    let values = node.strings(key);
    if values.is_empty() { None } else { Some(values) }
}

fn parse_datasource(yaml: &str, types: &[Type]) -> Result<Vec<DatasourceTable>, Error> {
    let root = YamlNode::from_yaml(yaml)?;
    let tables: Vec<DatasourceTable> = root
        .named_list("types")
        .into_iter()
        .map(|entry| {
            let mut unique_index_fields = Vec::new();
            let mut indexes = Vec::new();
            for index in entry.node.named_list("indexes") {
                let fields = match index.node.child("fields").value() {
                    Some(YamlValue::Array(items)) => items
                        .iter()
                        .filter_map(|item| match item {
                            YamlValue::String(value) => Some(value.clone()),
                            _ => None,
                        })
                        .collect::<Vec<_>>(),
                    _ => Vec::new(),
                };
                let is_unique = index.node.bool("is_unique");
                if is_unique && fields.len() == 1 && !fields[0].is_empty() {
                    unique_index_fields.push(fields[0].clone());
                }
                indexes.push(DatasourceIndex {
                    name: index.name,
                    fields,
                    is_unique,
                });
            }
            let fields = entry
                .node
                .named_list("fields")
                .into_iter()
                .map(|field| DatasourceFieldOverlay {
                    name: field.name.clone(),
                    is_readonly: field.node.has("is_readonly").then(|| field.node.bool("is_readonly")),
                    is_unique: field.node.has("is_unique").then(|| field.node.bool("is_unique")),
                    mapping: field.node.str("mapping").filter(|value| !value.is_empty()),
                    is_fixed_id: field.node.has("is_fixed_id").then(|| field.node.bool("is_fixed_id")),
                    include_in_create: field
                        .node
                        .has("include_in_create")
                        .then(|| field.node.bool("include_in_create")),
                    include_in_update: field
                        .node
                        .has("include_in_update")
                        .then(|| field.node.bool("include_in_update")),
                    is_optimistic_concurrency: field
                        .node
                        .has("is_optimistic_concurrency")
                        .then(|| field.node.bool("is_optimistic_concurrency")),
                    use_native_row_version: field
                        .node
                        .has("use_native_row_version")
                        .then(|| field.node.bool("use_native_row_version")),
                })
                .collect();
            DatasourceTable {
                name: entry.name,
                mapping: entry.node.str("mapping").filter(|value| !value.is_empty()),
                fields,
                indexes,
                unique_index_fields,
                use_optimistic_concurrency: entry
                    .node
                    .has("use_optimistic_concurrency")
                    .then(|| entry.node.bool("use_optimistic_concurrency")),
            }
        })
        .collect();
    let Some(filter) = types_filter(&root)? else {
        return Ok(merge_write_inclusion(tables.clone(), types, &tables));
    };
    let selected: HashSet<String> = types
        .iter()
        .filter(|type_def| filter(&candidate_of(type_def)))
        .map(|type_def| type_def.name.clone())
        .collect();
    let overlay_names: HashSet<String> = tables.iter().map(|table| table.name.clone()).collect();
    let extras = types
        .iter()
        .filter(|type_def| selected.contains(&type_def.name) && !overlay_names.contains(&type_def.name))
        .map(|type_def| DatasourceTable {
            name: type_def.name.clone(),
            mapping: None,
            fields: Vec::new(),
            indexes: Vec::new(),
            unique_index_fields: Vec::new(),
            use_optimistic_concurrency: None,
        })
        .collect::<Vec<_>>();
    let mut out = tables
        .iter()
        .filter(|table| selected.contains(&table.name))
        .cloned()
        .collect::<Vec<_>>();
    out.extend(extras);
    Ok(merge_write_inclusion(out, types, &tables))
}

fn first_authored_inclusion<F>(
    walk: &[String],
    overlays: &HashMap<String, HashMap<String, DatasourceFieldOverlay>>,
    field: &str,
    key: F,
) -> Option<bool>
where
    F: Fn(&DatasourceFieldOverlay) -> Option<bool> + Copy,
{
    walk.iter().find_map(|type_name| {
        overlays
            .get(type_name)
            .and_then(|fields| fields.get(field))
            .and_then(key)
    })
}

fn merge_write_inclusion(
    tables: Vec<DatasourceTable>,
    types: &[Type],
    authored: &[DatasourceTable],
) -> Vec<DatasourceTable> {
    let type_by_name: IndexMap<String, Type> = types
        .iter()
        .map(|type_def| (type_def.name.clone(), type_def.clone()))
        .collect();
    let overlays: HashMap<String, HashMap<String, DatasourceFieldOverlay>> = authored
        .iter()
        .map(|table| {
            (
                table.name.clone(),
                table
                    .fields
                    .iter()
                    .map(|field| (field.name.clone(), field.clone()))
                    .collect(),
            )
        })
        .collect();
    tables
        .into_iter()
        .map(|table| {
            let mut walk = vec![table.name.clone()];
            walk.extend(inherits_chain(&table.name, &type_by_name));
            let mut names = Vec::new();
            let mut seen = HashSet::new();
            let mut add = |name: &str| {
                if seen.insert(name.to_string()) {
                    names.push(name.to_string());
                }
            };
            if let Some(type_def) = type_by_name.get(&table.name) {
                for field in &type_def.fields {
                    add(&field.name);
                }
            }
            for field in &table.fields {
                add(&field.name);
            }
            let mut fields = table.fields.clone();
            for name in names {
                let include_in_create =
                    first_authored_inclusion(&walk, &overlays, &name, |field| field.include_in_create);
                let include_in_update =
                    first_authored_inclusion(&walk, &overlays, &name, |field| field.include_in_update);
                if include_in_create.is_none() && include_in_update.is_none() {
                    continue;
                }
                if let Some(existing) = fields.iter_mut().find(|field| field.name == name) {
                    if include_in_create.is_some() {
                        existing.include_in_create = include_in_create;
                    }
                    if include_in_update.is_some() {
                        existing.include_in_update = include_in_update;
                    }
                } else {
                    fields.push(DatasourceFieldOverlay {
                        name,
                        is_readonly: None,
                        is_unique: None,
                        mapping: None,
                        is_fixed_id: None,
                        include_in_create,
                        include_in_update,
                        is_optimistic_concurrency: None,
                        use_native_row_version: None,
                    });
                }
            }
            DatasourceTable { fields, ..table }
        })
        .collect()
}

fn parse_datasource_seeds(yaml: &str) -> Result<IndexMap<String, Vec<SeedRow>>, Error> {
    let mut by_table = IndexMap::new();
    for entry in YamlNode::from_yaml(yaml)?.named_list("seeds") {
        let mut rows = Vec::new();
        for row in entry.node.named_items() {
            rows.push(SeedRow {
                id: parse_seed_key(&row.name)?,
                row: seed_cells(&row.node),
            });
        }
        by_table.insert(entry.name, rows);
    }
    Ok(by_table)
}

fn parse_seed_key(row_key: &str) -> Result<i64, Error> {
    let re = Regex::new(r"^id(\d+)$").unwrap();
    let Some(caps) = re.captures(row_key) else {
        return Err(Error::new(format!(
            "Invalid seed row key \"{row_key}\": expected pattern /^id\\d+$/"
        )));
    };
    Ok(caps[1].parse().unwrap_or(0))
}

fn seed_cells(node: &YamlNode) -> IndexMap<String, SeedValue> {
    let Some(record) = node.record() else {
        return IndexMap::new();
    };
    let mut out = IndexMap::new();
    for key in record.keys() {
        if let Some(value) = node.literal(key) {
            if let Some(seed) = Option::<SeedValue>::from(value) {
                out.insert(key.clone(), seed);
            }
        }
    }
    out
}

#[inline(never)]
fn types_filter(root: &YamlNode) -> Result<Option<FilterPredicate>, Error> {
    let Some(block) = include_block(root, "types") else {
        return Ok(None);
    };
    Ok(Some(compile_types_filter(block.str("filter").as_deref())?))
}

#[inline(never)]
fn include_block(root: &YamlNode, key: &str) -> Option<YamlNode> {
    for entry in root.child("includes").items() {
        if entry.child(key).record().is_some() {
            return Some(entry.child(key));
        }
    }
    None
}

fn candidate_of(type_def: &Type) -> FilterCandidate {
    FilterCandidate {
        name: type_def.name.clone(),
        tags: type_def.tags.clone(),
        inherits: type_def.inherits.clone(),
    }
}

fn parse_services(
    services_yaml: &str,
    types: &[Type],
    datasource: &[DatasourceTable],
    routes_yaml: Option<&str>,
    service_class_name: &impl Fn(&str) -> String,
) -> Result<ParsedServices, Error> {
    let root = YamlNode::from_yaml(services_yaml)?;
    let raw_services = root
        .child("services")
        .items()
        .into_iter()
        .filter_map(|entry| {
            let name = entry.str("name")?;
            Some((name, entry.str("module")))
        })
        .collect::<Vec<_>>();
    let custom_entries: Vec<_> = raw_services
        .into_iter()
        .filter(|(_, module)| {
            !module
                .as_deref()
                .is_some_and(|value| value.starts_with("./services/generated/"))
        })
        .collect();
    let explicit_custom_names: HashSet<String> = custom_entries.iter().map(|(name, _)| name.clone()).collect();
    let methods_by_service = collect_route_service_methods(routes_yaml)?;
    let ds_by_name: HashMap<&str, &DatasourceTable> =
        datasource.iter().map(|table| (table.name.as_str(), table)).collect();
    let mut generics = Vec::new();
    if let Some(predicate) = types_filter(&root)? {
        let compare = compare_by_datasource_type_order_with(types, |name| {
            types.iter().find(|type_def| type_def.name == name).and_then(|type_def| type_def.inherits.clone())
        });
        let mut selected: Vec<&Type> = types
            .iter()
            .filter(|type_def| predicate(&candidate_of(type_def)))
            .filter(|type_def| !explicit_custom_names.contains(&service_class_name(&type_def.name)))
            .collect();
        selected.sort_by(|a, b| compare(&a.name, &b.name).cmp(&0));
        generics = selected
            .into_iter()
            .map(|type_def| ServiceCandidate {
                name: type_def.name.clone(),
                tags: type_def.tags.clone(),
                inherits: type_def.inherits.clone(),
                by_fields: unique_lookup_fields(type_def, ds_by_name.get(type_def.name.as_str()).copied()),
            })
            .collect();
    }
    let customs = custom_entries
        .into_iter()
        .map(|(name, module)| {
            let mut methods = methods_by_service.get(&name).cloned().unwrap_or_default().into_iter().collect::<Vec<_>>();
            methods.sort();
            CustomServiceEntry { name, module, methods }
        })
        .collect();
    Ok(ParsedServices { generics, customs })
}

fn parse_routes(routes_yaml: &str, types: &[Type], datasource: &[DatasourceTable]) -> Result<ParsedRoutes, Error> {
    let root = YamlNode::from_yaml(routes_yaml)?;
    let ds_by_name: HashMap<String, DatasourceTable> =
        datasource.iter().map(|table| (table.name.clone(), table.clone())).collect();
    let type_by_name: IndexMap<String, Type> = types.iter().map(|type_def| (type_def.name.clone(), type_def.clone())).collect();
    let overlays = entity_overlays(&root);
    let mut all_candidates = types
        .iter()
        .map(|type_def| {
            let overlay = overlays.get(&type_def.name);
            RouteCandidate {
                name: type_def.name.clone(),
                tags: type_def.tags.clone(),
                inherits: type_def.inherits.clone(),
                by_fields: Vec::new(),
                eager_read_path: overlay.and_then(|item| item.eager_read_path.clone()),
                eager_update_path: overlay.and_then(|item| item.eager_update_path.clone()),
                eager_read_member_only: overlay.and_then(|item| item.eager_read_member_only.clone()),
            }
        })
        .collect::<Vec<_>>();
    let children_only = collect_combined_child_names(&root, &type_by_name)?;
    attach_by_fields(&mut all_candidates, &root, &ds_by_name, &type_by_name)?;
    let customs = extract_custom_routes(&root, &type_by_name)?;
    let nested = collect_nested_descriptors(&root, &type_by_name)?;
    let mut candidates = Vec::new();
    if let Some(predicate) = types_filter(&root)? {
        let compare = compare_by_datasource_type_order_with(types, |name| {
            type_by_name.get(name).and_then(|type_def| type_def.inherits.clone())
        });
        candidates = all_candidates
            .into_iter()
            .filter(|candidate| {
                predicate(&FilterCandidate {
                    name: candidate.name.clone(),
                    tags: candidate.tags.clone(),
                    inherits: candidate.inherits.clone(),
                })
            })
            .filter(|candidate| !children_only.contains(&candidate.name))
            .collect::<Vec<_>>();
        candidates.sort_by(|a, b| compare(&a.name, &b.name).cmp(&0));
    }
    Ok(ParsedRoutes {
        candidates,
        customs,
        nested,
        children_only,
        datasource: datasource.to_vec(),
    })
}

struct Overlay {
    eager_read_path: Option<Vec<String>>,
    eager_update_path: Option<Vec<String>>,
    eager_read_member_only: Option<Vec<String>>,
}

fn entity_overlays(root: &YamlNode) -> HashMap<String, Overlay> {
    let mut out = HashMap::new();
    for entry in root.named_list("routes") {
        let read = entry.node.strings("eager_read_path");
        let update = entry.node.strings("eager_update_path");
        let member = entry.node.strings("eager_read_member_only");
        if read.is_empty() && update.is_empty() && member.is_empty() {
            continue;
        }
        out.insert(
            entry.name,
            Overlay {
                eager_read_path: (!read.is_empty()).then_some(read),
                eager_update_path: (!update.is_empty()).then_some(update),
                eager_read_member_only: (!member.is_empty()).then_some(member),
            },
        );
    }
    out
}

fn collect_route_service_methods(routes_yaml: Option<&str>) -> Result<HashMap<String, HashSet<String>>, Error> {
    let mut by_service = HashMap::new();
    let Some(routes_yaml) = routes_yaml else {
        return Ok(by_service);
    };
    let root = YamlNode::from_yaml(routes_yaml)?;
    fn visit(node: &YamlNode, by_service: &mut HashMap<String, HashSet<String>>) {
        match node.value() {
            Some(YamlValue::Array(_)) => {
                for item in node.items() {
                    visit(&item, by_service);
                }
            }
            Some(YamlValue::Map(map)) => {
                if let (Some(service), Some(function)) = (node.str("service"), node.str("function")) {
                    by_service.entry(service).or_default().insert(function);
                }
                for key in map.keys() {
                    visit(&node.child(key), by_service);
                }
            }
            _ => {}
        }
    }
    visit(&root.child("routes"), &mut by_service);
    visit(&root.child("combined_routes"), &mut by_service);
    Ok(by_service)
}

fn spec_name(raw: &str) -> String {
    raw.replace('-', "_")
}

fn spec_plural(name: &str) -> String {
    let mut parts: Vec<String> = spec_name(name).split('_').map(str::to_string).collect();
    if let Some(last) = parts.last_mut() {
        *last = plural(last);
    }
    parts.join("_")
}

fn shorthand_field(raw: &str) -> String {
    let named = spec_name(raw);
    let re = Regex::new(r"([a-z0-9])([A-Z])").unwrap();
    re.replace_all(&named, "${1}_${2}").to_lowercase()
}

fn default_parent_base_path(parent_name: &str) -> String {
    format!("/api/{}/{{id}}", spec_plural(parent_name))
}

fn segment_tail_of(segment: &str) -> String {
    segment
        .split('/')
        .filter(|part| !part.is_empty())
        .next_back()
        .unwrap_or("")
        .to_string()
}

fn default_child_segment(name: &str) -> String {
    format!("/{}", spec_plural(name))
}

fn column_is_unique(table: Option<&DatasourceTable>, type_def: Option<&Type>, column_name: &str) -> bool {
    if column_name == primary_key_column(table, type_def) {
        return true;
    }
    if table.is_some_and(|table| {
        table
            .fields
            .iter()
            .any(|field| field.name == column_name && field.is_unique == Some(true))
    }) {
        return true;
    }
    table.is_some_and(|table| table.unique_index_fields.iter().any(|field| field == column_name))
}

fn singularize_last_token(snake_plural: &str) -> String {
    let mut parts: Vec<String> = snake_plural.split('_').map(str::to_string).collect();
    if let Some(last) = parts.last_mut() {
        *last = singular(last);
    }
    parts.join("_")
}

fn entity_has_field(type_def: &Type, field_name: &str) -> bool {
    field_name == "id" || type_def.fields.iter().any(|field| field.name == field_name)
}

struct ByFieldParsed {
    entity: String,
    by_field: String,
    methods: Option<Vec<String>>,
}

fn parse_verb(token: &str) -> (Option<Vec<String>>, String) {
    let re = Regex::new(SHORTHAND_VERB_RE).unwrap();
    let Some(caps) = re.captures(token) else {
        return (None, token.to_string());
    };
    let verb = caps[1].to_lowercase();
    let methods = match verb.as_str() {
        "get" => Some(vec!["GET".to_string()]),
        "put" => Some(vec!["PUT".to_string()]),
        _ => Some(vec!["DELETE".to_string()]),
    };
    (methods, token[caps.get(0).unwrap().end()..].to_string())
}

fn split_entity_field(token: &str, body: &str) -> Result<(String, String), Error> {
    let Some(split_idx) = body.rfind("_by_") else {
        return Err(Error::new(format!(
            "parseByFieldEntry: route key `{token}` is missing `_by_` separator"
        )));
    };
    let plural_snake = &body[..split_idx];
    let field_token = &body[split_idx + "_by_".len()..];
    if plural_snake.is_empty() || field_token.is_empty() {
        return Err(Error::new(format!(
            "parseByFieldEntry: route key `{token}` has empty entity or field around `_by_`"
        )));
    }
    Ok((singularize_last_token(plural_snake), shorthand_field(field_token)))
}

fn parse_shorthand_by_field(token: &str, type_by_name: &IndexMap<String, Type>) -> Result<ByFieldParsed, Error> {
    if token.is_empty() {
        return Err(Error::new(
            "parseByFieldEntry: expected non-empty string token".to_string(),
        ));
    }
    let (methods, body) = parse_verb(token);
    let (entity, by_field) = split_entity_field(token, &body)?;
    let Some(type_def) = type_by_name.get(&entity) else {
        return Err(Error::new(format!(
            "parseByFieldEntry: unknown entity `{entity}` in route `{token}`"
        )));
    };
    if !entity_has_field(type_def, &by_field) {
        return Err(Error::new(format!(
            "parseByFieldEntry: field `{by_field}` not found on entity `{entity}` in route `{token}`"
        )));
    }
    Ok(ByFieldParsed {
        entity,
        by_field,
        methods,
    })
}

fn parse_verbose_by_field(key: &str, node: &YamlNode) -> Result<ByFieldParsed, Error> {
    let (Some(entity), Some(by_field)) = (node.str("entity"), node.str("byField")) else {
        return Err(Error::new(format!(
            "parseByFieldEntry: route `{key}` has non-string entity/byField"
        )));
    };
    let methods = match node.child("methods").value() {
        Some(YamlValue::Array(items)) => Some(
            items
                .iter()
                .filter_map(|item| match item {
                    YamlValue::String(value) => Some(value.clone()),
                    _ => None,
                })
                .collect(),
        ),
        _ => None,
    };
    Ok(ByFieldParsed {
        entity,
        by_field,
        methods,
    })
}

fn parse_by_field_entry(value: Option<&YamlValue>, type_by_name: &IndexMap<String, Type>) -> Result<Option<ByFieldParsed>, Error> {
    let Some(value) = value else {
        return Ok(None);
    };
    match value {
        YamlValue::String(token) => Ok(Some(parse_shorthand_by_field(token, type_by_name)?)),
        YamlValue::Map(map) => {
            let Some((key, body)) = map.iter().next() else {
                return Ok(None);
            };
            if matches!(body, YamlValue::Null) {
                return Ok(Some(parse_shorthand_by_field(key, type_by_name)?));
            }
            let YamlValue::Map(_) = body else {
                return Ok(None);
            };
            let child = YamlNode::from_value(body.clone());
            if child.has("entity") && child.has("byField") {
                return Ok(Some(parse_verbose_by_field(key, &child)?));
            }
            Ok(None)
        }
        _ => Ok(None),
    }
}

fn ref_parent(references: &References) -> Option<String> {
    match references {
        References::One(value) => value.split('.').next().map(str::to_string),
        References::Pair(_, _) => None,
    }
}

fn ref_matches_parent(target: &str, parent: &str, type_by_name: &IndexMap<String, Type>) -> bool {
    parent == target || inherits_chain(parent, type_by_name).iter().any(|name| name == target)
}

fn fk_fields<'a>(type_def: &'a Type, type_by_name: &'a IndexMap<String, Type>) -> Vec<&'a crate::specification::TypeField> {
    let mut fields: Vec<_> = type_def.fields.iter().collect();
    for ancestor in inherits_chain(&type_def.name, type_by_name) {
        if let Some(parent) = type_by_name.get(&ancestor) {
            fields.extend(parent.fields.iter());
        }
    }
    fields
}

fn find_foreign_key_to(child: &Type, parent_name: &str, type_by_name: &IndexMap<String, Type>) -> Option<String> {
    for field in fk_fields(child, type_by_name) {
        let Some(references) = &field.references else {
            continue;
        };
        let Some(target) = ref_parent(references) else {
            continue;
        };
        if ref_matches_parent(&target, parent_name, type_by_name) {
            return Some(field.name.clone());
        }
    }
    None
}

#[derive(Clone)]
struct NormalizedChild {
    name: String,
    via: Option<String>,
    target: Option<String>,
    route: Option<String>,
}

fn combined_children(node: &YamlNode) -> Vec<NormalizedChild> {
    let child = node.child("combines");
    let Some(YamlValue::Array(items)) = child.value() else {
        return Vec::new();
    };
    items.iter().filter_map(normalize_combined_child).collect()
}

fn normalize_combined_child(child: &YamlValue) -> Option<NormalizedChild> {
    match child {
        YamlValue::String(name) => Some(NormalizedChild {
            name: spec_name(name),
            via: None,
            target: None,
            route: None,
        }),
        YamlValue::Map(map) => {
            let (raw_name, body) = map.iter().next()?;
            let body_node = YamlNode::from_value(body.clone());
            Some(NormalizedChild {
                name: spec_name(raw_name),
                via: body_node.str("via"),
                target: body_node.str("target"),
                route: body_node.str("route"),
            })
        }
        _ => None,
    }
}

fn collect_combined_child_names(root: &YamlNode, type_by_name: &IndexMap<String, Type>) -> Result<HashSet<String>, Error> {
    let mut children_only = HashSet::new();
    let parents: HashSet<String> = root.named_list("combined_routes").into_iter().map(|entry| entry.name).collect();
    for entry in root.named_list("combined_routes") {
        for child in combined_children(&entry.node) {
            if child.via.is_some() || child.target.is_some() {
                continue;
            }
            if parents.contains(&child.name) {
                continue;
            }
            let Some(child_type) = type_by_name.get(&child.name) else {
                continue;
            };
            if find_foreign_key_to(child_type, &entry.name, type_by_name).is_some() {
                children_only.insert(child.name);
            }
        }
    }
    Ok(children_only)
}

fn upsert_by_field(
    list: &mut Vec<RouteByField>,
    parsed: &ByFieldParsed,
    ds_by_name: &HashMap<String, DatasourceTable>,
    type_by_name: &IndexMap<String, Type>,
) {
    if let Some(existing) = list.iter_mut().find(|entry| entry.by_field == parsed.by_field) {
        if existing.methods.is_none() || parsed.methods.is_none() {
            existing.methods = None;
        } else if let Some(incoming) = &parsed.methods {
            let mut union = existing.methods.clone().unwrap_or_default();
            for method in incoming {
                if !union.iter().any(|item| item == method) {
                    union.push(method.clone());
                }
            }
            existing.methods = Some(union);
        }
        return;
    }
    list.push(RouteByField {
        by_field: parsed.by_field.clone(),
        methods: parsed.methods.clone(),
        by_field_unique: column_is_unique(
            ds_by_name.get(&parsed.entity),
            type_by_name.get(&parsed.entity),
            &parsed.by_field,
        ),
    });
}

fn attach_by_fields(
    candidates: &mut [RouteCandidate],
    root: &YamlNode,
    ds_by_name: &HashMap<String, DatasourceTable>,
    type_by_name: &IndexMap<String, Type>,
) -> Result<(), Error> {
    let mut by_field_by_entity: HashMap<String, Vec<RouteByField>> = HashMap::new();
    for entry in root.child("routes").items() {
        let Some(parsed) = parse_by_field_entry(entry.value(), type_by_name)? else {
            continue;
        };
        let list = by_field_by_entity.entry(parsed.entity.clone()).or_default();
        upsert_by_field(list, &parsed, ds_by_name, type_by_name);
    }
    for candidate in candidates {
        if let Some(list) = by_field_by_entity.get(&candidate.name) {
            if !list.is_empty() {
                candidate.by_fields = list.clone();
            }
        }
    }
    Ok(())
}

fn extract_custom_routes(root: &YamlNode, type_by_name: &IndexMap<String, Type>) -> Result<Vec<CustomRouteEntry>, Error> {
    let mut customs = Vec::new();
    for entry in root.child("routes").items() {
        if entry.record().is_none() {
            continue;
        }
        if parse_by_field_entry(entry.value(), type_by_name)?.is_some() {
            continue;
        }
        let Some(name) = entry.record().and_then(|map| map.keys().next().cloned()) else {
            continue;
        };
        let node = entry.child(&name);
        if node.has("eager_read_path") || node.has("eager_update_path") || node.has("eager_read_member_only") {
            continue;
        }
        if node.str("path").is_none() {
            continue;
        }
        customs.push(CustomRouteEntry {
            name,
            path: node.str("path"),
            method: node.str("method"),
            entity: node.str("entity"),
            request: node.str("request"),
            response: node.str("response"),
            module: node.str("module"),
            route_class: node.str("routeClass"),
        });
    }
    Ok(customs)
}

struct JunctionMatch {
    name: String,
    parent_fk: String,
    child_fk: String,
}

fn detect_junction(parent_name: &str, child_name: &str, type_by_name: &IndexMap<String, Type>) -> Result<Option<JunctionMatch>, Error> {
    let mut matches = Vec::new();
    for (name, def) in type_by_name {
        if name == parent_name || name == child_name || !def.tags.iter().any(|tag| tag == "many_to_many") {
            continue;
        }
        let Some(parent_fk) = find_foreign_key_to(def, parent_name, type_by_name) else {
            continue;
        };
        let Some(child_fk) = find_foreign_key_to(def, child_name, type_by_name) else {
            continue;
        };
        matches.push(JunctionMatch {
            name: name.clone(),
            parent_fk,
            child_fk,
        });
    }
    if matches.is_empty() {
        return Ok(None);
    }
    if matches.len() > 1 {
        let candidates = matches.iter().map(|item| item.name.as_str()).collect::<Vec<_>>().join(", ");
        return Err(Error::new(format!(
            "combined_routes: ambiguous junction between \"{parent_name}\" and \"{child_name}\" — candidates: {candidates}. Add via: to disambiguate."
        )));
    }
    Ok(matches.into_iter().next())
}

fn m2m_descriptor(parent_name: &str, parent_base_path: &str, junction: &str, target: &str, parent_fk: &str, child_fk: &str, route: Option<&str>) -> NestedRouteDescriptor {
    let segment = route
        .map(str::to_string)
        .unwrap_or_else(|| default_child_segment(target));
    NestedRouteDescriptor::M2m(M2mDescriptor {
        parent: parent_name.to_string(),
        parent_base_path: parent_base_path.to_string(),
        parent_param: parent_name.to_string(),
        junction: junction.to_string(),
        target: target.to_string(),
        target_param: target.to_string(),
        parent_fk_field: parent_fk.to_string(),
        child_fk_field: child_fk.to_string(),
        segment_tail: segment_tail_of(&segment),
        segment,
    })
}

fn direct_fk_descriptor(parent_name: &str, parent_base_path: &str, child_name: &str, fk_column: &str, route: Option<&str>) -> NestedRouteDescriptor {
    let segment = route
        .map(str::to_string)
        .unwrap_or_else(|| default_child_segment(child_name));
    NestedRouteDescriptor::DirectFk(DirectFkDescriptor {
        parent: parent_name.to_string(),
        parent_base_path: parent_base_path.to_string(),
        parent_param: parent_name.to_string(),
        child: child_name.to_string(),
        fk_column: fk_column.to_string(),
        segment_tail: segment_tail_of(&segment),
        segment,
    })
}

fn parent_base_path(node: &YamlNode, parent_name: &str) -> String {
    match node.str("route") {
        Some(route) if !route.is_empty() => route,
        _ => default_parent_base_path(parent_name),
    }
}

fn collect_nested_descriptors(root: &YamlNode, type_by_name: &IndexMap<String, Type>) -> Result<Vec<NestedRouteDescriptor>, Error> {
    let mut nested = Vec::new();
    for entry in root.named_list("combined_routes") {
        let parent_base = parent_base_path(&entry.node, &entry.name);
        for child in combined_children(&entry.node) {
            if child.via.is_some() || child.target.is_some() {
                let (Some(junction_name), Some(target_name)) = (child.via.clone(), child.target.clone()) else {
                    return Err(Error::new(format!(
                        "combined_routes: M2M child must declare both via: and target: (parent={}, child={})",
                        entry.name, child.name
                    )));
                };
                let Some(junction_def) = type_by_name.get(&junction_name) else {
                    return Err(Error::new(format!(
                        "combined_routes: junction \"{junction_name}\" not found in types.yaml"
                    )));
                };
                let Some(parent_fk) = find_foreign_key_to(junction_def, &entry.name, type_by_name) else {
                    return Err(Error::new(format!(
                        "combined_routes: junction \"{junction_name}\" missing FK to {}/{target_name}",
                        entry.name
                    )));
                };
                let Some(child_fk) = find_foreign_key_to(junction_def, &target_name, type_by_name) else {
                    return Err(Error::new(format!(
                        "combined_routes: junction \"{junction_name}\" missing FK to {}/{target_name}",
                        entry.name
                    )));
                };
                nested.push(m2m_descriptor(
                    &entry.name,
                    &parent_base,
                    &junction_name,
                    &target_name,
                    &parent_fk,
                    &child_fk,
                    child.route.as_deref(),
                ));
                continue;
            }
            let Some(child_def) = type_by_name.get(&child.name) else {
                return Err(Error::new(format!(
                    "combined_routes: child \"{}\" not found in types.yaml",
                    child.name
                )));
            };
            if let Some(fk_column) = find_foreign_key_to(child_def, &entry.name, type_by_name) {
                nested.push(direct_fk_descriptor(
                    &entry.name,
                    &parent_base,
                    &child.name,
                    &fk_column,
                    child.route.as_deref(),
                ));
                continue;
            }
            if let Some(junction) = detect_junction(&entry.name, &child.name, type_by_name)? {
                nested.push(m2m_descriptor(
                    &entry.name,
                    &parent_base,
                    &junction.name,
                    &child.name,
                    &junction.parent_fk,
                    &junction.child_fk,
                    child.route.as_deref(),
                ));
                continue;
            }
            return Err(Error::new(format!(
                "combined_routes: child \"{}\" has no FK to parent \"{}\" and no detectable junction table in types.yaml",
                child.name, entry.name
            )));
        }
    }
    Ok(nested)
}
