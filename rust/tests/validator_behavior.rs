use std::fs;
use std::path::{Path, PathBuf};

use deterministic_generators_common::{
    format_ajv_error, AjvError, DatasourceSeedsValidator, DatasourceValidator, FrontendBindingsValidator,
    RoutesApiValidator, RoutesValidator, ServicesValidator, SpecValidationResult, SpecValidator,
    TypesValidator, ValidateOptions,
};

fn specs_root() -> PathBuf {
    let mut current = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    loop {
        let direct = current.join("samples/valid");
        if direct.is_dir() {
            return current;
        }
        let sibling = current.join("deterministic-specifications/samples/valid");
        if sibling.is_dir() {
            return current.join("deterministic-specifications");
        }
        let parent = current.parent().map(Path::to_path_buf);
        let Some(parent) = parent else {
            panic!("samples/valid not found");
        };
        if parent == current {
            panic!("samples/valid not found");
        }
        current = parent;
    }
}

fn ajv(keyword: &str, path: &str, message: &str) -> AjvError {
    AjvError {
        keyword: keyword.into(),
        instance_path: path.into(),
        message: message.into(),
        additional_property: None,
        missing_property: None,
        allowed_values: None,
    }
}

#[test]
fn format_ajv_error_matches_typescript() {
    assert_eq!(format_ajv_error(&ajv("type", "", "must be string")), "(root) must be string");
    let mut extra = ajv("additionalProperties", "/x", "must NOT have additional properties");
    extra.additional_property = Some("bogus".into());
    assert_eq!(
        format_ajv_error(&extra),
        "/x must NOT have additional properties (property: bogus)"
    );
    let mut missing = ajv("required", "/x", "must have required property 'fields'");
    missing.missing_property = Some("fields".into());
    assert_eq!(
        format_ajv_error(&missing),
        "/x must have required property 'fields' (missing: fields)"
    );
    let mut allowed = ajv("enum", "/x", "must be equal to one of the allowed values");
    allowed.allowed_values = Some(vec!["a".into(), "b".into()]);
    assert_eq!(
        format_ajv_error(&allowed),
        "/x must be equal to one of the allowed values (allowed: a, b)"
    );
    assert_eq!(format_ajv_error(&ajv("type", "/x", "must be string")), "/x must be string");
    let mut empty_prop = ajv("additionalProperties", "/x", "must NOT have additional properties");
    empty_prop.additional_property = Some(String::new());
    assert_eq!(format_ajv_error(&empty_prop), "/x must NOT have additional properties");
    assert_eq!(
        format_ajv_error(&ajv(
            "not",
            "/types/0/person/fields/0/id/is_id",
            "must NOT be valid",
        )),
        "/types/0/person/fields/0/id/is_id ids and is_id are mutually exclusive"
    );
}

const VALID: &str = "version: 1.0.0
types:
  - user:
      fields:
        - email:
            type: string
";

fn assert_ok(result: &SpecValidationResult, label: &str) {
    assert!(
        result.valid && result.errors.is_empty(),
        "{label}: {:?}",
        result.errors.iter().map(|err| &err.message).collect::<Vec<_>>()
    );
}

#[test]
fn facades_accept_minimal_documents_and_reject_schema_errors() {
    let types = TypesValidator::new();
    assert_ok(&types.validate(VALID), "types");
    let missing = types.validate("types: []\n");
    assert!(!missing.valid);
    assert!(missing.errors[0].message.contains("version") || missing.errors[0].message.contains("required"));
    let list = types.validate("- just a list\n");
    assert!(!list.valid);
    assert!(list.errors[0].message.contains("must be"));
    let version = types.validate("version: latest\ntypes: []\n");
    assert!(!version.valid);
    assert!(
        version.errors[0].message.to_lowercase().contains("pattern")
            || version.errors[0].message.to_lowercase().contains("match")
    );
    let syntax = types.validate("foo: [unterminated\n");
    assert!(!syntax.valid);
    assert_eq!(syntax.errors[0].instance_path, "");
    assert!(syntax.errors[0].line > 0);

    let tags2 = types.validate(
        "version: 1.0.0\ntypes:\n  - base:\n      tags: [view_type]\n      tags2: [x]\n      fields:\n        - name:\n            type: string\n",
    );
    assert!(!tags2.valid, "{:?}", tags2.errors);
    let messages: Vec<_> = tags2.errors.iter().map(|err| err.message.as_str()).collect();
    assert_eq!(
        messages,
        vec!["/types/0/base must NOT have additional properties (property: tags2)"]
    );

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ok.yaml");
    fs::write(&path, VALID).unwrap();
    assert!(types.validate_file(path.to_str().unwrap()).unwrap().valid);

    assert!(DatasourceSeedsValidator::new().validate("version: 1.0.0\nseeds: []\n").valid);
    assert!(DatasourceValidator::new().validate("version: 1.0.0\ntypes: []\n").valid);
    assert!(ServicesValidator::new().validate("version: 1.0.0\nservices: []\n").valid);
    assert!(RoutesValidator::new().validate("version: 1.0.0\nroutes: []\n").valid);
    assert!(RoutesApiValidator::new().validate("version: 1.0.0\nroutes: []\ncomponents: {}\n").valid);
    assert!(FrontendBindingsValidator::new().validate("version: 1.0.0\ndatasources: []\n").valid);
}

#[test]
fn spec_validator_path_thunk_and_missing_ref() {
    let root = specs_root();
    let spec = root.join("backend/types.spec.yaml");
    let spec_path = spec.display().to_string();
    let by_path = SpecValidator::from_path(spec_path.clone());
    assert_ok(&by_path.validate(VALID, &ValidateOptions::default()), "path");
    assert_ok(&by_path.validate(VALID, &ValidateOptions::default()), "path cached");
    let owned = spec_path.clone();
    let by_thunk = SpecValidator::from_thunk(move || owned.clone());
    assert_ok(&by_thunk.validate(VALID, &ValidateOptions::default()), "thunk");
    assert_ok(
        &SpecValidator::from_ref("backend", "types.spec.yaml").validate(VALID, &ValidateOptions::default()),
        "ref",
    );
    let missing = SpecValidator::from_ref("backend", "does-not-exist.spec.yaml")
        .validate("version: 1.0.0\ntypes: []\n", &ValidateOptions::default());
    assert!(!missing.valid);
    assert!(missing.errors[0].message.contains("spec file not found"));
    let semver = root.join("samples/valid/types.semver.yaml");
    assert_ok(
        &by_path.validate_file(semver.to_str().unwrap(), &ValidateOptions::default()).unwrap(),
        "semver",
    );
}

fn split_invalid(text: &str) -> (String, String) {
    let mut meta = String::new();
    let mut body = String::new();
    let mut seen = false;
    for line in text.split_inclusive('\n') {
        if !seen && line.trim() == "---" {
            seen = true;
            continue;
        }
        if seen {
            body.push_str(line);
        } else {
            meta.push_str(line);
        }
    }
    (meta, body)
}

fn expect_includes(meta: &str) -> Vec<String> {
    let mut includes = Vec::new();
    let mut capture = false;
    for line in meta.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("includes:") {
            let rest = trimmed.trim_start_matches("includes:").trim();
            if rest.starts_with('"') || rest.starts_with('\'') {
                includes.push(rest.trim_matches(|ch| ch == '"' || ch == '\'').to_string());
            } else if rest == "|" || rest == ">" || rest.is_empty() {
                capture = true;
            }
            continue;
        }
        if capture {
            if trimmed.is_empty() || line.starts_with("  ") || line.starts_with('\t') {
                if trimmed.starts_with("- ") {
                    includes.push(trimmed.trim_start_matches("- ").trim_matches('"').to_string());
                } else if !trimmed.is_empty() && !trimmed.ends_with(':') {
                    includes.push(trimmed.trim_matches('"').to_string());
                }
                continue;
            }
            capture = false;
        }
        if trimmed.starts_with("- ") && meta.contains("includes:") {
            // handled above
        }
    }
    includes
}

fn expect_block(meta: &str, key: &str) -> Option<String> {
    let marker = format!("{key}:");
    let mut lines = meta.lines().peekable();
    while let Some(line) = lines.next() {
        if line.trim() == marker || line.trim().starts_with(&format!("{key}: |")) || line.trim() == format!("{key}: |") {
            let mut out = String::new();
            while let Some(next) = lines.peek() {
                if next.starts_with("  ") || next.starts_with('\t') || next.trim().is_empty() {
                    let next = lines.next().unwrap();
                    if next.trim().is_empty() && lines.peek().is_some_and(|line| !line.starts_with(' ')) {
                        break;
                    }
                    if let Some(stripped) = next.strip_prefix("    ") {
                        out.push_str(stripped);
                    } else if let Some(stripped) = next.strip_prefix("  ") {
                        out.push_str(stripped);
                    } else {
                        out.push_str(next.trim());
                    }
                    out.push('\n');
                } else {
                    break;
                }
            }
            return Some(out);
        }
    }
    None
}

#[test]
fn valid_samples_and_examples_pass_and_invalid_samples_fail() {
    let root = specs_root();
    let valid = root.join("samples/valid");
    for file in ["types.yaml", "datasource.yaml", "datasource_seeds.yaml", "routes.yaml", "services.yaml", "backend_app.yaml", "frontend_bindings.yaml"] {
        let path = valid.join(file);
        let result = validate_file(file, path.to_str().unwrap());
        assert_ok(&result, file);
    }
    for (dir, file) in [
        ("types", "types.yaml"),
        ("datasource", "datasource.yaml"),
        ("datasource_seeds", "datasource_seeds.yaml"),
        ("routes", "routes.yaml"),
        ("services", "services.yaml"),
        ("backend_app", "backend_app.yaml"),
        ("frontend_bindings", "frontend_bindings.yaml"),
    ] {
        let folder = root.join("samples/invalid").join(dir);
        let mut files: Vec<_> = fs::read_dir(&folder).unwrap().map(|entry| entry.unwrap().path()).collect();
        files.retain(|path| path.extension().is_some_and(|ext| ext == "yaml"));
        assert!(!files.is_empty(), "{dir}");
        for path in files {
            let text = fs::read_to_string(&path).unwrap();
            let (_meta, yaml) = split_invalid(&text);
            let result = validate_sample(file, &yaml, &ValidateOptions::default());
            assert!(
                !result.valid && !result.errors.is_empty(),
                "{} still valid",
                path.display()
            );
        }
    }
    for app in ["minimal", "tasks"] {
        let dir = root.join("examples").join(app);
        for entry in fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|ext| ext == "yaml") {
                let name = path.file_name().unwrap().to_string_lossy().to_string();
                let result = validate_file(&name, path.to_str().unwrap());
                assert_ok(&result, &format!("{app}/{name}"));
            }
        }
    }
    let errors = root.join("examples/errors");
    for entry in fs::read_dir(&errors).unwrap() {
        let path = entry.unwrap().path();
        if !path.extension().is_some_and(|ext| ext == "yaml") {
            continue;
        }
        let text = fs::read_to_string(&path).unwrap();
        let (meta, yaml) = split_invalid(&text);
        let includes = expect_includes(&meta);
        assert!(!includes.is_empty(), "{}", path.display());
        let mut options = ValidateOptions::default();
        options.types = expect_block(&meta, "types");
        options.datasource = expect_block(&meta, "datasource");
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let result = validate_sample(&name, &yaml, &options);
        assert!(!result.valid, "{}", path.display());
        let blob = result.errors.iter().map(|err| err.message.as_str()).collect::<Vec<_>>().join("\n");
        for needle in &includes {
            assert!(blob.contains(needle), "{} missing {needle}\n{blob}", path.display());
        }
    }
}

fn validate_sample(file: &str, text: &str, options: &ValidateOptions) -> SpecValidationResult {
    let stem = file.trim_end_matches(".yaml");
    let prefix = stem.split('.').next().unwrap_or(stem);
    match prefix {
        "types" => TypesValidator::new().validate(text),
        "datasource" => DatasourceValidator::new().validate_with(text, options),
        "datasource_seeds" => DatasourceSeedsValidator::new().validate_with(text, options),
        "routes" => RoutesValidator::new().validate(text),
        "services" => ServicesValidator::new().validate(text),
        "frontend_bindings" => FrontendBindingsValidator::new().validate(text),
        "backend_app" | "backend-app" => {
            SpecValidator::from_ref("backend", "app.spec.yaml").validate(text, options)
        }
        other => panic!("no validator for {other}"),
    }
}

fn validate_file(file: &str, path: &str) -> SpecValidationResult {
    match file.trim_end_matches(".yaml").split('.').next().unwrap_or(file) {
        "types" => TypesValidator::new().validate_file(path).unwrap(),
        "datasource" => DatasourceValidator::new().validate_file(path).unwrap(),
        "datasource_seeds" => DatasourceSeedsValidator::new().validate_file(path).unwrap(),
        "routes" => RoutesValidator::new().validate_file(path).unwrap(),
        "services" => ServicesValidator::new().validate_file(path).unwrap(),
        "frontend_bindings" => FrontendBindingsValidator::new().validate_file(path).unwrap(),
        "backend_app" | "backend-app" => {
            SpecValidator::from_ref("backend", "app.spec.yaml")
                .validate_file(path, &ValidateOptions::default())
                .unwrap()
        }
        other => panic!("no validator for {other}"),
    }
}
