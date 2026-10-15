use indexmap::IndexMap;
use saphyr::LoadableYamlNode;

use crate::error::Error;

/// Scalar YAML value. Non-finite numbers (`.inf`) stay numbers and fail `finite_*`.
#[derive(Debug, Clone, PartialEq)]
pub enum YamlLiteral {
    String(String),
    Number(f64),
    Bool(bool),
    Null,
}

#[derive(Debug, Clone, PartialEq)]
pub enum YamlValue {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<YamlValue>),
    Map(IndexMap<String, YamlValue>),
}

impl YamlValue {
    fn as_map(&self) -> Option<&IndexMap<String, YamlValue>> {
        match self {
            Self::Map(map) => Some(map),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_covers_tags_aliases_and_complex_keys() {
        let node = YamlNode::from_yaml("a: 1\n").unwrap();
        assert_eq!(node.path(), "$");
        assert!(node.value().unwrap().as_map().is_some() || node.record().is_some());
        assert!(YamlValue::String("a".into()).as_map().is_none());
        let tagged = YamlNode::from_yaml("!tag hello\n").unwrap();
        assert!(matches!(tagged.value(), Some(YamlValue::String(_))));
        let alias = YamlNode::from_yaml("a: &anchor 1\nb: *anchor\n").unwrap();
        assert!(alias.child("b").value().is_some());
        let complex = YamlNode::from_yaml("? { nested: 1 }\n: 2\n1: x\ntrue: y\nnull: z\n1.5: q\n").unwrap();
        assert!(complex.record().is_some());
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Named {
    pub name: String,
    pub node: YamlNode,
}

/// Typed cursor over a YAML value. Missing keys are empty nodes, not errors.
#[derive(Debug, Clone, PartialEq)]
pub struct YamlNode {
    value: Option<YamlValue>,
    path: String,
}

impl YamlNode {
    pub fn from_yaml(text: &str) -> Result<Self, Error> {
        Self::from_yaml_at(text, "$")
    }

    pub fn from_yaml_at(text: &str, path: &str) -> Result<Self, Error> {
        let docs = saphyr::Yaml::load_from_str(text).map_err(|err| Error::new(err.to_string()))?;
        let value = docs.first().map(convert);
        Ok(Self {
            value,
            path: path.to_string(),
        })
    }

    pub(crate) fn from_value(value: YamlValue) -> Self {
        Self {
            value: Some(value),
            path: "$".to_string(),
        }
    }

    pub fn value(&self) -> Option<&YamlValue> {
        self.value.as_ref()
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn record(&self) -> Option<&IndexMap<String, YamlValue>> {
        self.value.as_ref().and_then(YamlValue::as_map)
    }

    pub fn child(&self, key: &str) -> YamlNode {
        let value = self.record().and_then(|map| map.get(key)).cloned();
        YamlNode {
            value,
            path: format!("{}.{key}", self.path),
        }
    }

    pub fn has(&self, key: &str) -> bool {
        self.record().is_some_and(|map| map.contains_key(key))
    }

    pub fn str(&self, key: &str) -> Option<String> {
        match self.at(key) {
            Some(YamlValue::String(value)) => Some(value.clone()),
            _ => None,
        }
    }

    /// `true` only when the value is exactly boolean true.
    pub fn bool(&self, key: &str) -> bool {
        matches!(self.at(key), Some(YamlValue::Bool(true)))
    }

    pub fn finite_number(&self, key: &str) -> Option<f64> {
        match self.at(key) {
            Some(YamlValue::Number(value)) if value.is_finite() => Some(*value),
            _ => None,
        }
    }

    pub fn finite_int(&self, key: &str) -> Option<i64> {
        let value = self.finite_number(key)?;
        if value.fract() == 0.0 && value >= i64::MIN as f64 && value <= i64::MAX as f64 {
            Some(value as i64)
        } else {
            None
        }
    }

    pub fn literal(&self, key: &str) -> Option<YamlLiteral> {
        match self.at(key) {
            Some(YamlValue::Null) => Some(YamlLiteral::Null),
            Some(YamlValue::String(value)) => Some(YamlLiteral::String(value.clone())),
            Some(YamlValue::Number(value)) => Some(YamlLiteral::Number(*value)),
            Some(YamlValue::Bool(value)) => Some(YamlLiteral::Bool(*value)),
            _ => None,
        }
    }

    pub fn strings(&self, key: &str) -> Vec<String> {
        match self.at(key) {
            Some(YamlValue::Array(items)) => items
                .iter()
                .filter_map(|item| match item {
                    YamlValue::String(value) => Some(value.clone()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        }
    }

    pub fn items(&self) -> Vec<YamlNode> {
        match &self.value {
            Some(YamlValue::Array(items)) => items
                .iter()
                .enumerate()
                .map(|(index, item)| YamlNode {
                    value: Some(item.clone()),
                    path: format!("{}[{index}]", self.path),
                })
                .collect(),
            _ => Vec::new(),
        }
    }

    /// First key of each single-key map. Empty maps and non-maps are skipped.
    pub fn named_items(&self) -> Vec<Named> {
        self.items()
            .into_iter()
            .filter_map(|item| {
                let (name, body) = item.record()?.iter().next()?;
                Some(Named {
                    name: name.clone(),
                    node: YamlNode {
                        value: Some(body.clone()),
                        path: format!("{}.{}", item.path, name),
                    },
                })
            })
            .collect()
    }

    pub fn named_list(&self, key: &str) -> Vec<Named> {
        self.child(key).named_items()
    }

    fn at(&self, key: &str) -> Option<&YamlValue> {
        self.record().and_then(|map| map.get(key))
    }
}

fn convert(value: &saphyr::Yaml<'_>) -> YamlValue {
    use saphyr::{Scalar, Yaml};
    match value {
        Yaml::Value(Scalar::Null) => YamlValue::Null,
        Yaml::Value(Scalar::Boolean(flag)) => YamlValue::Bool(*flag),
        Yaml::Value(Scalar::Integer(number)) => YamlValue::Number(*number as f64),
        Yaml::Value(Scalar::FloatingPoint(number)) => YamlValue::Number(number.into_inner()),
        Yaml::Value(Scalar::String(text)) => YamlValue::String(text.to_string()),
        Yaml::Sequence(items) => YamlValue::Array(items.iter().map(convert).collect()),
        Yaml::Mapping(map) => {
            let mut out = IndexMap::new();
            for (key, value) in map {
                out.insert(key_name(key), convert(value));
            }
            YamlValue::Map(out)
        }
        Yaml::Tagged(_, node) => convert(node),
        Yaml::Representation(text, _, _) => YamlValue::String(text.to_string()),
        _ => YamlValue::Null,
    }
}

fn key_name(key: &saphyr::Yaml<'_>) -> String {
    use saphyr::{Scalar, Yaml};
    match key {
        Yaml::Value(Scalar::String(text)) => text.to_string(),
        Yaml::Value(Scalar::Integer(number)) => number.to_string(),
        Yaml::Value(Scalar::Boolean(flag)) => flag.to_string(),
        Yaml::Value(Scalar::Null) => "null".to_string(),
        Yaml::Value(Scalar::FloatingPoint(number)) => number.to_string(),
        Yaml::Sequence(items) => items.iter().map(key_name).collect::<Vec<_>>().join(","),
        Yaml::Mapping(_) => "[object Object]".to_string(),
        Yaml::Tagged(_, inner) => key_name(inner),
        Yaml::Representation(text, _, _) => text.to_string(),
        _ => format!("{key:?}"),
    }
}
