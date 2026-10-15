//! Source positions for YAML documents, matching `yamlPositions.ts`.

use saphyr::{LoadableYamlNode, MarkedYamlOwned, ScalarOwned, YamlDataOwned};
use serde_json::{Map, Number, Value};

#[derive(Clone, Debug)]
pub struct PosNode {
    pub line: u32,
    pub col: u32,
    pub kind: PosKind,
}

#[derive(Clone, Debug)]
pub enum PosKind {
    Scalar,
    Seq(Vec<PosNode>),
    Map(Vec<(String, PosNode)>),
}

#[derive(Clone, Debug)]
pub struct ParsedYaml {
    pub data: Value,
    pub root: Option<PosNode>,
    pub errors: Vec<YamlSyntaxError>,
}

#[derive(Clone, Debug)]
pub struct YamlSyntaxError {
    pub line: u32,
    pub col: u32,
    pub message: String,
}

pub fn parse_yaml_with_positions(text: &str) -> ParsedYaml {
    match MarkedYamlOwned::load_from_str(text) {
        Ok(docs) => {
            let Some(first) = docs.into_iter().next() else {
                return ParsedYaml {
                    data: Value::Null,
                    root: None,
                    errors: Vec::new(),
                };
            };
            let (data, root) = convert(&first);
            ParsedYaml {
                data,
                root: Some(root),
                errors: Vec::new(),
            }
        }
        Err(err) => {
            let mark = err.marker();
            ParsedYaml {
                data: Value::Null,
                root: None,
                errors: vec![YamlSyntaxError {
                    line: mark.line().max(1) as u32,
                    col: mark.col().max(1) as u32,
                    message: err.info().to_string(),
                }],
            }
        }
    }
}

pub fn parse_json_pointer(pointer: &str) -> Vec<String> {
    if pointer.is_empty() {
        return Vec::new();
    }
    pointer
        .split('/')
        .skip(1)
        .map(|seg| seg.replace("~1", "/").replace("~0", "~"))
        .collect()
}

pub fn position_for(doc: &ParsedYaml, instance_path: &str) -> (u32, u32) {
    let segments = parse_json_pointer(instance_path);
    let Some(root) = &doc.root else {
        return (1, 1);
    };
    let node = node_at_path(root, &segments);
    (node.line.max(1), node.col.max(1))
}

fn node_at_path<'a>(node: &'a PosNode, segments: &[String]) -> &'a PosNode {
    let mut current = node;
    for seg in segments {
        match &current.kind {
            PosKind::Map(entries) => {
                if let Some((_, child)) = entries.iter().find(|(key, _)| key == seg) {
                    current = child;
                } else {
                    return current;
                }
            }
            PosKind::Seq(items) => {
                let Ok(idx) = seg.parse::<i64>() else {
                    return current;
                };
                if idx < 0 || idx as usize >= items.len() {
                    return current;
                }
                current = &items[idx as usize];
            }
            PosKind::Scalar => return current,
        }
    }
    current
}

pub fn entries(value: &Value) -> Option<Vec<(String, &Value)>> {
    match value {
        Value::Null => None,
        Value::Object(map) => Some(map.iter().map(|(k, v)| (k.clone(), v)).collect()),
        Value::Array(items) => Some(
            items
                .iter()
                .enumerate()
                .map(|(i, v)| (i.to_string(), v))
                .collect(),
        ),
        _ => None,
    }
}

pub fn single_key(value: &Value) -> Option<(String, &Value)> {
    let list = entries(value)?;
    let (key, body) = list.into_iter().next()?;
    if key.is_empty() {
        return None;
    }
    Some((key, body))
}

pub fn string_list(value: &Value) -> Option<Vec<String>> {
    let Value::Array(items) = value else {
        return None;
    };
    Some(
        items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
    )
}

fn convert(node: &MarkedYamlOwned) -> (Value, PosNode) {
    let line = node.span.start.line().max(1) as u32;
    let col = node.span.start.col().max(1) as u32;
    let (data, kind) = match &node.data {
        YamlDataOwned::Value(scalar) => (scalar_json(scalar), PosKind::Scalar),
        YamlDataOwned::Sequence(items) => {
            let mut values = Vec::new();
            let mut nodes = Vec::new();
            for item in items {
                let (value, pos) = convert(item);
                values.push(value);
                nodes.push(pos);
            }
            (Value::Array(values), PosKind::Seq(nodes))
        }
        YamlDataOwned::Mapping(map) => {
            let mut values = Map::new();
            let mut nodes = Vec::new();
            for (key, value) in map {
                let name = key_name(key);
                let (converted, pos) = convert(value);
                values.insert(name.clone(), converted);
                if let Some(existing) = nodes.iter_mut().find(|(k, _)| k == &name) {
                    existing.1 = pos;
                } else {
                    nodes.push((name, pos));
                }
            }
            (Value::Object(values), PosKind::Map(nodes))
        }
        YamlDataOwned::Tagged(_, inner) => return convert(inner),
        YamlDataOwned::Representation(text, _, _) => (Value::String(text.clone()), PosKind::Scalar),
        YamlDataOwned::Alias(_) | YamlDataOwned::BadValue => (Value::Null, PosKind::Scalar),
    };
    (data, PosNode { line, col, kind })
}

fn scalar_json(scalar: &ScalarOwned) -> Value {
    match scalar {
        ScalarOwned::Null => Value::Null,
        ScalarOwned::Boolean(flag) => Value::Bool(*flag),
        ScalarOwned::Integer(n) => Value::Number((*n).into()),
        ScalarOwned::FloatingPoint(n) => {
            let value = n.into_inner();
            if value.is_finite() && value.fract() == 0.0 && (i64::MIN as f64..=i64::MAX as f64).contains(&value)
            {
                Value::Number((value as i64).into())
            } else {
                Number::from_f64(value)
                    .map(Value::Number)
                    .unwrap_or(Value::Null)
            }
        }
        ScalarOwned::String(text) => Value::String(text.clone()),
    }
}

fn key_name(node: &MarkedYamlOwned) -> String {
    match &node.data {
        YamlDataOwned::Value(scalar) => match scalar {
            ScalarOwned::Null => "null".to_string(),
            ScalarOwned::Boolean(true) => "true".to_string(),
            ScalarOwned::Boolean(false) => "false".to_string(),
            ScalarOwned::Integer(n) => n.to_string(),
            ScalarOwned::FloatingPoint(n) => {
                let value = n.into_inner();
                if value.is_finite() && value.fract() == 0.0 {
                    format!("{}", value as i64)
                } else {
                    format!("{value}")
                }
            }
            ScalarOwned::String(text) => text.clone(),
        },
        YamlDataOwned::Sequence(items) => items.iter().map(key_name).collect::<Vec<_>>().join(","),
        YamlDataOwned::Mapping(_) => "[object Object]".to_string(),
        YamlDataOwned::Tagged(_, inner) => key_name(inner),
        YamlDataOwned::Representation(text, _, _) => text.clone(),
        YamlDataOwned::Alias(_) | YamlDataOwned::BadValue => "null".to_string(),
    }
}
