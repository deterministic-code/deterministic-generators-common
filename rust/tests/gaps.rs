use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::Path;

use deterministic_generators_common::*;

fn parse(files: &[(&str, &str)]) -> Deterministic {
    let map = files
        .iter()
        .map(|(name, text)| ((*name).to_string(), (*text).to_string()))
        .collect();
    DeterministicParser::new(memory_reader(map))
        .parse(&HashMap::new())
        .expect("parse")
}

#[test]
fn settings_match_typescript_defaults_and_errors() {
    let mut raw = HashMap::new();
    let settings = from_settings(&raw).unwrap();
    assert_eq!(settings.application_name, "generated-frontend");
    assert_eq!(settings.frontend_framework, "vite");
    assert!(settings.create_index);
    raw.insert("frontend_generate_framework".into(), "remix".into());
    let err = from_settings(&raw).unwrap_err().to_string();
    assert!(err.contains("must be \"vite\", \"next\", \"svelte\", \"angular\", got \"remix\""));
    raw.insert("frontend_generate_framework".into(), "".into());
    raw.insert("application_name".into(), "demo".into());
    raw.insert("comments".into(), "none".into());
    raw.insert("codegen.create_index".into(), "false".into());
    raw.insert("codegen.schema_version".into(), "".into());
    raw.insert("application_tier".into(), "full-stack".into());
    raw.insert("languages.typescript.library_reference_mode".into(), "project".into());
    let settings = from_settings(&raw).unwrap();
    assert_eq!(settings.frontend_framework, "vite");
    assert_eq!(settings.schema_version, "");
    assert!(!settings.simple_doc);
    assert!(!settings.create_index);
    assert!(settings.full_stack);
    assert_eq!(settings.library_reference_mode.as_deref(), Some("project"));
}

#[test]
fn readers_report_missing_files() {
    let err = memory_reader(HashMap::new()).read("types.yaml").unwrap_err().to_string();
    assert_eq!(err, "deterministic reader: missing types.yaml");
    let dir = tempfile::tempdir().unwrap();
    let reader = file_reader(dir.path());
    let err = reader.read("types.yaml").unwrap_err().to_string();
    assert!(err.contains("deterministic reader: missing types.yaml in "));
    assert!(!reader.exists("types.yaml"));
    let path = dir.path().join("types.yaml");
    fs::write(&path, "version: 1\n").unwrap();
    assert!(reader.exists("types.yaml"));
    assert!(reader.read("types.yaml").unwrap().contains("version"));
    let relative = file_reader(Path::new("./missing-relative-dir"));
    assert!(relative.read("types.yaml").is_err());
    let nested = file_reader(dir.path().join("child").join(".."));
    assert!(!nested.exists("types.yaml") || nested.read("types.yaml").is_ok());
}

#[test]
fn yaml_cursor_and_filter_errors() {
    let node = YamlNode::from_yaml("a: hello\nb: 3\nc: true\nd: .inf\ntags:\n  - alpha\n  - 1\n").unwrap();
    assert_eq!(node.str("a").as_deref(), Some("hello"));
    assert_eq!(node.finite_int("b"), Some(3));
    assert!(node.bool("c"));
    assert_eq!(node.finite_number("d"), None);
    assert!(matches!(node.literal("d"), Some(YamlLiteral::Number(n)) if n.is_infinite()));
    assert_eq!(node.strings("tags"), vec!["alpha"]);
    assert!(node.child("missing").value().is_none());
    let err = match compile_filter(Some("bogus == 1"), "types.filter") {
        Err(err) => err.to_string(),
        Ok(_) => panic!("expected filter error"),
    };
    assert!(err.contains("unknown identifier"));
    let pred = compile_types_filter(Some("1 == 1")).unwrap();
    assert!(pred(&FilterCandidate { name: "user".into(), tags: vec![], inherits: None }));
    let pred = compile_filter(Some(r#"type == "user" && tag != "view_type" || inherits == "set""#), "types.filter").unwrap();
    assert!(pred(&FilterCandidate { name: "user".into(), tags: vec!["datasource_type".into()], inherits: None }));
    assert!(compile_filter(None, "types.filter").unwrap()(&FilterCandidate { name: "x".into(), tags: vec![], inherits: None }));
    assert!(compile_filter(Some(""), "types.filter").unwrap()(&FilterCandidate { name: "x".into(), tags: vec![], inherits: None }));
    let numbers = compile_filter(Some("1.25 == 1.25 && true == 1 && 1 == \"1\" && null == undefined && !(false) || false"), "types.filter").unwrap();
    assert!(numbers(&FilterCandidate { name: "x".into(), tags: vec![], inherits: None }));
    let includes = compile_filter(
        Some(r#"__tags.includes(1) || __name.includes("use") || __inherits.includes("se") || tag == "view_type""#),
        "types.filter",
    )
    .unwrap();
    assert!(includes(&FilterCandidate { name: "user".into(), tags: vec!["view_type".into()], inherits: Some("set".into()) }));
    assert!(matches!(compile_filter(Some("__tags.foo(1)"), "types.filter"), Err(_)));
    assert!(matches!(compile_filter(Some("__tags.includes"), "types.filter"), Err(_)));
    assert!(matches!(compile_filter(Some("__tags.includes(1"), "types.filter"), Err(_)));
    assert!(matches!(compile_filter(Some("\"unterminated"), "types.filter"), Err(_)));
    assert!(matches!(compile_filter(Some("@"), "types.filter"), Err(_)));
    assert!(matches!(compile_filter(Some("(1"), "types.filter"), Err(_)));
}

#[test]
fn datasource_trees_emit_all_formats() {
    let doc = parse(&[(
        TYPES_YAML,
        r#"
version: 1.0.0
types:
  - user:
      fields:
        - id:
            type: integer
  - contact:
      fields:
        - owner:
            type: integer
            references: user.id
        - other:
            type: integer
            references: [user.id, user.id]
        - manager:
            type: integer
            references: user.id
        - ghost:
            type: integer
            references: missing.id
  - loop_a:
      fields:
        - b:
            type: integer
            references: loop_b.id
  - loop_b:
      fields:
        - a:
            type: integer
            references: loop_a.id
"#,
    )]);
    let first = datasource_type_tree_first(&doc.expanded_types);
    let all = datasource_type_tree_all(&doc.expanded_types);
    let graph = datasource_type_graph(&doc.expanded_types);
    let hierarchies = datasource_type_hierarchies(&doc.expanded_types);
    assert!(datasource_type_tree_yaml(&first).contains("root"));
    assert!(datasource_type_tree_json(&all).contains("root"));
    assert!(datasource_type_tree_xml(&hierarchies.first_parent_tree).contains("<root"));
    assert!(datasource_type_graph_yaml(&graph).contains("edges:"));
    assert!(datasource_type_graph_json(&graph).contains("nodes"));
    assert!(datasource_type_graph_xml(&graph).contains("<graph>"));
    assert!(!datasource_type_order(&doc.expanded_types).is_empty());
    assert!(datasource_type_ancestry(&doc.expanded_types, "contact").iter().any(|name| name == "user"));
    assert!(datasource_type_ancestry(&doc.expanded_types, "missing").is_empty());
    let compare = compare_by_datasource_type_order(&doc.expanded_types);
    let _ = compare("user", "contact");
    let compare = compare_by_datasource_type_order_with(&doc.expanded_types, |name| {
        if name == "view" { Some("not-a-type".into()) } else { None }
    });
    assert!(compare("aaa", "zzz") < 0);
    let _ = compare("view", "user");
    let same = compare_by_datasource_type_order(&doc.expanded_types);
    assert_eq!(same("user", "user"), 0);
    let tree = datasource_type_tree(&doc.expanded_types, MultiParent::All);
    assert!(!tree.is_empty());
}

#[test]
fn ajv_messages_match_the_typescript_table() {
    let cases = [
        (
            AjvError { keyword: "type".into(), instance_path: "".into(), message: "must be string".into(), additional_property: None, missing_property: None, allowed_values: None },
            "(root) must be string",
        ),
        (
            AjvError { keyword: "additionalProperties".into(), instance_path: "/x".into(), message: "must NOT have additional properties".into(), additional_property: Some("bogus".into()), missing_property: None, allowed_values: None },
            "/x must NOT have additional properties (property: bogus)",
        ),
        (
            AjvError { keyword: "required".into(), instance_path: "/x".into(), message: "must have required property 'fields'".into(), additional_property: None, missing_property: Some("fields".into()), allowed_values: None },
            "/x must have required property 'fields' (missing: fields)",
        ),
        (
            AjvError { keyword: "enum".into(), instance_path: "/x".into(), message: "must be equal to one of the allowed values".into(), additional_property: None, missing_property: None, allowed_values: Some(vec!["a".into(), "b".into()]) },
            "/x must be equal to one of the allowed values (allowed: a, b)",
        ),
        (
            AjvError { keyword: "additionalProperties".into(), instance_path: "/x".into(), message: "must NOT have additional properties".into(), additional_property: Some(String::new()), missing_property: None, allowed_values: None },
            "/x must NOT have additional properties",
        ),
        (
            AjvError { keyword: "not".into(), instance_path: "/types/0/person/fields/0/id/is_id".into(), message: "must NOT be valid".into(), additional_property: None, missing_property: None, allowed_values: None },
            "/types/0/person/fields/0/id/is_id ids and is_id are mutually exclusive",
        ),
    ];
    for (error, expected) in cases {
        assert_eq!(format_ajv_error(&error), expected);
    }
}

#[test]
fn semantic_documents_reject_the_same_shapes() {
    let types = TypesValidator::new();
    let dup = types.validate("version: 1.0.0\ntypes:\n  - user:\n      fields:\n        - email:\n            type: string\n  - user:\n      fields: []\n");
    assert!(dup.errors.iter().any(|e| e.message.contains("duplicate type")));
    let dictionary = types.validate("version: 1.0.0\ntypes:\n  - settings:\n      inherits: dictionary\n      tags: [datasource_type]\n      fields:\n        - key:\n            type: string\n        - value:\n            type: string\n");
    assert!(dictionary.errors.iter().any(|e| e.message.contains("owner identity")));
    let reserved = types.validate("version: 1.0.0\ntypes:\n  - set:\n      fields:\n        - name:\n            type: string\n");
    assert!(reserved.errors.iter().any(|e| e.message.contains("must NOT be valid")));
    let decimal = types.validate("version: 1.0.0\ntypes:\n  - money:\n      fields:\n        - amount:\n            type: decimal\n            size: [4, 6]\n");
    assert!(decimal.errors.iter().any(|e| e.message.contains("scale must be")));
    let routes = RoutesValidator::new().validate("version: 1.0.0\nroutes:\n  - custom_post:\n      path: /api/people\n      method: POST\n      response: person\n      service: PersonService\n      services: [AuditService]\n      routeClass: PatchPersonRoute\n      module: ./routes/patch-person\n");
    assert!(routes.errors.iter().any(|e| e.message.contains("cannot combine")));
    let services = ServicesValidator::new().validate("version: 1.0.0\nservices:\n  - name: PersonService\n    description: a\n  - name: PersonService\n    description: b\n");
    assert!(services.errors.iter().any(|e| e.message.contains("duplicate service")));
    let filter = types.validate("version: 1.0.0\ntypes: []\nincludes:\n  - types:\n      filter: 'bogus'\n");
    assert!(filter.errors.iter().any(|e| e.message.contains("invalid include filter")));
}

#[test]
fn include_cycles_and_missing_files() {
    let dir = tempfile::tempdir().unwrap();
    let nested = dir.path().join("nested");
    fs::create_dir(&nested).unwrap();
    fs::write(dir.path().join("types.yaml"), "version: 1.0.0\ntypes: []\nincludes:\n  - file: child.yaml\n").unwrap();
    fs::write(dir.path().join("child.yaml"), "includes:\n  - file: types.yaml\n").unwrap();
    let result = TypesValidator::new().validate_file(dir.path().join("types.yaml").to_str().unwrap()).unwrap();
    assert!(result.errors.iter().any(|e| e.message.contains("circular include")), "{:?}", result.errors);
    fs::write(dir.path().join("types.yaml"), "version: 1.0.0\ntypes: []\nincludes:\n  - file: missing.yaml\n").unwrap();
    let result = TypesValidator::new().validate_file(dir.path().join("types.yaml").to_str().unwrap()).unwrap();
    assert!(result.errors.iter().any(|e| e.message.contains("include file not found")));
    fs::write(dir.path().join("types.yaml"), "version: 1.0.0\ntypes: []\nincludes:\n  - file: nested\n").unwrap();
    let result = TypesValidator::new().validate_file(dir.path().join("types.yaml").to_str().unwrap()).unwrap();
    assert!(result.errors.iter().any(|e| e.message.contains("cannot read include")));
    let mut bad = fs::File::create(dir.path().join("bad.yaml")).unwrap();
    writeln!(bad, "foo: [unterminated").unwrap();
    fs::write(dir.path().join("types.yaml"), "version: 1.0.0\ntypes: []\nincludes:\n  - file: bad.yaml\n").unwrap();
    let result = TypesValidator::new().validate_file(dir.path().join("types.yaml").to_str().unwrap()).unwrap();
    assert!(result.errors.iter().any(|e| e.message.contains("not valid YAML") || e.message.contains("include")));
}

#[test]
fn seed_companions_and_field_defaults() {
    let types = "version: 1.0.0\ntypes:\n  - user:\n      inherits: set\n      fields:\n        - email:\n            type: string\n";
    let seeds = DatasourceSeedsValidator::new().validate_with(
        "version: 1.0.0\nseeds:\n  - user:\n      - id1:\n          email: a@b.c\n          created: x\n",
        &ValidateOptions { types: Some(types.into()), ..ValidateOptions::default() },
    );
    assert!(seeds.errors.iter().any(|e| e.message.contains("auto-injected")), "{:?}", seeds.errors);
    let missing = DatasourceSeedsValidator::new().validate("version: 1.0.0\nseeds:\n  - user:\n      - id1:\n          email: a\n");
    assert!(missing.errors.iter().any(|e| e.message.contains("types.yaml is required")));
    let bad_default = TypesValidator::new().validate("version: 1.0.0\ntypes:\n  - user:\n      fields:\n        - flag:\n            type: boolean\n            default_value: maybe\n");
    assert!(!bad_default.valid, "{:?}", bad_default.errors);
}
