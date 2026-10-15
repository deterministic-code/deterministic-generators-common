use std::fs;
use std::io::Write;
use std::path::Path;

use serde_json::json;

use crate::compile_filter::FilterCandidate;

use super::include::{check_include_filters, match_types_filter, parse_include_filter};
use super::positions::{parse_json_pointer, parse_yaml_with_positions, position_for};
use super::resolve::{
    default_start, find_ancestor_path, find_spec_path, resolve_spec_path, spec_rel_path, SPEC_FILES,
};
use super::schema::{
    error_from_unknown, format_ajv_error, read_if_present, yaml_error_offset, AjvError, SpecValidator,
    ValidateOptions,
};
use super::models::{check_route_model, check_service_model};
use super::{
    shared_types_validator, spec_validator_path, spec_validator_ref, spec_validator_thunk, RoutesApiValidator,
    RoutesValidator, ServicesValidator, TypesValidator,
};

#[test]
fn include_filter_accepts_the_documented_expressions() {
    for expr in [
        r#"type != "link""#,
        r#"type == "person" || tag == "datasource_type""#,
        r#"tag == "view_type""#,
        r#"tag != "many_to_many""#,
        r#"inherits == "set""#,
        r#"inherits != "dictionary""#,
        r#"(type == "person" && inherits == "set")"#,
        r#"tag == "datasource_type" || tag == "view_type""#,
        r#"type == "say \"hi\"""#,
    ] {
        assert!(parse_include_filter(expr).is_ok(), "{expr}");
    }
}

#[test]
fn include_filter_rejects_the_documented_expressions() {
    let cases = [
        ("type is datasource_type", "expected == or !="),
        (r#"foo == "bar""#, "unexpected identifier 'foo'"),
        ("type == person", "unquoted 'person'"),
        ("type", "expected == or !="),
        ("type ==", "expected a quoted string"),
        ("", "unexpected end of filter"),
        ("@@@", "unexpected character '@'"),
        (r#"type == "unterminated"#, "unterminated string"),
        (r#"type == "person" extra"#, "unexpected identifier 'extra'"),
        (r#"(tag == "datasource_type""#, "expected ')'"),
        (r#""person""#, "unexpected string"),
        ("&&", "unexpected '&&'"),
        ("inherits ==", "expected a quoted string"),
        (r#"type == "person" )"#, "unexpected ')'"),
        (r#"type == "person" || type"#, "expected == or !="),
        (r#"type == "person" && type"#, "expected == or !="),
        ("(type)", "expected == or !="),
    ];
    for (expr, needle) in cases {
        let err = parse_include_filter(expr).unwrap_err();
        assert!(err.contains(needle), "{expr} -> {err}");
    }
}

#[test]
fn include_filters_skip_non_mappings_and_report_paths() {
    let parsed = parse_yaml_with_positions("version: 1.0.0\n");
    assert!(check_include_filters(&parsed, &ValidateOptions::default()).valid);
    let parsed = parse_yaml_with_positions("version: 1.0.0\nincludes:\n  - []\n  - 1\n");
    assert!(check_include_filters(&parsed, &ValidateOptions::default()).valid);
    let parsed = parse_yaml_with_positions(
        "version: 1.0.0\nincludes:\n  - types:\n      filter: type == person\n",
    );
    let result = check_include_filters(&parsed, &ValidateOptions::default());
    assert!(!result.valid);
    assert_eq!(result.errors[0].instance_path, "/includes/0/types/filter");
}

#[test]
fn match_types_filter_matches_and_fails_closed() {
    let user = FilterCandidate {
        name: "user".into(),
        tags: vec!["datasource_type".into()],
        inherits: Some("set".into()),
    };
    let person = FilterCandidate {
        name: "person".into(),
        tags: vec!["view_type".into()],
        inherits: None,
    };
    assert!(match_types_filter(Some(r#"type == "user""#), &user));
    assert!(match_types_filter(Some(r#"type != "user""#), &person));
    assert!(match_types_filter(Some(r#"tag == "view_type""#), &person));
    assert!(match_types_filter(Some(r#"tag != "datasource_type""#), &person));
    assert!(match_types_filter(Some(r#"inherits == "set""#), &user));
    assert!(match_types_filter(Some(r#"inherits != "dictionary""#), &user));
    assert!(match_types_filter(None, &user));
    assert!(!match_types_filter(Some(r#"type == "user" &&"#), &user));
}

#[test]
fn facades_reject_bad_include_filters() {
    let types = TypesValidator::new().validate(
        "version: 1.0.0\nincludes:\n  - types:\n      filter: type == person\ntypes: []\n",
    );
    assert!(types.errors[0].message.contains("invalid include filter"));
    let routes = RoutesValidator::new().validate(
        "version: 1.0.0\nincludes:\n  - types:\n      filter: type inherits set\nroutes: []\n",
    );
    assert!(routes.errors[0].message.contains("invalid include filter"));
    let services = ServicesValidator::new().validate(
        "version: 1.0.0\nincludes:\n  - types:\n      filter: type is service\nservices: []\n",
    );
    assert!(services.errors[0].message.contains("invalid include filter"));
}

#[test]
fn yaml_positions_match_the_typescript_cases() {
    assert_eq!(parse_json_pointer(""), Vec::<String>::new());
    assert_eq!(parse_json_pointer("/"), vec![""]);
    assert_eq!(parse_json_pointer("/a~1b/~0c"), vec!["a/b".to_string(), "~c".to_string()]);
    let yaml = "types:\n  - user:\n      fields:\n        - id:\n            type: integer\n      target: StandardCrud\nlonely:\n";
    let parsed = parse_yaml_with_positions(yaml);
    let (line, col) = position_for(&parsed, "/types/0/user/fields/0/id/type");
    assert!(line > 0 && col > 0);
    for path in ["/types/0/user/nope", "/types/notanindex", "/types/-1", "/types/99", "/types/0/user/target/deeper", "/lonely/child"] {
        let (line, col) = position_for(&parsed, path);
        assert!(line > 0 && col > 0, "{path}");
    }
    let empty = parse_yaml_with_positions("");
    assert!(empty.root.is_none());
    assert_eq!(position_for(&empty, ""), (1, 1));
    assert_eq!(position_for(&empty, "/foo"), (1, 1));
    let complex = parse_yaml_with_positions("? { nested: key }\n: hello\nsimple: 1\n");
    let (line, col) = position_for(&complex, "/simple");
    assert!(line > 0 && col > 0);
    let _ = parse_yaml_with_positions(".inf: 1\n.nan: 2\n? [a, b]\n: 3\n!tag k: 4\n");
    let broken = parse_yaml_with_positions("foo: [unterminated");
    assert!(!broken.errors.is_empty());
}

#[test]
fn spec_paths_walk_ancestors_and_report_missing_files() {
    assert_eq!(spec_rel_path("backend", "routes.spec.yaml"), "backend/routes.spec.yaml");
    let start = default_start();
    let routes = find_spec_path("backend", "routes.spec.yaml", &start).unwrap();
    assert!(fs::read_to_string(&routes).unwrap().contains("$schema") || fs::read_to_string(&routes).unwrap().contains("version"));
    assert!(find_spec_path("frontend", "bindings.spec.yaml", &start).is_some());
    assert!(find_spec_path("backend", "does-not-exist.spec.yaml", &start).is_none());
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("backend")).unwrap();
    let spec = dir.path().join("backend").join("types.spec.yaml");
    fs::write(&spec, "x\n").unwrap();
    let found = find_ancestor_path(
        "backend/types.spec.yaml",
        &dir.path().join("nested").join("deeper"),
    )
    .unwrap();
    assert_eq!(found, spec);
    assert!(find_spec_path("backend", "routes.spec.yaml", std::env::temp_dir().as_path()).is_none());
    assert!(find_ancestor_path("no-such-rel-path-xyz", std::env::temp_dir().as_path()).is_none());
    assert!(find_ancestor_path("nope", std::path::Path::new("")).is_none());
    assert!(resolve_spec_path("backend", "services.spec.yaml", &start).unwrap().ends_with("services.spec.yaml"));
    let missing = resolve_spec_path("backend", "nope.spec.yaml", &start).unwrap_err();
    assert!(missing.contains("spec file not found: backend/nope.spec.yaml") || missing.contains("spec file not found: backend\\nope.spec.yaml"));
    assert!(resolve_spec_path("backend", "routes.spec.yaml", std::env::temp_dir().as_path()).is_err());
    for (subdir, name) in SPEC_FILES {
        assert!(resolve_spec_path(subdir, name, &start).unwrap().ends_with(name), "{subdir}/{name}");
    }
    let _ = json!({"ok": true});
}

#[test]
fn spec_validator_constructors_and_ajv_helpers() {
    assert_eq!(yaml_error_offset(Some(&[12, 15])), 12);
    assert_eq!(yaml_error_offset(None), 0);
    assert_eq!(error_from_unknown(&"nope"), "nope");
    let error = AjvError {
        keyword: "type".into(),
        instance_path: "/x".into(),
        message: "must be string".into(),
        additional_property: None,
        missing_property: None,
        allowed_values: None,
    };
    assert_eq!(format_ajv_error(&error), "/x must be string");
    let start = default_start();
    let path = resolve_spec_path("backend", "types.spec.yaml", &start).unwrap();
    let valid = "version: 1.0.0\ntypes:\n  - user:\n      fields:\n        - email:\n            type: string\n";
    let validator = SpecValidator::from_path(path.display().to_string());
    assert!(validator.validate(valid, &ValidateOptions::default()).valid);
    assert!(validator.validate(valid, &ValidateOptions::default()).valid);
    let path_text = path.display().to_string();
    let thunk = SpecValidator::from_thunk(move || path_text.clone());
    assert!(thunk.validate(valid, &ValidateOptions::default()).valid);
    let by_ref = SpecValidator::from_ref("backend", "types.spec.yaml");
    assert!(by_ref.validate(valid, &ValidateOptions::default()).valid);
    let missing = SpecValidator::from_ref("backend", "does-not-exist.spec.yaml");
    let result = missing.validate("version: 1.0.0\ntypes: []\n", &ValidateOptions::default());
    assert!(result.errors[0].message.contains("spec file not found"));
    let mut bad = tempfile::NamedTempFile::new().unwrap();
    writeln!(bad, "not: [a schema").unwrap();
    let broken = SpecValidator::from_path(bad.path().display().to_string());
    let result = broken.validate(valid, &ValidateOptions::default());
    assert!(!result.valid);
    assert!(read_if_present(path.as_path()).is_some());
    assert!(read_if_present(Path::new("/no/such/spec.yaml")).is_none());
    assert!(validator.validate_file("/no/such/document.yaml", &ValidateOptions::default()).is_err());
    let not_schema = tempfile::NamedTempFile::new().unwrap();
    fs::write(not_schema.path(), "type: notatype\n").unwrap();
    let broken_schema = SpecValidator::from_path(not_schema.path().display().to_string());
    assert!(!broken_schema.validate(valid, &ValidateOptions::default()).valid);
    let _ = TypesValidator::default().validate("version: 1.0.0\ntypes: []\n");
    let _ = RoutesApiValidator::new().validate_file("/no/such/routes-api.yaml");
    let _ = spec_validator_ref("backend", "types.spec.yaml").validate(valid, &ValidateOptions::default());
    let _ = spec_validator_path(path.display().to_string()).validate(valid, &ValidateOptions::default());
    let again = path.display().to_string();
    let _ = spec_validator_thunk(move || again.clone()).validate(valid, &ValidateOptions::default());
    assert!(shared_types_validator().validate(valid).valid);
    let services = parse_yaml_with_positions("services: 1\n");
    assert!(check_service_model(&services, &ValidateOptions::default()).valid);
    let services = parse_yaml_with_positions("services:\n  - name: \"\"\n  - {}\n");
    assert!(check_service_model(&services, &ValidateOptions::default()).valid);
    let routes = parse_yaml_with_positions("routes: 1\n");
    assert!(check_route_model(&routes, &ValidateOptions::default()).valid);
    let routes = parse_yaml_with_positions("routes:\n  - 1\n  - \"\"\n");
    assert!(check_route_model(&routes, &ValidateOptions::default()).valid);
}
