use std::fs;
use std::path::Path;

use serde_json::Value;

use super::positions::parse_yaml_with_positions;
use super::resolve::find_ancestor_path;
use super::schema::{SpecValidator, ValidateOptions};
use super::{
    DatasourceSeedsValidator, DatasourceValidator, FrontendBindingsValidator, RoutesValidator,
    ServicesValidator, TypesValidator,
};

fn specs_root() -> std::path::PathBuf {
    let start = Path::new(env!("CARGO_MANIFEST_DIR"));
    find_ancestor_path("samples/valid", start)
        .expect("samples")
        .parent()
        .and_then(|path| path.parent())
        .unwrap()
        .to_path_buf()
}

fn split_sample(text: &str) -> (Value, String) {
    let (header, body) = text.split_once("\n---\n").unwrap_or(("", text));
    let parsed = parse_yaml_with_positions(header);
    (parsed.data.get("expect").cloned().unwrap_or(Value::Null), body.to_string())
}

fn string_list(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items.iter().map(|item| item.to_string().trim_matches('"').to_string()).collect(),
        Value::String(text) => vec![text.clone()],
        Value::Null => Vec::new(),
        other => vec![other.to_string()],
    }
}

fn options_from(expect: &Value) -> ValidateOptions {
    ValidateOptions {
        types: expect.get("types").and_then(Value::as_str).map(str::to_string),
        datasource: expect.get("datasource").and_then(Value::as_str).map(str::to_string),
        ..ValidateOptions::default()
    }
}

#[test]
fn valid_samples_and_examples_pass() {
    let root = specs_root();
    let valid = root.join("samples/valid");
    let cases: &[(&str, fn(&str) -> Result<bool, String>)] = &[
        ("types.yaml", |path| Ok(TypesValidator::new().validate_file(path)?.valid)),
        ("datasource.yaml", |path| Ok(DatasourceValidator::new().validate_file(path)?.valid)),
        ("datasource_seeds.yaml", |path| Ok(DatasourceSeedsValidator::new().validate_file(path)?.valid)),
        ("routes.yaml", |path| Ok(RoutesValidator::new().validate_file(path)?.valid)),
        ("services.yaml", |path| Ok(ServicesValidator::new().validate_file(path)?.valid)),
        ("frontend_bindings.yaml", |path| Ok(FrontendBindingsValidator::new().validate_file(path)?.valid)),
        ("backend_app.yaml", |path| {
            Ok(SpecValidator::from_ref("backend", "app.spec.yaml")
                .validate_file(path, &ValidateOptions::default())?
                .valid)
        }),
    ];
    for (file, check) in cases {
        let path = valid.join(file);
        assert!(check(path.to_str().unwrap()).unwrap(), "{file}");
    }
    let semver = valid.join("types.semver.yaml");
    let spec = find_ancestor_path("backend/types.spec.yaml", Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap();
    let result = SpecValidator::from_path(spec.display().to_string())
        .validate_file(semver.to_str().unwrap(), &ValidateOptions::default())
        .unwrap();
    assert!(result.valid, "{:?}", result.errors);
}

#[test]
fn invalid_samples_fail() {
    let root = specs_root().join("samples/invalid");
    for dir in ["types", "datasource", "datasource_seeds", "routes", "services", "backend_app", "frontend_bindings"] {
        let folder = root.join(dir);
        let mut files = fs::read_dir(&folder).unwrap().map(|e| e.unwrap().path()).filter(|p| p.extension().is_some_and(|e| e == "yaml")).collect::<Vec<_>>();
        files.sort();
        assert!(!files.is_empty(), "{dir}");
        for file in files {
            let text = fs::read_to_string(&file).unwrap();
            let (_expect, yaml) = split_sample(&text);
            let result = match dir {
                "types" => TypesValidator::new().validate(&yaml),
                "datasource" => DatasourceValidator::new().validate(&yaml),
                "datasource_seeds" => DatasourceSeedsValidator::new().validate(&yaml),
                "routes" => RoutesValidator::new().validate(&yaml),
                "services" => ServicesValidator::new().validate(&yaml),
                "frontend_bindings" => FrontendBindingsValidator::new().validate(&yaml),
                "backend_app" => SpecValidator::from_ref("backend", "app.spec.yaml").validate(&yaml, &ValidateOptions::default()),
                _ => unreachable!(),
            };
            assert!(!result.valid && !result.errors.is_empty(), "{} still valid", file.display());
        }
    }
}

#[test]
fn error_examples_match_needles() {
    let dir = specs_root().join("examples/errors");
    let mut files = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).filter(|p| p.extension().is_some_and(|e| e == "yaml")).collect::<Vec<_>>();
    files.sort();
    assert!(!files.is_empty());
    for file in files {
        let name = file.file_name().unwrap().to_string_lossy().to_string();
        let text = fs::read_to_string(&file).unwrap();
        let (expect, yaml) = split_sample(&text);
        let needles = string_list(expect.get("includes").unwrap_or(&Value::Null));
        assert!(!needles.is_empty(), "{name}");
        let options = options_from(&expect);
        let prefix = name.split('.').next().unwrap_or("");
        let result = match prefix {
            "types" => TypesValidator::new().validate(&yaml),
            "datasource" => DatasourceValidator::new().validate_with(&yaml, &options),
            "datasource_seeds" => DatasourceSeedsValidator::new().validate_with(&yaml, &options),
            "routes" => RoutesValidator::new().validate(&yaml),
            "services" => ServicesValidator::new().validate(&yaml),
            "backend_app" | "backend-app" => SpecValidator::from_ref("backend", "app.spec.yaml").validate(&yaml, &ValidateOptions::default()),
            "frontend_bindings" => FrontendBindingsValidator::new().validate(&yaml),
            other => panic!("no validator for {other}"),
        };
        assert!(!result.valid, "{name}");
        let blob = result.errors.iter().map(|err| err.message.as_str()).collect::<Vec<_>>().join("\n");
        for needle in needles {
            assert!(blob.contains(&needle), "{name} missing {needle}\n{blob}");
        }
    }
}

#[test]
fn minimal_and_tasks_examples_pass() {
    let root = specs_root().join("examples");
    for app in ["minimal", "tasks"] {
        let dir = root.join(app);
        for entry in fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|ext| ext != "yaml") {
                continue;
            }
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            let path_str = path.display().to_string();
            let result = match name.as_str() {
                "types.yaml" => TypesValidator::new().validate_file(&path_str),
                "datasource.yaml" => DatasourceValidator::new().validate_file(&path_str),
                "datasource_seeds.yaml" => DatasourceSeedsValidator::new().validate_file(&path_str),
                "routes.yaml" => RoutesValidator::new().validate_file(&path_str),
                "services.yaml" => ServicesValidator::new().validate_file(&path_str),
                "frontend_bindings.yaml" => FrontendBindingsValidator::new().validate_file(&path_str),
                "backend-app.yaml" => SpecValidator::from_ref("backend", "app.spec.yaml")
                    .validate_file(&path_str, &ValidateOptions::default()),
                other => panic!("{other}"),
            }
            .unwrap();
            assert!(result.valid, "{app}/{name} {:?}", result.errors);
        }
    }
}
