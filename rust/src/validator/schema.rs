use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use jsonschema::error::{TypeKind, ValidationErrorKind};
use jsonschema::Validator;
use serde_json::Value;

use super::positions::{parse_yaml_with_positions, position_for, ParsedYaml};
use super::resolve::{default_start, resolve_spec_path};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpecValidationError {
    pub line: u32,
    pub col: u32,
    pub instance_path: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpecValidationResult {
    pub valid: bool,
    pub errors: Vec<SpecValidationError>,
}

impl SpecValidationResult {
    pub fn ok() -> Self {
        Self {
            valid: true,
            errors: Vec::new(),
        }
    }

    pub fn fail(errors: Vec<SpecValidationError>) -> Self {
        if errors.is_empty() {
            Self::ok()
        } else {
            Self {
                valid: false,
                errors,
            }
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ValidateOptions {
    pub types: Option<String>,
    pub types_path: Option<String>,
    pub datasource: Option<String>,
    pub datasource_path: Option<String>,
    pub include_file_path: Option<String>,
    pub include_base_path: Option<String>,
}

#[derive(Clone, Debug)]
pub struct AjvError {
    pub keyword: String,
    pub instance_path: String,
    pub message: String,
    pub additional_property: Option<String>,
    pub missing_property: Option<String>,
    pub allowed_values: Option<Vec<String>>,
}

pub fn yaml_error_offset(pos: Option<&[usize]>) -> usize {
    pos.and_then(|items| items.first().copied()).unwrap_or(0)
}

pub fn error_from_unknown(err: &dyn std::fmt::Display) -> String {
    err.to_string()
}

pub fn format_ajv_error(error: &AjvError) -> String {
    let where_ = if error.instance_path.is_empty() {
        "(root)"
    } else {
        error.instance_path.as_str()
    };
    if error.keyword == "not" && error.instance_path.ends_with("/is_id") {
        return format!("{where_} ids and is_id are mutually exclusive");
    }
    format!("{where_} {}{}", error.message, ajv_param_suffix(error))
}

fn ajv_param_suffix(error: &AjvError) -> String {
    if let Some(value) = error.additional_property.as_deref() {
        if !value.is_empty() {
            return format!(" (property: {value})");
        }
    }
    if let Some(value) = error.missing_property.as_deref() {
        if !value.is_empty() {
            return format!(" (missing: {value})");
        }
    }
    if let Some(values) = &error.allowed_values {
        if !values.is_empty() {
            return format!(" (allowed: {})", values.join(", "));
        }
    }
    String::new()
}

pub fn ajv_from_kind(instance_path: &str, kind: &ValidationErrorKind) -> Vec<AjvError> {
    if let ValidationErrorKind::AdditionalProperties { unexpected } = kind {
        return unexpected
            .iter()
            .map(|name| AjvError {
                keyword: "additionalProperties".into(),
                instance_path: instance_path.to_string(),
                message: "must NOT have additional properties".into(),
                additional_property: Some(name.clone()),
                missing_property: None,
                allowed_values: None,
            })
            .collect();
    }
    if let ValidationErrorKind::Required { property } = kind {
        let name = property.as_str().unwrap_or("").to_string();
        return vec![AjvError {
            keyword: "required".into(),
            instance_path: instance_path.to_string(),
            message: format!("must have required property '{name}'"),
            additional_property: None,
            missing_property: Some(name),
            allowed_values: None,
        }];
    }
    if let ValidationErrorKind::Type { kind } = kind {
        let name = match kind {
            TypeKind::Single(ty) => ty.as_str().to_string(),
            TypeKind::Multiple(set) => set.iter().map(|ty| ty.as_str()).collect::<Vec<_>>().join(", "),
        };
        return vec![plain(instance_path, "type", format!("must be {name}"))];
    }
    if let ValidationErrorKind::Enum { options } = kind {
        let allowed = match options {
            Value::Array(items) => items
                .iter()
                .map(|item| match item {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                })
                .collect(),
            other => vec![other.to_string()],
        };
        return vec![AjvError {
            keyword: "enum".into(),
            instance_path: instance_path.to_string(),
            message: "must be equal to one of the allowed values".into(),
            additional_property: None,
            missing_property: None,
            allowed_values: Some(allowed),
        }];
    }
    if let ValidationErrorKind::Pattern { pattern } = kind {
        return vec![plain(
            instance_path,
            "pattern",
            format!("must match pattern \"{pattern}\""),
        )];
    }
    if kind.keyword() == "not" {
        return vec![plain(instance_path, "not", "must NOT be valid".into())];
    }
    if kind.keyword() == "const" {
        return vec![plain(instance_path, "const", "must be equal to constant".into())];
    }
    if let ValidationErrorKind::PropertyNames { error } = kind {
        let nested = error.instance_path().as_str();
        let path = if nested.is_empty() { instance_path } else { nested };
        return ajv_from_kind(path, error.kind());
    }
    if kind.keyword() == "oneOf" || kind.keyword() == "anyOf" {
        let mut out = vec![plain(
            instance_path,
            kind.keyword(),
            if kind.keyword() == "oneOf" {
                "must match exactly one schema in oneOf".into()
            } else {
                "must match a schema in anyOf".into()
            },
        )];
        collect_nested_errors(kind, &mut out);
        return out;
    }
    let keyword = kind.keyword();
    vec![plain(
        instance_path,
        keyword,
        format!("must be valid ({keyword})"),
    )]
}

fn collect_nested_errors(kind: &ValidationErrorKind, out: &mut Vec<AjvError>) {
    let contexts = match kind {
        ValidationErrorKind::OneOfNotValid { context }
        | ValidationErrorKind::OneOfMultipleValid { context }
        | ValidationErrorKind::AnyOf { context } => context,
        _ => return,
    };
    for group in contexts {
        for err in group {
            match err.kind().keyword() {
                "oneOf" | "anyOf" => collect_nested_errors(err.kind(), out),
                "propertyNames" => out.extend(ajv_from_kind(err.instance_path().as_str(), err.kind())),
                "not" | "enum" | "pattern" | "const" | "additionalProperties" | "required" | "type" => {
                    out.extend(ajv_from_kind(err.instance_path().as_str(), err.kind()))
                }
                _ => collect_nested_errors(err.kind(), out),
            }
        }
    }
}

fn plain(instance_path: &str, keyword: &str, message: String) -> AjvError {
    AjvError {
        keyword: keyword.to_string(),
        instance_path: instance_path.to_string(),
        message,
        additional_property: None,
        missing_property: None,
        allowed_values: None,
    }
}

fn spec_error(parsed: &ParsedYaml, instance_path: &str, message: String) -> SpecValidationError {
    let (line, col) = position_for(parsed, instance_path);
    SpecValidationError {
        line,
        col,
        instance_path: instance_path.to_string(),
        message,
    }
}

pub type AfterSchemaFn = Box<dyn Fn(&ParsedYaml, &ValidateOptions) -> SpecValidationResult + Send + Sync>;
pub type FileOptionsFn = Box<dyn Fn(&str, &ValidateOptions) -> ValidateOptions + Send + Sync>;

enum SpecSource {
    Ref { subdir: String, name: String },
    Path(String),
    Thunk(Box<dyn Fn() -> String + Send + Sync>),
}

pub struct SpecValidator {
    source: SpecSource,
    after: Vec<AfterSchemaFn>,
    file_options: Option<FileOptionsFn>,
    compiled: Mutex<HashMap<String, Validator>>,
    start: PathBuf,
}

impl SpecValidator {
    pub fn from_ref(subdir: &str, name: &str) -> Self {
        Self::new(
            SpecSource::Ref {
                subdir: subdir.to_string(),
                name: name.to_string(),
            },
            Vec::new(),
            None,
        )
    }

    pub fn from_path(path: impl Into<String>) -> Self {
        Self::new(SpecSource::Path(path.into()), Vec::new(), None)
    }

    pub fn from_thunk(thunk: impl Fn() -> String + Send + Sync + 'static) -> Self {
        Self::new(SpecSource::Thunk(Box::new(thunk)), Vec::new(), None)
    }

    pub fn with_after(mut self, checks: Vec<AfterSchemaFn>) -> Self {
        self.after = checks;
        self
    }

    pub fn with_file_options(mut self, options: FileOptionsFn) -> Self {
        self.file_options = Some(options);
        self
    }

    fn new(source: SpecSource, after: Vec<AfterSchemaFn>, file_options: Option<FileOptionsFn>) -> Self {
        Self {
            source,
            after,
            file_options,
            compiled: Mutex::new(HashMap::new()),
            start: default_start(),
        }
    }

    pub fn validate(&self, text: &str, options: &ValidateOptions) -> SpecValidationResult {
        let parsed = parse_yaml_with_positions(text);
        if !parsed.errors.is_empty() {
            return SpecValidationResult::fail(
                parsed
                    .errors
                    .iter()
                    .map(|err| SpecValidationError {
                        line: err.line,
                        col: err.col,
                        instance_path: String::new(),
                        message: err.message.clone(),
                    })
                    .collect(),
            );
        }
        self.check(&parsed, options)
    }

    pub fn validate_file(&self, path: &str, options: &ValidateOptions) -> Result<SpecValidationResult, String> {
        let text = fs::read_to_string(path).map_err(|err| err.to_string())?;
        let options = if let Some(file_options) = &self.file_options {
            file_options(path, options)
        } else {
            options.clone()
        };
        Ok(self.validate(&text, &options))
    }

    fn check(&self, parsed: &ParsedYaml, options: &ValidateOptions) -> SpecValidationResult {
        let path = match self.resolve_path(parsed) {
            Ok(path) => path,
            Err(result) => return result,
        };
        if let Err(message) = self.compiled_spec(&path) {
            return SpecValidationResult::fail(vec![spec_error(parsed, "", message)]);
        }
        let mut errors = Vec::new();
        {
            let guard = self.compiled.lock().expect("schema cache");
            let compiled = guard.get(&path).expect("schema just compiled");
            for error in compiled.iter_errors(&parsed.data) {
                let instance_path = error.instance_path().as_str().to_string();
                for ajv in ajv_from_kind(&instance_path, error.kind()) {
                    errors.push(spec_error(parsed, &instance_path, format_ajv_error(&ajv)));
                }
            }
        }
        let has_fields_detail = errors.iter().any(|err| {
            (err.message.contains("required property 'fields'") || err.message.contains("must include a key field") || err.message.contains("must include a value field"))
                && !err.message.contains("exactly one")
        });
        if has_fields_detail {
            errors.retain(|err| !err.message.contains("exactly one") && !err.message.contains(" oneOf"));
        }
        if !errors.is_empty() {
            return SpecValidationResult::fail(errors);
        }
        for check in &self.after {
            let result = check(parsed, options);
            if !result.valid {
                return result;
            }
        }
        SpecValidationResult::ok()
    }

    fn resolve_path(&self, parsed: &ParsedYaml) -> Result<String, SpecValidationResult> {
        match &self.source {
            SpecSource::Path(path) => Ok(path.clone()),
            SpecSource::Thunk(thunk) => Ok(thunk()),
            SpecSource::Ref { subdir, name } => resolve_spec_path(subdir, name, &self.start)
                .map(|path| path.display().to_string())
                .map_err(|message| {
                    SpecValidationResult::fail(vec![spec_error(parsed, "/version", message)])
                }),
        }
    }

    fn compiled_spec(&self, path: &str) -> Result<(), String> {
        if self.compiled.lock().expect("schema cache").contains_key(path) {
            return Ok(());
        }
        let text = fs::read_to_string(path).map_err(|err| err.to_string())?;
        let mut parsed = parse_yaml_with_positions(&text);
        if let Some(err) = parsed.errors.first() {
            return Err(err.message.clone());
        }
        if let Some(object) = parsed.data.as_object_mut() {
            object.remove("$id");
            object.remove("$schema");
        }
        let validator = jsonschema::draft202012::options()
            .build(&parsed.data)
            .map_err(|err| err.to_string())?;
        self.compiled
            .lock()
            .expect("schema cache")
            .insert(path.to_string(), validator);
        Ok(())
    }
}

pub fn read_if_present(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok()
}
