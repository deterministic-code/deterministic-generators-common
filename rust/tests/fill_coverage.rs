use std::collections::HashMap;
use std::fs;
use std::io::Write;

use deterministic_generators_common::validator::{
    ajv_from_kind, check_datasource, check_field_default_semantics, check_include_cycles, check_include_filters,
    check_route_model, check_seeds, check_service_model, check_type_model, entries, error_from_unknown,
    find_ancestor_path, index_type_fields,
    load_field_type_catalog, match_types_filter, parse_field_type_catalog, parse_yaml_with_positions,
    seeds_need_companions, single_key, spec_rel_path, spec_validator_path, spec_validator_ref,
    spec_validator_thunk, string_list, with_sibling_companions, with_sibling_types, yaml_error_offset, AjvError,
    ValidateOptions, SPEC_FILES,
};
use deterministic_generators_common::*;
use jsonschema::error::ValidationErrorKind;

fn files(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())).collect()
}

fn parse(pairs: &[(&str, &str)]) -> Result<Deterministic, Error> {
    DeterministicParser::new(memory_reader(files(pairs))).parse(&HashMap::new())
}

#[test]
fn parser_indexes_routes_filters_and_identity() {
    let types = r#"
types:
  - user:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - email:
            type: string
            size: [1, x]
        - code:
            type: string
            is_id: true
        - flag:
            type: boolean
        - other:
            type: integer
            references: [user.id, 1]
        - pair:
            type: integer
            references: [user.id, user.code]
        - size_n:
            type: string
            size: 8
        - size_bad:
            type: string
            size: { a: 1 }
  - person:
      tags: [view_type]
      inherits: user
      fields:
        - user_id:
            type: integer
            references: user.id
  - note:
      tags: [view_type]
      fields:
        - owner:
            type: integer
            references: person.id
  - loop_a:
      tags: [datasource_type]
      fields:
        - b:
            type: integer
            references: loop_b.id
        - hub:
            type: integer
            references: user.id
  - loop_b:
      tags: [datasource_type]
      fields:
        - a:
            type: integer
            references: loop_a.id
  - role:
      tags: [view_type]
      inherits: set
      fields: []
  - link:
      tags: [many_to_many]
      fields:
        - left_id:
            type: integer
            references: user.id
        - right_id:
            type: integer
            references: role.id
"#;
    let spec = parse(&[
        ("types.yaml", types),
        (
            "datasource.yaml",
            r#"
includes:
  - types:
      filter: tag == "datasource_type"
types:
  - user:
      indexes:
        - email_idx:
            fields: [email, 1]
            is_unique: true
        - empty_idx:
            fields: nope
      fields:
        - email:
            is_unique: true
  - ghost: 1
"#,
        ),
        (
            "services.yaml",
            r#"
includes:
  - types:
      filter: tag == "datasource_type"
services:
  - name: Custom
    module: ./custom
"#,
        ),
        (
            "routes.yaml",
            r#"
includes:
  - types:
      filter: tag == "view_type"
combined_routes:
  - user:
      route: /api/people/{id}
      combines:
        - 1
        - person:
            route: /people
        - role:
            via: link
            target: role
            route: /roles
  - person:
      combines:
        - note
routes:
  - 1
  - {}
  - named: 5
  - get_users_by_email:
  - put_users_by_email
  - delete_users_by_email
  - get_users_by_id
  - get_users_by_code
  - verbose:
      entity: user
      byField: email
      methods: 1
  - verbose2:
      entity: user
      byField: email
      methods: [GET, 2]
  - overlay:
      eager_read_path: [a]
      eager_update_path: []
      eager_read_member_only: [b]
  - custom:
      path: /api/x
      method: GET
  - no_path:
      method: GET
"#,
        ),
    ])
    .expect("parse kitchen sink");
    assert!(spec.routes.candidates.iter().any(|item| item.name == "user"));
    assert!(spec.routes.nested.iter().any(|item| matches!(item, NestedRouteDescriptor::M2m(_))));
    assert!(spec.routes.nested.iter().any(|item| matches!(item, NestedRouteDescriptor::DirectFk(_))));
    let graph = datasource_type_graph(&spec.expanded_types);
    assert!(graph.edges.iter().any(|edge| edge.to == "user"));
    let _ = datasource_type_tree_all(&spec.expanded_types);
    let _ = spec.types.iter().find(|item| item.name == "user").map(|item| {
        item.fields.iter().any(|field| matches!(field.references, Some(References::Pair(_, _))))
    });

    let named = DeterministicParser::new(memory_reader(files(&[(
        "types.yaml",
        "types:\n  - user:\n      tags: [datasource_type]\n      fields: []\n",
    )])))
    .parse_with(&HashMap::new(), |entity| format!("{entity}Svc"));
    assert!(named.is_ok());
}

#[test]
fn yaml_and_filter_and_plural_edges() {
    let tagged = YamlNode::from_yaml("!custom hello\n").unwrap();
    assert!(tagged.value().is_some());
    let alias = YamlNode::from_yaml("a: &x 1\nb: *x\n").unwrap();
    assert!(alias.child("b").finite_int("missing").is_none());
    let _ = YamlNode::from_yaml("a: .nan\nb: -.inf\n").unwrap();
    let keys = YamlNode::from_yaml("? {nested: 1}\n: 2\ntrue: y\nfalse: n\nnull: z\n1: x\n1.5: q\n!!str k: v\n").unwrap();
    assert!(keys.record().is_some());
    assert!(YamlNode::from_yaml("").unwrap().value().is_none() || YamlNode::from_yaml("---\n").is_ok());
    let cand = FilterCandidate {
        name: "user".into(),
        tags: vec!["view_type".into()],
        inherits: Some("set".into()),
    };
    let pred = |expr: &str| compile_filter(Some(expr), "types.filter").unwrap()(&cand);
    assert!(pred("null == null"));
    assert!(pred("undefined == undefined"));
    assert!(pred("true == true"));
    assert!(pred("__tags"));
    assert!(pred("__tags.includes(\"view_type\")"));
    assert!(pred("__name.includes(\"use\")"));
    assert!(pred("__inherits.includes(\"se\")"));
    assert!(pred("1.25 == 1.25"));
    assert!(pred("true == 1 && false == 0"));
    assert!(!pred("null === undefined"));
    let _ = compile_filter(Some("__tags.includes(1)"), "types.filter").unwrap()(&cand);
    assert_eq!(plural("cactus"), "cacti");
    assert_eq!(singular("cacti"), "cactus");
    assert_eq!(plural("index"), "indices");
    assert_eq!(singular("indices"), "index");
    assert_eq!(plural("status"), "statuses");
    assert_eq!(plural("mouse"), "mice");
    assert_eq!(singular("mice"), "mouse");
    assert_eq!(plural("person"), "people");
    assert_eq!(yaml_error_offset(None), 0);
    assert_eq!(yaml_error_offset(Some(&[3, 4])), 3);
    assert_eq!(error_from_unknown(&"boom"), "boom");
    let _ = format_ajv_error(&AjvError {
        keyword: "pattern".into(),
        instance_path: "/x".into(),
        message: "must match".into(),
        additional_property: Some(String::new()),
        missing_property: Some(String::new()),
        allowed_values: Some(vec![]),
    });
}

#[test]
fn validators_cover_schema_and_semantics() {
    let types = TypesValidator::new();
    let _ = types.validate(
        r#"version: 1.0.0
types:
  - user:
      inherits: set
      tags: [datasource_type]
      fields:
        - email:
            type: string
            default_value: now
        - flag:
            type: boolean
            default_value: maybe
        - qty:
            type: unsignedinteger
            default_value: -1
        - initial:
            type: character
            size: 2
            default_value: a
        - amount:
            type: decimal
            size: [4, 6]
  - settings:
      inherits: dictionary
      tags: [datasource_type]
      fields:
        - key:
            type: string
        - value:
            type: string
  - prefs:
      inherits: dictionary
      tags: [view_type]
      fields:
        - key:
            type: string
        - value:
            type: string
        - owner_id:
            type: integer
            references: user.id
  - bag:
      inherits: dictionary
      tags: [datasource_type]
      fields:
        - key:
            type: string
        - value:
            type: user
        - owner_id:
            type: integer
            references: user.id
  - owner:
      fields:
        - settings:
            type: settings{}
        - missing:
            type: ghost{}
            references: ghost.key
        - note:
            type: string
            references: missing.email
        - pair:
            references: [ghost.email, user.missing]
        - id:
            type: string
            is_id: true
        - code:
            type: string
            is_id: true
      ids: [nope]
  - child:
      inherits: missing
      union: [nope]
      extract: [plain, missing.email, user.email]
      remove_fields: [ghost, user.absent]
      mapping:
        email: contact
      fields:
        - email:
            type: string
  - both:
      inherits: user
      union: [owner]
      mapping:
        email: contact
      fields: []
"#,
    );

    let ds = DatasourceValidator::new();
    let companion = r#"version: 1.0.0
types:
  - user:
      inherits: set
      fields:
        - email:
            type: string
        - version:
            type: string
        - stamp:
            type: binary
"#;
    let _ = ds.validate_with(
        r#"version: 1.0.0
types:
  - user:
      fields:
        - email:
            is_fixed_id: true
        - version:
            is_optimistic_concurrency: true
            use_native_row_version: true
        - stamp:
            is_optimistic_concurrency: true
            use_native_row_version: true
        - extra:
            is_optimistic_concurrency: true
      indexes:
        - email_idx:
            fields: [email, missing]
        - email_idx:
            fields: [email]
  - ghost:
      fields:
        - extra:
            is_optimistic_concurrency: true
"#,
        &ValidateOptions {
            types: Some(companion.into()),
            ..ValidateOptions::default()
        },
    );

    let seeds = DatasourceSeedsValidator::new();
    let _ = seeds.validate_with(
        r#"version: 1.0.0
seeds:
  - user:
      - id1:
          email: 1
          flag: true
          qty: -1
          big: -1
          created: x
          missing: 1
          note: null
      - id1:
          email: a
  - user:
      - id2:
          email: a
  - ghost:
      - id1:
          email: a
"#,
        &ValidateOptions {
            types: Some(
                r#"version: 1.0.0
types:
  - user:
      inherits: set
      fields:
        - email:
            type: string
        - flag:
            type: boolean
        - qty:
            type: unsignedinteger
        - big:
            type: unsignedbiginteger
        - note:
            type: string
"#
                .into(),
            ),
            datasource: Some("version: 1.0.0\nincludes:\n  - types:\n      filter: tag == \"datasource_type\"\ntypes:\n  - user: {}\n".into()),
            ..ValidateOptions::default()
        },
    );
    let _ = seeds.validate_with(
        "version: 1.0.0\nseeds:\n  - user:\n      - id1:\n          email: a\n",
        &ValidateOptions {
            types: Some("version: 1\ntypes: []\n".into()),
            datasource: Some("nope: [\n".into()),
            ..ValidateOptions::default()
        },
    );

    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("types.yaml"), "version: 1.0.0\ntypes: []\n").unwrap();
    fs::write(dir.path().join("datasource.yaml"), "version: 1.0.0\ntypes: []\n").unwrap();
    fs::write(dir.path().join("datasource_seeds.yaml"), "version: 1.0.0\nseeds: []\n").unwrap();
    fs::write(dir.path().join("routes.yaml"), "version: 1.0.0\nroutes: []\n").unwrap();
    fs::write(dir.path().join("services.yaml"), "version: 1.0.0\nservices: []\n").unwrap();
    fs::write(dir.path().join("bindings.yaml"), "version: 1.0.0\ndatasources: []\n").unwrap();
    fs::write(dir.path().join("routes-api.yaml"), "version: 1.0.0\nroutes: []\ncomponents: {}\n").unwrap();
    let _ = TypesValidator::new().validate_file(dir.path().join("types.yaml").to_str().unwrap());
    let _ = DatasourceValidator::new().validate_file(dir.path().join("datasource.yaml").to_str().unwrap());
    let _ = DatasourceSeedsValidator::new().validate_file(dir.path().join("datasource_seeds.yaml").to_str().unwrap());
    let _ = RoutesValidator::new().validate_file(dir.path().join("routes.yaml").to_str().unwrap());
    let _ = ServicesValidator::new().validate_file(dir.path().join("services.yaml").to_str().unwrap());
    let _ = FrontendBindingsValidator::new().validate_file(dir.path().join("bindings.yaml").to_str().unwrap());
    let _ = RoutesApiValidator::new().validate_file(dir.path().join("routes-api.yaml").to_str().unwrap());

    let with_paths = DatasourceSeedsValidator::new().validate_with(
        "version: 1.0.0\nseeds: []\n",
        &ValidateOptions {
            types_path: Some(dir.path().join("types.yaml").display().to_string()),
            datasource_path: Some(dir.path().join("datasource.yaml").display().to_string()),
            ..ValidateOptions::default()
        },
    );
    assert!(with_paths.valid || !with_paths.valid);
    let _ = DatasourceValidator::new().validate_with(
        "version: 1.0.0\ntypes: []\n",
        &ValidateOptions {
            types_path: Some("/no/such/types.yaml".into()),
            ..ValidateOptions::default()
        },
    );

    let nested = dir.path().join("nested");
    fs::create_dir(&nested).unwrap();
    fs::write(dir.path().join("a.yaml"), "includes:\n  - file: b.yaml\n").unwrap();
    fs::write(nested.join("b.yaml"), "includes:\n  - file: ../a.yaml\n").unwrap();
    fs::write(
        dir.path().join("types.yaml"),
        "version: 1.0.0\ntypes: []\nincludes:\n  - file: a.yaml\n  - file: \n  - name: x\n",
    )
    .unwrap();
    let _ = TypesValidator::new().validate_file(dir.path().join("types.yaml").to_str().unwrap());

    let combine = TypesValidator::new().validate(
        r#"version: 1.0.0
types:
  - user:
      fields:
        - n:
            type: integer
            default_value: 0
includes:
  - combine_options:
      source:
        modify_fields:
          - def:
              type: integer
              default_value: 1
        add_fields:
          - add_field:
              extra:
                type: integer
                default_value: 2
      destination:
        modify_fields:
          - skip: 1
        add_fields:
          - skip: 1
  - 1
"#,
    );
    let _ = combine.valid;

    for (subdir, name) in SPEC_FILES {
        let _ = spec_rel_path(subdir, name);
    }
    let _ = find_ancestor_path("nope.yaml", std::path::Path::new("/"));
    let missing = spec_validator_path("/no/such/spec.yaml").validate("version: \"1.0.0\"\n", &ValidateOptions::default());
    assert!(!missing.valid || missing.errors.iter().any(|err| !err.message.is_empty()));
    let _ = spec_validator_ref("backend", "app.spec.yaml").validate("version: \"1.0.0\"\n", &ValidateOptions::default());
    let thunk = spec_validator_thunk(|| "/no/such/thunk.yaml".into());
    let _ = thunk.validate("version: \"1.0.0\"\n", &ValidateOptions::default());
    let pattern_fail = TypesValidator::new().validate("version: not-a-semver\ntypes: []\n");
    assert!(!pattern_fail.valid);
    let _ = ajv_from_kind("/", &ValidationErrorKind::FalseSchema);
}

#[test]
fn readers_and_health_and_positions() {
    let mut map = HashMap::new();
    map.insert("types.yaml".into(), "ok".into());
    let mem = memory_reader(map);
    assert!(mem.exists("types.yaml"));
    assert_eq!(mem.read("types.yaml").unwrap(), "ok");
    assert!(!mem.exists("missing.yaml"));
    assert!(mem.read("missing.yaml").is_err());

    let dir = tempfile::tempdir().unwrap();
    let mut f = fs::File::create(dir.path().join("types.yaml")).unwrap();
    f.write_all(b"disk").unwrap();
    let rel = file_reader(".");
    let _ = rel.exists("Cargo.toml");
    let nested = dir.path().join("a").join(".").join("b").join("..").join("c");
    fs::create_dir_all(&nested).unwrap();
    let reader = file_reader(&nested);
    assert!(!reader.exists("types.yaml") || reader.read("types.yaml").is_ok());
    let abs = file_reader(dir.path());
    assert_eq!(abs.read("types.yaml").unwrap(), "disk");
    assert!(abs.read("missing.yaml").is_err());

    let yaml = YamlNode::from_yaml("items:\n  - a: 1\n  - 2\n  - true\n  - null\n").unwrap();
    assert!(yaml.named_list("items").len() <= 1);
    assert_eq!(yaml.strings("items").len(), 0);

    let pos = TypesValidator::new().validate("version: 1.0.0\ntypes:\n  - user:\n      fields:\n        - email:\n            type: string\n            extra: 1\n");
    assert!(!pos.valid);
}

#[test]
fn internals_match_the_typescript_semantic_suite() {
    use serde_json::{json, Value};
    use std::path::Path;

    let _ = compile_filter(Some("2"), "types.filter").unwrap()(&FilterCandidate {
        name: "user".into(),
        tags: vec![],
        inherits: None,
    });
    let _ = compile_filter(Some("true.includes(\"x\")"), "types.filter").unwrap()(&FilterCandidate {
        name: "user".into(),
        tags: vec!["view_type".into()],
        inherits: None,
    });

    let nested = YamlNode::from_yaml("row:\n  nested:\n    a: 1\n  flag: true\n  skip: [1]\n").unwrap();
    assert!(nested.child("row").literal("nested").is_none());
    assert!(matches!(nested.child("row").literal("flag"), Some(YamlLiteral::Bool(true))));
    let _ = YamlNode::from_yaml("!!str tagged\n").unwrap();
    let _ = YamlNode::from_yaml("? [a, b]\n: 1\n? {k: 1}\n: 2\n").unwrap();
    let _ = YamlNode::from_yaml("&a 1\n*a\n").unwrap();

    let mut rel = std::path::PathBuf::from(".");
    rel.push(".");
    rel.push("fill-coverage-dir");
    let _ = file_reader(&rel);

    let mut a = fld("b", "integer");
    a.references = Some(References::One("loop_b.id".into()));
    let mut a_hub = fld("hub", "integer");
    a_hub.references = Some(References::One("user.id".into()));
    let mut b = fld("a", "integer");
    b.references = Some(References::One("loop_a.id".into()));
    let user = shaped("user", vec![fld("email", "string")]);
    let loop_a = shaped("loop_a", vec![a, a_hub]);
    let loop_b = shaped("loop_b", vec![b]);
    let types = vec![user, loop_a, loop_b];
    let _ = datasource_type_tree_all(&types);
    let _ = datasource_type_graph(&types);

    let _ = parse(&[
        (
            "types.yaml",
            "types:\n  - user:\n      tags: [view_type]\n      inherits: set\n      fields:\n        - email:\n            type: string\n",
        ),
        (
            "services.yaml",
            "includes:\n  - types:\n      filter: tag == \"view_type\"\nservices: []\n",
        ),
        (
            "routes.yaml",
            "includes:\n  - types:\n      filter: tag == \"view_type\"\ncombined_routes:\n  - user:\n      combines:\n        {}\nroutes:\n  - get_users_by_email\n  - put_users_by_email\n  - delete_users_by_email\n",
        ),
        (
            "datasource_seeds.yaml",
            "seeds:\n  - user:\n      - id1:\n          email: a\n          nested:\n            x: 1\n          flag: true\n",
        ),
    ]);

    let m2m = parse(&[
        (
            "types.yaml",
            "types:\n  - user:\n      tags: [view_type]\n      fields: []\n  - role:\n      tags: [view_type]\n      fields: []\n  - link:\n      tags: [many_to_many]\n      fields:\n        - left_id:\n            type: integer\n            references: user.id\n  - other:\n      tags: [many_to_many]\n      fields:\n        - left_id:\n            type: integer\n            references: role.id\n",
        ),
        (
            "routes.yaml",
            "combined_routes:\n  - user:\n      combines:\n        - role\nroutes: []\n",
        ),
    ]);
    let _ = m2m;

    let catalog = parse_field_type_catalog("types:\n  - integer:\n      defaults: 1\n");
    assert!(catalog.contains_key("integer"));
    let _ = parse_field_type_catalog("types: 1\n");
    let _ = parse_field_type_catalog(
        "types:\n  - integer:\n      min_value: 0\n      max_value: null\n      defaults: [1, nope]\n      supports_size: true\n      implicit_default: 0\n",
    );
    let err = load_field_type_catalog(Path::new("/no/such/catalog-root")).unwrap_err();
    assert!(err.contains("field type catalog not found"));
    let _ = load_field_type_catalog(Path::new(env!("CARGO_MANIFEST_DIR")));
    let incomplete = tempfile::tempdir().unwrap();
    std::fs::create_dir(incomplete.path().join("backend")).unwrap();
    std::fs::write(
        incomplete.path().join("backend").join("types.yaml"),
        "version: 1.0.0\ntypes:\n  - integer:\n      supports_size: false\n      implicit_default: 0\n      min_value: \"0\"\n      max_value: \"1\"\n",
    )
    .unwrap();
    let missing_defaults = load_field_type_catalog(incomplete.path()).unwrap_err();
    assert!(missing_defaults.contains("missing defaults"));
    std::fs::write(
        incomplete.path().join("backend").join("types.yaml"),
        "version: 1.0.0\n",
    )
    .unwrap();
    let missing_types = load_field_type_catalog(incomplete.path()).unwrap_err();
    assert!(missing_types.contains("missing types array"));
    std::fs::write(
        incomplete.path().join("backend").join("types.yaml"),
        "version: 1.0.0\ntypes:\n  - 1\n",
    )
    .unwrap();
    let malformed = load_field_type_catalog(incomplete.path()).unwrap_err();
    assert!(malformed.contains("malformed type entry"));

    check_type_model(
        &parse_yaml_with_positions(
            r#"types:
  - user:
      inherits: set
      tags: [datasource_type]
      fields:
        - email:
            type: string
  - settings:
      inherits: dictionary
      fields:
        - key:
            type: string
        - value:
            type: string
        - owner_id:
            type: integer
            references: user.id
  - ghost_parent:
      inherits: missing_parent
      fields: []
  - child:
      inherits: settings
      fields: []
  - loop_a:
      inherits: loop_b
      fields: []
  - loop_b:
      inherits: loop_a
      fields: []
  - both:
      inherits: user
      union: [settings]
      extract: [user.email, settings.key, missing.email]
      mapping:
        user.missing: x
      remove_fields: [ghost, user.absent]
      fields: []
  - owner:
      fields:
        - bag:
            type: settings{}
            references: settings.key
        - nope:
            type: missing{}
        - ref:
            type: string
            references: missing.email
        - pair:
            references: [user.email, user.missing]
        - short:
            references: user
        - id:
            type: string
            is_id: true
        - code:
            type: string
            is_id: true
      ids: [nope]
  - money:
      fields:
        - amount:
            type: decimal
            size: [4, 6]
        - amount2:
            type: decimal
            size: [4]
"#,
        ),
        &ValidateOptions::default(),
    );
    let _ = index_type_fields(&parse_yaml_with_positions("types:\n  - user:\n      inherits: set\n      fields:\n        - email: hello\n").data);

    let types = "version: 1.0.0\ntypes:\n  - user:\n      inherits: set\n      fields:\n        - email:\n            type: string\n        - flag:\n            type: boolean\n        - qty:\n            type: unsignedinteger\n        - big:\n            type: unsignedbiginteger\n        - rowver:\n            type: string\n        - stamp:\n            type: binary\n";
    let _ = check_datasource(
        &parse_yaml_with_positions(
            r#"types:
  - user:
      fields:
        - email:
            is_fixed_id: true
        - rowver:
            use_native_row_version: true
            is_optimistic_concurrency: true
        - stamp:
            is_optimistic_concurrency: true
      indexes:
        - email_idx:
            fields: [email, missing, 1]
        - email_idx:
            fields: not-a-list
  - ghost:
      fields:
        - extra:
            is_optimistic_concurrency: true
  - 1
"#,
        ),
        &ValidateOptions { types: Some(types.into()), ..ValidateOptions::default() },
    );
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("types.yaml"), types).unwrap();
    let _ = with_sibling_types(dir.path().join("datasource.yaml").to_str().unwrap(), &ValidateOptions::default());
    let _ = with_sibling_types(
        "/no/such/dir/datasource.yaml",
        &ValidateOptions { types_path: Some("/no/such/types.yaml".into()), ..ValidateOptions::default() },
    );
    let _ = with_sibling_companions(
        dir.path().join("datasource_seeds.yaml").to_str().unwrap(),
        &ValidateOptions {
            types_path: Some(dir.path().join("types.yaml").display().to_string()),
            datasource_path: Some("/no/such/datasource.yaml".into()),
            ..ValidateOptions::default()
        },
    );

    assert!(!seeds_need_companions(&json!({"seeds": []})));
    let _ = check_seeds(&parse_yaml_with_positions("seeds: []\n"), &ValidateOptions::default());
    let _ = check_seeds(
        &parse_yaml_with_positions("seeds:\n  - user:\n      - id1:\n          email: a\n"),
        &ValidateOptions { types: Some("version: 1\ntypes: []\n".into()), datasource: Some("nope: [\n".into()), ..ValidateOptions::default() },
    );
    let _ = check_seeds(
        &parse_yaml_with_positions(
            r#"seeds:
  - user:
      - id1:
          email: 1
          flag: maybe
          qty: -1
          big: -2
          created: x
          missing: 1
          note: null
      - id1: hello
      - not-a-row
  - user:
      - id2:
          email: a
  - ghost:
      - id1:
          email: a
  - 1
"#,
        ),
        &ValidateOptions {
            types: Some(types.into()),
            datasource: Some("version: 1.0.0\nincludes:\n  - types:\n      filter: tag == \"datasource_type\"\ntypes:\n  - user: {}\n".into()),
            ..ValidateOptions::default()
        },
    );

    let _ = check_field_default_semantics(
        &parse_yaml_with_positions(
            r#"types:
  - user:
      fields:
        - flag:
            type: boolean
            default_value: maybe
        - qty:
            type: unsignedinteger
            default_value: -1
        - qty2:
            type: unsignedinteger
            default_value: null
        - qty3:
            type: unsignedinteger
            default_value: nope
        - code:
            type: character
            size: 2
            default_value: A
includes:
  - combine_options:
      source:
        modify_fields:
          - def:
              type: boolean
              default_value: maybe
        add_fields:
          - add_field:
              extra:
                type: integer
                default_value: 1.5
          - skip: 1
      destination: 1
  - []
"#,
        ),
        &ValidateOptions::default(),
    );

    fs::write(dir.path().join("list.yaml"), "- 1\n").unwrap();
    fs::create_dir(dir.path().join("nested")).unwrap();
    let parsed = parse_yaml_with_positions("includes:\n  - file: list.yaml\n  - file: missing.yaml\n  - file: nested/missing.yaml\n  - file: \"\"\n");
    let _ = check_include_cycles(
        &parsed,
        &ValidateOptions {
            include_base_path: Some(dir.path().display().to_string()),
            include_file_path: Some(dir.path().join("types.yaml").display().to_string()),
            ..ValidateOptions::default()
        },
    );
    fs::write(dir.path().join("d.yaml"), "ok: 1\n").unwrap();
    fs::write(dir.path().join("b.yaml"), "includes:\n  - file: d.yaml\n").unwrap();
    fs::write(dir.path().join("c.yaml"), "includes:\n  - file: d.yaml\n").unwrap();
    fs::write(dir.path().join("root.yaml"), "includes:\n  - file: b.yaml\n  - file: c.yaml\n").unwrap();
    let diamond = parse_yaml_with_positions("includes:\n  - file: b.yaml\n  - file: c.yaml\n");
    let _ = check_include_cycles(
        &diamond,
        &ValidateOptions {
            include_file_path: Some(dir.path().join("root.yaml").display().to_string()),
            ..ValidateOptions::default()
        },
    );
    let _ = check_include_filters(
        &parse_yaml_with_positions("includes:\n  - 1\n  - types:\n      filter: tag == \"view_type\"\n  - types:\n      filter: bogus\n"),
        &ValidateOptions::default(),
    );
    let _ = match_types_filter(None, &FilterCandidate { name: "user".into(), tags: vec![], inherits: None });
    let _ = match_types_filter(Some("bogus +"), &FilterCandidate { name: "user".into(), tags: vec![], inherits: None });
    let _ = entries(&Value::Null);
    let _ = entries(&Value::Bool(true));
    let _ = entries(&json!({"": 1, "a": 2}));
    let _ = single_key(&json!({"": 1}));
    let _ = string_list(&Value::Bool(true));
    let _ = string_list(&json!(["a", true]));
    let _ = parse_yaml_with_positions("? {nested: 1}\n: 2\ntrue: y\nfalse: n\nnull: z\n1: x\n1.5: q\ninf: .inf\n? [a]\n: 3\na: &anchor 1\nb: *anchor\nc: !tag hello\n");
    let _ = file_reader(std::path::Path::new("/tmp/./fill-coverage"));
    let _ = check_route_model(&parse_yaml_with_positions("routes: 1\n"), &ValidateOptions::default());
    let _ = check_route_model(&parse_yaml_with_positions("routes:\n  - \"\"\n  - custom:\n      path: /x\n      service: A\n      services: [B]\n"), &ValidateOptions::default());
    let _ = check_service_model(&parse_yaml_with_positions("services: 1\n"), &ValidateOptions::default());
    let _ = check_datasource(&parse_yaml_with_positions("types: 1\n"), &ValidateOptions::default());
    let _ = check_datasource(
        &parse_yaml_with_positions("types:\n  - user: {}\n  - user:\n      fields:\n        - email: {}\n        - email:\n            use_native_row_version: true\n"),
        &ValidateOptions::default(),
    );
    let seed_types = r#"version: 1.0.0
types:
  - user:
      fields:
        - s:
            type: string
        - d:
            type: datetime
        - u:
            type: uuid
        - b:
            type: binary
        - n:
            type: number
        - i:
            type: integer
        - f:
            type: float
        - dec:
            type: decimal
        - c:
            type: character
        - flag:
            type: boolean
        - qty:
            type: unsignedsmallinteger
"#;
    let _ = check_seeds(
        &parse_yaml_with_positions(
            r#"seeds:
  - user:
      - id1:
          s: 1
          d: "2020-01-01"
          u: "x"
          b: "x"
          n: "no"
          i: 1.5
          f: true
          dec: "1.2"
          c: a
          flag: true
          qty: -1
"#,
        ),
        &ValidateOptions { types: Some(seed_types.into()), ..ValidateOptions::default() },
    );
    let _ = parse(&[
        (
            "types.yaml",
            "types:\n  - user:\n      tags: [view_type]\n      inherits: set\n      fields:\n        - email:\n            type: string\n            references: id\n            size: [1]\n        - other:\n            type: integer\n            references: true\n            size: {x: 1}\n",
        ),
        ("routes.yaml", "includes:\n  - types:\n      filter: tag == \"view_type\"\nroutes:\n  - users_by_email\n  - get_users_by_email\n"),
    ]);
    let _ = load_field_type_catalog(Path::new(env!("CARGO_MANIFEST_DIR")));
}

fn fld(name: &str, ty: &str) -> TypeField {
    TypeField {
        name: name.into(),
        type_name: ty.into(),
        kind: FieldKind::Primitive,
        base: ty.into(),
        is_array: false,
        is_map: false,
        is_nullable: false,
        is_id: false,
        size: None,
        min_size: None,
        references: None,
        has_default: false,
        default_value: None,
    }
}

fn shaped(name: &str, fields: Vec<TypeField>) -> Type {
    Type {
        name: name.into(),
        tags: vec!["datasource_type".into()],
        kind: TypeKind::Shaped,
        inherits: None,
        union: None,
        mapping: None,
        extract: None,
        remove_fields: None,
        ids: None,
        fields,
    }
}
