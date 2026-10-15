use std::collections::HashMap;

use deterministic_generators_common::*;

fn parse(types: &str) -> Result<Deterministic, Error> {
    let mut files = HashMap::new();
    files.insert(TYPES_YAML.to_string(), types.to_string());
    DeterministicParser::new(memory_reader(files)).parse(&HashMap::new())
}

#[test]
fn composition_collides_extracts_maps_and_flattens_dictionaries() {
    let err = parse(
        r#"types:
  - base:
      fields:
        - email:
            type: string
  - child:
      inherits: base
      fields:
        - email:
            type: string
"#,
    )
    .unwrap_err()
    .to_string();
    assert!(err.contains("collide on the composed shape"), "{err}");

    let spec = parse(
        r#"types:
  - user:
      inherits: set
      fields:
        - email:
            type: string
            size: 12
  - dict:
      inherits: dictionary
      fields:
        - key:
            type: string
        - value:
            type: string
        - owner_id:
            type: integer
            references: user.id
  - view:
      inherits: dict
      extract: [dict.key, dict.missing]
      remove_fields: [dict.value]
      mapping:
        key: setting_key
      fields:
        - note:
            type: string
  - left:
      fields:
        - a:
            type: string
  - right:
      fields:
        - b:
            type: string
  - both:
      union: [left, right, missing]
      fields: []
"#,
    )
    .unwrap();
    let view = spec.expanded_types.iter().find(|type_def| type_def.name == "view").unwrap();
    assert!(view.fields.iter().any(|field| field.name == "setting_key"));
    assert!(!view.fields.iter().any(|field| field.name == "owner_id"));
    assert!(!view.fields.iter().any(|field| field.name == "value"));
    let both = spec.expanded_types.iter().find(|type_def| type_def.name == "both").unwrap();
    assert!(both.fields.iter().any(|field| field.name == "a"));
    assert!(both.fields.iter().any(|field| field.name == "b"));
    let user = spec.expanded_types.iter().find(|type_def| type_def.name == "user").unwrap();
    assert!(matches!(user.fields.iter().find(|field| field.name == "email").unwrap().size, Some(FieldSize::Num(12.0))));
}

#[test]
fn unique_indexes_and_non_string_references_are_kept() {
    let mut files = HashMap::new();
    files.insert(
        TYPES_YAML.to_string(),
        r#"types:
  - user:
      fields:
        - code:
            type: string
            size: 8
        - pair:
            references: [1, user.id]
"#
        .to_string(),
    );
    files.insert(
        DATASOURCE_YAML.to_string(),
        r#"types:
  - user:
      fields:
        - code:
            is_unique: true
      indexes:
        - code_uidx:
            fields: [code]
            is_unique: true
"#
        .to_string(),
    );
    let spec = DeterministicParser::new(memory_reader(files))
        .parse(&HashMap::new())
        .unwrap();
    let user = spec.expanded_types.iter().find(|type_def| type_def.name == "user").unwrap();
    let table = spec.datasource.iter().find(|table| table.name == "user");
    let lookups = unique_lookup_fields(user, table);
    assert!(lookups.iter().any(|field| field.field == "code"));
    assert!(user.fields.iter().find(|field| field.name == "pair").unwrap().references.is_none());
}

#[test]
fn authored_ids_skip_the_injected_set_id() {
    let spec = parse(
        r#"types:
  - person:
      inherits: set
      ids: [code]
      fields:
        - code:
            type: string
            is_id: true
"#,
    )
    .unwrap();
    let person = &spec.expanded_types[0];
    assert!(person.fields.iter().all(|field| field.name != "id"));
    assert_eq!(primary_key_column(None, Some(person)), "code");
    assert_eq!(primary_key_column(None, None), "id");
    let _: Option<SeedValue> = YamlLiteral::String("a".into()).into();
    let _: Option<SeedValue> = YamlLiteral::Number(1.0).into();
    let _: Option<SeedValue> = YamlLiteral::Bool(true).into();
    let _: Option<SeedValue> = YamlLiteral::Null.into();
}
