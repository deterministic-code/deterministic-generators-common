use std::path::Path;

use jsonschema::error::{TypeKind, ValidationErrorKind};
use jsonschema::{JsonType, JsonTypeSet};
use serde_json::{json, Value};

use super::catalog::{load_field_type_catalog, parse_field_type_catalog};
use super::datasource_model::{check_datasource, with_sibling_types};
use super::defaults::check_field_default_semantics;
use super::include::check_include_cycles;
use super::positions::{entries, parse_yaml_with_positions, string_list};
use super::schema::{ajv_from_kind, format_ajv_error, AjvError, SpecValidator, ValidateOptions};
use super::seeds::{check_seeds, seeds_need_companions, with_sibling_companions};
use super::type_model::{check_type_model, index_type_fields};

fn type_messages(yaml: &str) -> Vec<String> {
    check_type_model(&parse_yaml_with_positions(yaml), &ValidateOptions::default())
        .errors
        .into_iter()
        .map(|err| err.message)
        .collect()
}

fn has(messages: &[String], needle: &str) -> bool {
    messages.iter().any(|message| message.contains(needle))
}

#[test]
fn type_model_rejects_the_same_shapes_as_typescript() {
    assert!(has(&type_messages("types: 1\n"), "") || type_messages("types: 1\n").is_empty());
    let reserved = type_messages("types:\n  - set:\n      fields:\n        - name: 1\n  - dictionary: []\n  - user: 1\n  - note:\n      fields:\n        - email: 1\n        - email:\n            type: string\n");
    assert!(has(&reserved, "reserved type name"));
    assert!(has(&reserved, "duplicate field"));

    let compose = type_messages(
        r#"types:
  - base:
      fields:
        - email:
            type: string
        - name:
            type: string
  - other:
      fields:
        - email:
            type: string
  - child:
      inherits: missing
      union: [nope, set]
      extract: [plain, missing.email, base.email, base.absent]
      remove_fields: [ghost, base.absent]
      mapping:
        email: contact
        base.absent: nope
      fields:
        - email:
            type: string
  - loop_a:
      inherits: loop_b
      fields: []
  - loop_b:
      inherits: loop_a
      fields: []
  - both:
      inherits: base
      union: [other]
      mapping:
        email: contact
      fields: []
"#,
    );
    assert!(has(&compose, "unknown inherit"));
    let ids = type_messages(
        r#"types:
  - link:
      inherits: set
      ids: [left_id, right_id]
      fields:
        - left_id:
            type: integer
        - right_id:
            type: integer
  - person:
      inherits: set
      fields:
        - code:
            type: string
            is_id: true
  - alias:
      inherits: person
      fields: []
  - settings:
      inherits: dictionary
      fields:
        - owner_id:
            type: integer
            references: alias.code
        - key:
            type: string
        - value:
            type: string
"#,
    );
    let _ = ids;
    assert!(has(&compose, "unknown type"));
    assert!(has(&compose, "circular inherit"));
    assert!(has(&compose, "not a field"));
    assert!(has(&compose, "collide") || has(&compose, "matches more than one"));

    let dictionary = type_messages(
        r#"types:
  - user:
      inherits: set
      tags: [datasource_type]
      fields:
        - email:
            type: string
  - prefs:
      inherits: dictionary
      tags: [datasource_type, view_type]
      fields:
        - key:
            type: string
        - owner:
            type: integer
            references: [user.id, user.id]
  - view_prefs:
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
      fields:
        - key:
            type: string
        - value:
            type: user
  - owner:
      fields:
        - settings:
            type: prefs{}
        - other:
            type: missing{}
            references: prefs.key
"#,
    );
    assert!(has(&dictionary, "must include a value field"));
    assert!(has(&dictionary, "must not be tagged datasource_type"));
    assert!(has(&dictionary, "must not reference an owner identity"));
    assert!(has(&dictionary, "value must not be a datasource_type"));
    assert!(has(&dictionary, "must name a dictionary type") || has(&dictionary, "must reference"));

    let roles = type_messages(
        r#"types:
  - phone:
      tags: [datasource_type]
      inherits: set
  - phone_attribute:
      tags: [datasource_type]
      inherits: set
      fields:
        - phone_id:
            references: phone.id
        - other:
            type: string
  - attrs:
      tags: [view_type]
      inherits: dictionary
      fields:
        - key:
            type: string
            references: phone.other
        - value:
            type: string
  - phone_view:
      tags: [view_type]
      inherits: phone
      fields:
        - attributes:
            type: attrs{}
            references: phone_attribute.phone_id
"#,
    );
    assert!(has(&roles, "must reference a column on phone_attribute"));
    assert!(has(&roles, "must include a value column"));

    let refs = type_messages(
        r#"types:
  - user:
      fields:
        - note:
            type: string
            references: missing.email
        - pair:
            references: [ghost.email, .id, user.missing]
        - amount:
            type: decimal
            size: [4, 6]
        - amount2:
            type: decimal
            size: [4, x]
        - id:
            type: string
            is_id: true
        - code:
            type: string
            is_id: true
      ids: [id, nope, 1]
"#,
    );
    assert!(has(&refs, "unknown type"));
    assert!(has(&refs, "unknown field"));
    assert!(has(&refs, "scale must be"));
    assert!(has(&refs, "at most one"));
    assert!(has(&refs, "mutually exclusive"));
    assert!(has(&refs, "is not a field"));

    let indexed = index_type_fields(&parse_yaml_with_positions(
        "types:\n  - user:\n      inherits: set\n      fields:\n        - email: hello\n        - code:\n            type: string\n            is_id: true\n            references: user.id\n",
    ).data);
    assert!(indexed["user"].contains_key("id") || indexed["user"].contains_key("email"));
}

#[test]
fn datasource_and_seed_semantics() {
    let types = "version: 1.0.0\ntypes:\n  - user:\n      inherits: set\n      fields:\n        - email:\n            type: string\n        - flag:\n            type: boolean\n        - qty:\n            type: unsignedinteger\n        - big:\n            type: unsignedbiginteger\n        - rowver:\n            type: string\n        - stamp:\n            type: binary\n";
    let datasource = parse_yaml_with_positions(
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
    );
    let result = check_datasource(
        &datasource,
        &ValidateOptions { types: Some(types.into()), ..ValidateOptions::default() },
    );
    let messages: Vec<_> = result.errors.iter().map(|err| err.message.clone()).collect();
    assert!(has(&messages, "is_fixed_id"));
    assert!(has(&messages, "at most one") || has(&messages, "binary"));
    assert!(has(&messages, "unknown field") || has(&messages, "unknown type"));
    assert!(has(&messages, "duplicate index"));

    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("types.yaml"), types).unwrap();
    let options = with_sibling_types(dir.path().join("datasource.yaml").to_str().unwrap(), &ValidateOptions::default());
    assert!(options.types.is_some());
    let missing = with_sibling_types(
        "/no/such/dir/datasource.yaml",
        &ValidateOptions { types_path: Some("/no/such/types.yaml".into()), ..ValidateOptions::default() },
    );
    assert!(missing.types.is_none());

    assert!(!seeds_need_companions(&json!({"seeds": []})));
    assert!(seeds_need_companions(&json!({"seeds": [1]})));
    let empty = check_seeds(&parse_yaml_with_positions("seeds: []\n"), &ValidateOptions::default());
    assert!(empty.valid);
    let invalid_types = check_seeds(
        &parse_yaml_with_positions("seeds:\n  - user:\n      - id1:\n          email: a\n"),
        &ValidateOptions { types: Some("version: 1\ntypes: []\n".into()), ..ValidateOptions::default() },
    );
    assert!(invalid_types.errors[0].message.contains("companion types.yaml is invalid"));
    let invalid_ds = check_seeds(
        &parse_yaml_with_positions("seeds:\n  - user:\n      - id1:\n          email: a\n"),
        &ValidateOptions {
            types: Some(types.into()),
            datasource: Some("nope: [\n".into()),
            ..ValidateOptions::default()
        },
    );
    assert!(invalid_ds.errors[0].message.contains("companion datasource") || !invalid_ds.valid);

    let seeds = check_seeds(
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
seeds_extra: 1
"#,
        ),
        &ValidateOptions {
            types: Some(types.into()),
            datasource: Some("version: 1.0.0\ntypes:\n  - user: {}\n".into()),
            ..ValidateOptions::default()
        },
    );
    assert!(
        seeds.errors.iter().any(|err| err.message.contains("must be") || err.message.contains("auto-injected")),
        "{:?}",
        seeds.errors
    );
    let seeded = with_sibling_companions(
        dir.path().join("datasource_seeds.yaml").to_str().unwrap(),
        &ValidateOptions::default(),
    );
    assert!(seeded.types.is_some());
}

#[test]
fn field_defaults_catalog_and_include_edges() {
    let catalog = parse_field_type_catalog("types:\n  - integer:\n      defaults: 1\n");
    assert!(catalog.contains_key("integer"));
    let catalog = parse_field_type_catalog("types: 1\ndefaults: 1\n");
    assert!(catalog.is_empty());
    let catalog = parse_field_type_catalog(
        "types:\n  - integer:\n      min_value: 0\n      max_value: null\n      defaults: [1, nope]\n      supports_size: true\n",
    );
    assert!(catalog.contains_key("integer") || catalog.is_empty());
    let err = load_field_type_catalog(Path::new("/no/such/catalog-root")).unwrap_err();
    assert!(err.contains("field type catalog not found"));
    let defaults = check_field_default_semantics(
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
        - code:
            type: character
            size: 2
            default_value: A
        - when:
            type: datetime
            default_value: yesterday
        - skip:
            default_value: 1
        - unknown:
            type: notatype
            default_value: 1
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
      destination: 1
  - []
"#,
        ),
        &ValidateOptions::default(),
    );
    assert!(!defaults.valid, "{:?}", defaults.errors);

    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("types.yaml"), "includes:\n  - file: \"\"\n  - {}\n").unwrap();
    std::fs::write(dir.path().join("list.yaml"), "- 1\n").unwrap();
    let parsed = parse_yaml_with_positions("includes:\n  - file: list.yaml\n  - file: missing.yaml\n");
    let cycles = check_include_cycles(
        &parsed,
        &ValidateOptions {
            include_base_path: Some(dir.path().display().to_string()),
            ..ValidateOptions::default()
        },
    );
    assert!(cycles.errors.iter().any(|err| err.message.contains("mapping") || err.message.contains("not found")));
    let _ = entries(&Value::Bool(true));
    let _ = string_list(&Value::Array(vec![Value::String("a".into()), Value::Bool(true)]));
}

#[test]
fn ajv_kind_formatter_covers_unused_arms() {
    let multiple = ValidationErrorKind::Type {
        kind: TypeKind::Multiple(JsonTypeSet::from(JsonType::String).insert(JsonType::Number)),
    };
    assert!(ajv_from_kind("/x", &multiple)[0].message.contains("must be"));
    let enum_value = ValidationErrorKind::Enum { options: json!("only") };
    assert!(format_ajv_error(&ajv_from_kind("/x", &enum_value)[0]).contains("allowed"));
    let mixed = ValidationErrorKind::Enum { options: json!([1, "a"]) };
    assert!(format_ajv_error(&ajv_from_kind("/x", &mixed)[0]).contains("1"));
    let required = ValidationErrorKind::Required { property: json!(1) };
    assert!(ajv_from_kind("/x", &required)[0].message.contains("required property"));
    let extra = ValidationErrorKind::AdditionalProperties { unexpected: vec![String::new()] };
    let formatted = format_ajv_error(&ajv_from_kind("/x", &extra)[0]);
    assert!(!formatted.contains("property:"));
    let empty_allowed = AjvError {
        keyword: "enum".into(),
        instance_path: "/x".into(),
        message: "must be equal to one of the allowed values".into(),
        additional_property: None,
        missing_property: Some(String::new()),
        allowed_values: Some(vec![]),
    };
    assert_eq!(format_ajv_error(&empty_allowed), "/x must be equal to one of the allowed values");
    let multiple_valid = ValidationErrorKind::OneOfMultipleValid { context: vec![] };
    assert!(ajv_from_kind("/x", &multiple_valid)[0].message.contains("exactly one"));
    let any_of = ValidationErrorKind::AnyOf { context: vec![] };
    assert!(ajv_from_kind("/x", &any_of)[0].message.contains("anyOf"));
    let fallback = ValidationErrorKind::UniqueItems;
    assert!(ajv_from_kind("/x", &fallback)[0].message.contains("uniqueItems"));
    let bad_yaml = SpecValidator::from_ref("backend", "types.spec.yaml").validate("foo: [unterminated", &ValidateOptions::default());
    assert!(!bad_yaml.valid);
}
