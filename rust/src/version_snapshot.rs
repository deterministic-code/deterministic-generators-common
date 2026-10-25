use std::fs;
use std::path::Path;

use indexmap::{IndexMap, IndexSet};
use regex::Regex;

use crate::error::Error;
use crate::yaml_node::{YamlNode, YamlValue};

pub struct VersionSnapshot {
    pub documents: IndexMap<String, YamlValue>,
}

impl VersionSnapshot {
    pub fn combine(diffs_in_order: impl IntoIterator<Item = Option<YamlValue>>) -> Result<Self, Error> {
        diffs_in_order
            .into_iter()
            .try_fold(IndexMap::new(), |mut docs, diff| {
                let Some(diff) = diff else { return Ok(docs) };
                let YamlValue::Map(map) = diff else {
                    return Err(Error::new("expected a mapping"));
                };
                let snapshot = Self {
                    documents: IndexMap::new(),
                };
                for (path, envelope) in map {
                    match snapshot.apply_file(docs.get(&path), &envelope) {
                        Some(next) if !snapshot.is_null(&next) => {
                            docs.insert(path, next);
                        }
                        _ => {
                            docs.shift_remove(&path);
                        }
                    }
                }
                Ok(docs)
            })
            .map(|documents| Self { documents })
    }

    pub fn read(deterministic_root: impl AsRef<Path>) -> Result<Self, Error> {
        let root = deterministic_root.as_ref();
        let version_dir = Regex::new(r"^version-\d{8}T\d{6}Z-\d{3}$").expect("version dir");
        let snapshot = Self {
            documents: IndexMap::new(),
        };
        let mut names = fs::read_dir(root)
            .map_err(|err| Error::new(err.to_string()))?
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| version_dir.is_match(name))
            .collect::<Vec<_>>();
        names.sort();
        let diffs = names
            .into_iter()
            .map(|name| snapshot.diff_of(root, &name))
            .collect::<Result<Vec<_>, _>>()?;
        Self::combine(diffs)
    }

    pub fn yaml(&self, path: &str) -> Result<String, Error> {
        self.documents
            .get(path)
            .map(|value| self.emit(value))
            .ok_or_else(|| Error::new(format!("missing {path}")))
    }

    fn diff_of(&self, root: &Path, name: &str) -> Result<Option<YamlValue>, Error> {
        let text = match fs::read_to_string(root.join(name).join("diff.yaml")) {
            Ok(text) => text,
            Err(_) => return Ok(None),
        };
        if text.is_empty() {
            return Ok(None);
        }
        let root_value = YamlNode::from_yaml(&text)
            .map_err(|err| Error::new(format!("{name}/diff.yaml: {err}")))?
            .value()
            .cloned();
        match root_value {
            Some(YamlValue::Map(_)) => Ok(root_value),
            _ => Err(Error::new(format!("{name}/diff.yaml: expected a mapping"))),
        }
    }

    fn apply_file(&self, before: Option<&YamlValue>, envelope: &YamlValue) -> Option<YamlValue> {
        if self.is_null(envelope) {
            return before.cloned();
        }
        if let YamlValue::Map(map) = envelope {
            if self.is_true(map, "removed") && map.len() == 1 {
                return None;
            }
            if self.is_true(map, "added") {
                return map.get("content").cloned();
            }
        }
        self.apply(before, envelope)
    }

    fn apply(&self, before: Option<&YamlValue>, next: &YamlValue) -> Option<YamlValue> {
        if self.is_null(next) {
            return before.cloned();
        }
        match (before, next) {
            (Some(YamlValue::Array(seq)), YamlValue::Map(split))
                if self.is_keyed(seq) && self.is_split(split) =>
            {
                Some(YamlValue::Array(self.apply_keyed(seq, split)))
            }
            (Some(YamlValue::Map(before_map)), YamlValue::Map(next_map)) => {
                Some(YamlValue::Map(self.apply_object(before_map, next_map)))
            }
            _ => Some(next.clone()),
        }
    }

    fn apply_keyed(&self, before_val: &[YamlValue], split: &IndexMap<String, YamlValue>) -> Vec<YamlValue> {
        let removed: IndexSet<String> = self.strings(split, "removed").into_iter().collect();
        let changed: IndexMap<&str, &YamlValue> = self
            .seq(split.get("changed"))
            .iter()
            .filter_map(|entry| self.first_pair(entry))
            .collect();
        self.seq(split.get("added"))
            .iter()
            .cloned()
            .chain(before_val.iter().filter_map(|entry| {
                let (name, value) = self.first_pair(entry)?;
                if removed.contains(name) {
                    return None;
                }
                Some(match changed.get(name) {
                    Some(nested) => self.single(name, self.apply(Some(value), nested).unwrap()),
                    None => entry.clone(),
                })
            }))
            .collect()
    }

    fn apply_object(
        &self,
        before_val: &IndexMap<String, YamlValue>,
        next: &IndexMap<String, YamlValue>,
    ) -> IndexMap<String, YamlValue> {
        let removed: IndexSet<String> = self.strings(next, "removed").into_iter().collect();
        before_val
            .iter()
            .filter(|(key, _)| !removed.contains(*key))
            .map(|(key, value)| {
                let next_value = if next.contains_key(key) {
                    self.apply(Some(value), &next[key]).unwrap()
                } else {
                    value.clone()
                };
                (key.clone(), next_value)
            })
            .chain(
                next.iter()
                    .filter(|(key, value)| {
                        !(*key == "removed" && matches!(value, YamlValue::Array(_)))
                            && !before_val.contains_key(*key)
                    })
                    .map(|(key, value)| (key.clone(), value.clone())),
            )
            .collect()
    }

    fn is_split(&self, map: &IndexMap<String, YamlValue>) -> bool {
        map.keys().all(|key| matches!(key.as_str(), "added" | "changed" | "removed"))
    }

    fn is_keyed(&self, seq: &[YamlValue]) -> bool {
        !seq.is_empty() && seq.iter().all(|item| matches!(item, YamlValue::Map(map) if map.len() == 1))
    }

    fn seq<'a>(&self, value: Option<&'a YamlValue>) -> &'a [YamlValue] {
        match value {
            Some(YamlValue::Array(items)) => items,
            _ => &[],
        }
    }

    fn strings(&self, map: &IndexMap<String, YamlValue>, key: &str) -> Vec<String> {
        self.seq(map.get(key))
            .iter()
            .map(|item| match item {
                YamlValue::String(text) => text.clone(),
                YamlValue::Bool(flag) => flag.to_string(),
                YamlValue::Number(number) => self.number_text(*number),
                _ => String::new(),
            })
            .collect()
    }

    fn first_pair<'a>(&self, entry: &'a YamlValue) -> Option<(&'a str, &'a YamlValue)> {
        match entry {
            YamlValue::Map(map) => map.iter().next().map(|(key, value)| (key.as_str(), value)),
            _ => None,
        }
    }

    fn single(&self, key: &str, value: YamlValue) -> YamlValue {
        YamlValue::Map(IndexMap::from([(key.to_string(), value)]))
    }

    fn is_true(&self, map: &IndexMap<String, YamlValue>, key: &str) -> bool {
        match map.get(key) {
            Some(YamlValue::Bool(true)) => true,
            Some(YamlValue::String(text)) => text == "true" || text == "True",
            _ => false,
        }
    }

    fn is_null(&self, value: &YamlValue) -> bool {
        matches!(value, YamlValue::Null)
    }

    fn emit(&self, value: &YamlValue) -> String {
        let mut out = String::new();
        self.write_value(&mut out, value, 0);
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out
    }

    fn write_value(&self, out: &mut String, value: &YamlValue, indent: usize) {
        match value {
            YamlValue::Null => out.push('~'),
            YamlValue::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
            YamlValue::Number(number) => out.push_str(&self.number_text(*number)),
            YamlValue::String(text) => out.push_str(text),
            YamlValue::Array(items) if items.is_empty() => out.push_str("[]"),
            YamlValue::Map(map) if map.is_empty() => out.push_str("{}"),
            YamlValue::Array(items) => {
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push('\n');
                        out.push_str(&" ".repeat(indent));
                    }
                    out.push_str("- ");
                    self.write_value(out, item, indent + 2);
                }
            }
            YamlValue::Map(map) => {
                for (index, (key, item)) in map.iter().enumerate() {
                    if index > 0 {
                        out.push('\n');
                        out.push_str(&" ".repeat(indent));
                    }
                    out.push_str(key);
                    out.push(':');
                    if self.is_complex(item) {
                        out.push('\n');
                        out.push_str(&" ".repeat(indent + 2));
                        self.write_value(out, item, indent + 2);
                    } else {
                        out.push(' ');
                        self.write_value(out, item, indent);
                    }
                }
            }
        }
    }

    fn is_complex(&self, value: &YamlValue) -> bool {
        matches!(value, YamlValue::Array(items) if !items.is_empty())
            || matches!(value, YamlValue::Map(map) if !map.is_empty())
    }

    fn number_text(&self, number: f64) -> String {
        if number.is_finite() && number.fract() == 0.0 {
            format!("{}", number as i64)
        } else {
            number.to_string()
        }
    }
}
