use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::compile_filter::{compile_filter, FilterCandidate};

use super::positions::{entries, parse_yaml_with_positions, position_for, ParsedYaml};
use super::schema::{SpecValidationError, SpecValidationResult, ValidateOptions};

fn err(parsed: &ParsedYaml, instance_path: &str, message: impl Into<String>) -> SpecValidationError {
    let (line, col) = position_for(parsed, instance_path);
    SpecValidationError {
        line,
        col,
        instance_path: instance_path.to_string(),
        message: message.into(),
    }
}

pub fn with_include_file_path(path: &str, options: &ValidateOptions) -> ValidateOptions {
    let mut next = options.clone();
    if next.include_file_path.is_none() {
        next.include_file_path = Some(path.to_string());
    }
    if next.include_base_path.is_none() {
        next.include_base_path = Some(
            Path::new(path)
                .parent()
                .unwrap_or(Path::new("."))
                .display()
                .to_string(),
        );
    }
    next
}

const ACCESSORS: &[&str] = &["type", "tag", "inherits"];

#[derive(Clone, Debug)]
enum Tok {
    Ident(String),
    String(String),
    Op(&'static str),
}

fn tokenize(input: &str) -> Result<Vec<Tok>, String> {
    let chars: Vec<char> = input.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch.is_whitespace() {
            i += 1;
            continue;
        }
        let rest: String = chars[i..].iter().collect();
        if rest.starts_with("||") {
            tokens.push(Tok::Op("||"));
            i += 2;
            continue;
        }
        if rest.starts_with("&&") {
            tokens.push(Tok::Op("&&"));
            i += 2;
            continue;
        }
        if rest.starts_with("==") {
            tokens.push(Tok::Op("=="));
            i += 2;
            continue;
        }
        if rest.starts_with("!=") {
            tokens.push(Tok::Op("!="));
            i += 2;
            continue;
        }
        if ch == '(' || ch == ')' {
            tokens.push(Tok::Op(if ch == '(' { "(" } else { ")" }));
            i += 1;
            continue;
        }
        if ch == '"' {
            i += 1;
            let mut value = String::new();
            while i < chars.len() && chars[i] != '"' {
                if chars[i] == '\\' && i + 1 < chars.len() {
                    value.push(chars[i + 1]);
                    i += 2;
                    continue;
                }
                value.push(chars[i]);
                i += 1;
            }
            if i >= chars.len() {
                return Err("unterminated string literal".into());
            }
            i += 1;
            tokens.push(Tok::String(value));
            continue;
        }
        if ch.is_ascii_lowercase() || ch == '_' {
            let mut value = String::new();
            while i < chars.len() && (chars[i].is_ascii_lowercase() || chars[i].is_ascii_digit() || chars[i] == '_') {
                value.push(chars[i]);
                i += 1;
            }
            tokens.push(Tok::Ident(value));
            continue;
        }
        return Err(format!("unexpected character '{ch}'"));
    }
    tokens.push(Tok::Op("eof"));
    Ok(tokens)
}

struct FilterParser<'a> {
    tokens: &'a [Tok],
    i: usize,
}

impl<'a> FilterParser<'a> {
    fn parse(&mut self) -> Result<(), String> {
        self.or()?;
        if !self.is("eof") {
            return Err(self.unexpected());
        }
        Ok(())
    }

    fn or(&mut self) -> Result<(), String> {
        self.and()?;
        while self.is("||") {
            self.i += 1;
            self.and()?;
        }
        Ok(())
    }

    fn and(&mut self) -> Result<(), String> {
        self.atom()?;
        while self.is("&&") {
            self.i += 1;
            self.atom()?;
        }
        Ok(())
    }

    fn atom(&mut self) -> Result<(), String> {
        if self.is("(") {
            self.i += 1;
            self.or()?;
            if !self.is(")") {
                return Err("expected ')'".into());
            }
            self.i += 1;
            return Ok(());
        }
        if let Some(Tok::Ident(value)) = self.peek() {
            if ACCESSORS.contains(&value.as_str()) {
                return self.compare(value.clone());
            }
        }
        Err(self.unexpected())
    }

    fn compare(&mut self, accessor: String) -> Result<(), String> {
        self.i += 1;
        if !self.is("==") && !self.is("!=") {
            return Err(format!("expected == or != after {accessor}"));
        }
        self.i += 1;
        match self.peek() {
            Some(Tok::String(_)) => {
                self.i += 1;
                Ok(())
            }
            Some(Tok::Ident(value)) => Err(format!("unquoted '{value}'; wrap names in double quotes")),
            _ => Err(format!("expected a quoted string after {accessor}")),
        }
    }

    fn peek(&self) -> Option<&Tok> {
        self.tokens.get(self.i)
    }

    fn is(&self, value: &str) -> bool {
        matches!(self.peek(), Some(Tok::Op(op)) if *op == value)
    }

    fn unexpected(&self) -> String {
        match self.peek() {
            None | Some(Tok::Op("eof")) => "unexpected end of filter".into(),
            Some(Tok::Ident(value)) => format!("unexpected identifier '{value}'"),
            Some(Tok::String(value)) => format!("unexpected string \"{value}\""),
            Some(Tok::Op(value)) => format!("unexpected '{value}'"),
        }
    }
}

pub fn parse_include_filter(expr: &str) -> Result<(), String> {
    let tokens = tokenize(expr).map_err(|message| format!("invalid include filter: {message}"))?;
    FilterParser { tokens: &tokens, i: 0 }
        .parse()
        .map_err(|message| format!("invalid include filter: {message}"))
}

pub fn check_include_filters(parsed: &ParsedYaml, _options: &ValidateOptions) -> SpecValidationResult {
    let mut errors = Vec::new();
    let Some(includes) = parsed.data.get("includes").and_then(Value::as_array) else {
        return SpecValidationResult::ok();
    };
    for (i, entry) in includes.iter().enumerate() {
        let Some(filter) = entry
            .get("types")
            .and_then(|types| types.get("filter"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        if let Err(message) = parse_include_filter(filter) {
            errors.push(err(parsed, &format!("/includes/{i}/types/filter"), message));
        }
    }
    SpecValidationResult::fail(errors)
}

pub fn match_types_filter(expr: Option<&str>, cand: &FilterCandidate) -> bool {
    let Some(expr) = expr.filter(|text| !text.is_empty()) else {
        return true;
    };
    match compile_filter(Some(expr), "include") {
        Ok(pred) => pred(cand),
        Err(_) => false,
    }
}

fn file_includes(data: &Value) -> Vec<(usize, String)> {
    let Some(includes) = data.get("includes").and_then(Value::as_array) else {
        return Vec::new();
    };
    includes
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            let file = entry.get("file").and_then(Value::as_str)?;
            if file.is_empty() {
                None
            } else {
                Some((index, file.to_string()))
            }
        })
        .collect()
}

#[inline(never)]
fn resolved_id(path: &Path) -> PathBuf {
    if let Ok(real) = fs::canonicalize(path) {
        return real;
    }
    if let Some(parent) = path.parent() {
        if let Ok(real_parent) = fs::canonicalize(parent) {
            return real_parent.join(path.file_name().unwrap_or_default());
        }
    }
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

#[inline(never)]
fn relative_path(from_dir: &Path, to: &Path) -> String {
    let from: Vec<_> = from_dir.components().collect();
    let to: Vec<_> = to.components().collect();
    let mut i = 0;
    while i < from.len() && i < to.len() && from[i] == to[i] {
        i += 1;
    }
    let mut parts = Vec::new();
    for _ in i..from.len() {
        parts.push("..".to_string());
    }
    for component in &to[i..] {
        parts.push(component.as_os_str().to_string_lossy().to_string());
    }
    if parts.is_empty() {
        ".".to_string()
    } else {
        parts.join("/")
    }
}

fn load_child(path: &Path) -> Result<Value, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!(
                "include file not found: {}",
                path.file_name().unwrap_or_default().to_string_lossy()
            ));
        }
        Err(err) => {
            return Err(format!(
                "cannot read include {}: {err}",
                path.file_name().unwrap_or_default().to_string_lossy()
            ));
        }
    };
    let parsed = parse_yaml_with_positions(&text);
    if let Some(error) = parsed.errors.first() {
        return Err(format!("include is not valid YAML: {}", error.message));
    }
    if entries(&parsed.data).is_none() || parsed.data.is_array() {
        return Err(format!(
            "include must be a mapping: {}",
            path.file_name().unwrap_or_default().to_string_lossy()
        ));
    }
    Ok(parsed.data)
}

pub fn check_include_cycles(parsed: &ParsedYaml, options: &ValidateOptions) -> SpecValidationResult {
    let root_path = if let Some(path) = &options.include_file_path {
        Some(std::path::absolute(path).unwrap_or_else(|_| PathBuf::from(path)))
    } else if let Some(base) = &options.include_base_path {
        Some(std::path::absolute(Path::new(base).join("types.yaml")).unwrap_or_else(|_| PathBuf::from(base).join("types.yaml")))
    } else {
        None
    };
    let Some(root_path) = root_path else {
        return SpecValidationResult::ok();
    };
    let root_id = resolved_id(&root_path);
    let root_dir = root_id.parent().unwrap_or(Path::new("/")).to_path_buf();
    let mut errors = Vec::new();
    let mut stack = vec![root_id.clone()];
    let mut done = HashSet::new();

    fn walk(
        path: &Path,
        root_include_index: usize,
        root_dir: &Path,
        parsed: &ParsedYaml,
        stack: &mut Vec<PathBuf>,
        done: &mut HashSet<PathBuf>,
        errors: &mut Vec<SpecValidationError>,
    ) {
        let id = resolved_id(path);
        let instance_path = format!("/includes/{root_include_index}/file");
        if stack.iter().any(|item| item == &id) {
            let mut cycle = stack.clone();
            cycle.push(id);
            let shown = cycle
                .iter()
                .map(|item| relative_path(root_dir, item))
                .collect::<Vec<_>>()
                .join(" → ");
            errors.push(err(parsed, &instance_path, format!("circular include: {shown}")));
            return;
        }
        if done.contains(&id) {
            return;
        }
        let loaded = match load_child(&id) {
            Ok(data) => data,
            Err(message) => {
                errors.push(err(parsed, &instance_path, message));
                return;
            }
        };
        stack.push(id.clone());
        for (_index, file) in file_includes(&loaded) {
            let next = path.parent().unwrap_or(Path::new(".")).join(file);
            walk(&next, root_include_index, root_dir, parsed, stack, done, errors);
        }
        stack.pop();
        done.insert(id);
    }

    for (index, file) in file_includes(&parsed.data) {
        let next = root_path.parent().unwrap_or(Path::new(".")).join(file);
        walk(&next, index, &root_dir, parsed, &mut stack, &mut done, &mut errors);
    }
    stack.pop();
    done.insert(root_id);
    let _ = done;
    SpecValidationResult::fail(errors)
}
