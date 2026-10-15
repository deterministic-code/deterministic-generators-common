use std::collections::HashMap;

use deterministic_generators_common::{
    expand_types, memory_reader, type_has_tag, unique_lookup_fields, DeterministicParser, FieldSize,
    NestedRouteDescriptor, SeedValue, Type, TypeKind, YamlLiteral,
};

fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())).collect()
}

fn parse(pairs: &[(&str, &str)]) -> Result<deterministic_generators_common::Deterministic, deterministic_generators_common::Error> {
    DeterministicParser::new(memory_reader(map(pairs))).parse(&HashMap::new())
}

fn err(pairs: &[(&str, &str)]) -> String {
    match parse(pairs) {
        Err(error) => error.to_string(),
        Ok(_) => panic!("expected error"),
    }
}

fn shaped(name: &str, inherits: &str) -> Type {
    Type {
        name: name.into(),
        tags: vec!["datasource_type".into()],
        kind: TypeKind::Inherit,
        inherits: Some(inherits.into()),
        union: None,
        mapping: None,
        extract: None,
        remove_fields: None,
        ids: None,
        fields: Vec::new(),
    }
}

#[test]
fn empty_documents_seeds_and_identity_lookups() {
    let empty = parse(&[]).unwrap();
    assert!(empty.types.is_empty() && empty.datasource.is_empty() && empty.expanded_types.is_empty());

    let spec = parse(&[
        (
            "types.yaml",
            "types:\n  - user:\n      tags: [datasource_type]\n      fields:\n        - email:\n            type: string\n            size: unlimited\n            min_size: 1\n            is_nullable: true\n            default_value: \"\"\n",
        ),
        ("datasource.yaml", "types:\n  - user: {}\n"),
        ("datasource_seeds.yaml", "seeds:\n  - user:\n      - id1:\n          email: a@b.c\n"),
        ("services.yaml", "services: []\n"),
        ("routes.yaml", "routes: []\n"),
    ])
    .unwrap();
    assert_eq!(spec.datasource_seeds["user"][0].id, 1);
    assert!(spec.services.generics.is_empty());
    assert!(spec.routes.candidates.is_empty());
    assert_eq!(spec.types[0].fields[0].size, Some(FieldSize::Unlimited));
    assert!(spec.types[0].fields[0].has_default);
    assert_eq!(spec.types[0].fields[0].default_value, Some(YamlLiteral::String(String::new())));

    let message = err(&[("datasource_seeds.yaml", "seeds:\n  - user:\n      - row1:\n          email: a\n")]);
    assert!(message.contains("Invalid seed row key"));
    assert!(message.contains("/^id\\d+$/"));

    let cycle = expand_types(&[shaped("a", "b"), shaped("b", "a")]);
    assert!(cycle.unwrap_err().to_string().contains("circular inherit"));

    let mut user = shaped("user", "set");
    user.fields = vec![deterministic_generators_common::TypeField {
        name: "code".into(),
        type_name: "string".into(),
        kind: deterministic_generators_common::FieldKind::Primitive,
        base: "string".into(),
        is_array: false,
        is_map: false,
        is_nullable: false,
        is_id: true,
        size: None,
        min_size: None,
        references: None,
        has_default: false,
        default_value: None,
    }];
    assert!(type_has_tag(&user, "datasource_type"));
    let table = deterministic_generators_common::DatasourceTable {
        name: "user".into(),
        mapping: None,
        fields: vec![deterministic_generators_common::DatasourceFieldOverlay {
            name: "code".into(),
            is_readonly: None,
            is_unique: None,
            mapping: None,
            is_fixed_id: Some(true),
            is_optimistic_concurrency: None,
            use_native_row_version: None,
        }],
        indexes: Vec::new(),
        unique_index_fields: Vec::new(),
        use_optimistic_concurrency: None,
    };
    assert_eq!(
        unique_lookup_fields(&user, Some(&table)).into_iter().map(|item| item.field).collect::<Vec<_>>(),
        vec!["code".to_string()]
    );
}

const USER: &str = "types:\n  - user:\n      tags: [view_type]\n      fields:\n        - email:\n            type: string\n";

#[test]
fn shorthand_and_combined_route_errors() {
    assert!(err(&[("types.yaml", USER), ("routes.yaml", "routes:\n  - \"\"\n")]).contains("expected non-empty string token"));
    assert!(err(&[("types.yaml", USER), ("routes.yaml", "routes:\n  - get_users\n")]).contains("missing `_by_`"));
    assert!(err(&[("types.yaml", USER), ("routes.yaml", "routes:\n  - get_users_by_\n")]).contains("empty entity or field"));
    assert!(err(&[("types.yaml", USER), ("routes.yaml", "routes:\n  - get_roles_by_name\n")]).contains("unknown entity"));
    assert!(err(&[("types.yaml", USER), ("routes.yaml", "routes:\n  - get_users_by_missing\n")]).contains("field `missing` not found"));
    assert!(err(&[(
        "types.yaml",
        USER,
    ), (
        "routes.yaml",
        "routes:\n  - named:\n      entity: 1\n      byField: email\n",
    )])
    .contains("non-string entity"));

    let types = "types:\n  - user:\n      tags: [view_type]\n      inherits: set\n      fields: []\n  - role:\n      tags: [view_type]\n      inherits: set\n      fields: []\n  - link:\n      tags: [many_to_many]\n      fields:\n        - left_id:\n            references: user.id\n            type: integer\n        - right_id:\n            references: role.id\n            type: integer\n";
    let implicit = parse(&[
        ("types.yaml", types),
        ("routes.yaml", "combined_routes:\n  - user:\n      combines:\n        - role\nroutes: []\n"),
    ])
    .unwrap();
    assert!(matches!(implicit.routes.nested[0], NestedRouteDescriptor::M2m(_)));
    let ambiguous = format!("{types}\n  - link2:\n      tags: [many_to_many]\n      fields:\n        - left_id:\n            references: user.id\n            type: integer\n        - right_id:\n            references: role.id\n            type: integer\n");
    let message = err(&[
        ("types.yaml", &ambiguous),
        ("routes.yaml", "combined_routes:\n  - user:\n      combines:\n        - role\nroutes: []\n"),
    ]);
    assert!(message.contains("ambiguous junction"));
    assert!(message.contains('—'));

    assert!(err(&[(
        "types.yaml",
        "types:\n  - user:\n      tags: [view_type]\n      fields: []\n",
    ), (
        "routes.yaml",
        "combined_routes:\n  - user:\n      combines:\n        - role:\n            via: link\nroutes: []\n",
    )])
    .contains("must declare both via: and target:"));
    assert!(err(&[(
        "types.yaml",
        "types:\n  - user:\n      tags: [view_type]\n      fields: []\n",
    ), (
        "routes.yaml",
        "combined_routes:\n  - user:\n      combines:\n        - role:\n            via: missing\n            target: role\nroutes: []\n",
    )])
    .contains("junction \"missing\" not found"));
    assert!(err(&[(
        "types.yaml",
        "types:\n  - user:\n      tags: [view_type]\n      fields: []\n  - link:\n      tags: [many_to_many]\n      fields:\n        - left_id:\n            references: user.id\n            type: integer\n",
    ), (
        "routes.yaml",
        "combined_routes:\n  - user:\n      combines:\n        - role:\n            via: link\n            target: role\nroutes: []\n",
    )])
    .contains("missing FK"));
    assert!(err(&[(
        "types.yaml",
        "types:\n  - user:\n      tags: [view_type]\n      fields: []\n",
    ), (
        "routes.yaml",
        "combined_routes:\n  - user:\n      combines:\n        - ghost\nroutes: []\n",
    )])
    .contains("child \"ghost\" not found"));
    assert!(err(&[(
        "types.yaml",
        "types:\n  - user:\n      tags: [view_type]\n      fields: []\n  - note:\n      tags: [view_type]\n      fields: []\n",
    ), (
        "routes.yaml",
        "combined_routes:\n  - user:\n      combines:\n        - note\nroutes: []\n",
    )])
    .contains("no FK to parent"));
}

#[test]
fn by_field_merge_generated_modules_and_scalar_seeds() {
    let spec = parse(&[
        (
            "types.yaml",
            "types:\n  - user:\n      tags: [view_type]\n      inherits: set\n      fields:\n        - email:\n            type: string\n  - person:\n      tags: [view_type]\n      inherits: user\n      fields:\n        - user_id:\n            references: user.id\n            type: integer\n",
        ),
        (
            "routes.yaml",
            "includes:\n  - types:\n      filter: tag == \"view_type\"\ncombined_routes:\n  - user:\n      combines:\n        - person:\n            route: /people\nroutes:\n  - get_users_by_email:\n  - get_users_by_email\n",
        ),
    ])
    .unwrap();
    assert!(spec.routes.candidates.iter().any(|item| item.name == "user"));
    assert!(spec.routes.children_only.contains("person"));
    assert!(!spec.routes.children_only.contains("user"));

    let spec = parse(&[
        (
            "types.yaml",
            "types:\n  - user:\n      tags: [datasource_type]\n      mapping: {}\n      fields: []\n",
        ),
        (
            "services.yaml",
            "includes:\n  - types:\n      filter: tag == \"datasource_type\"\nservices:\n  - name: UserService\n    module: ./services/generated/user\n  - name: CustomService\n    module: ./services/custom\n",
        ),
        (
            "routes.yaml",
            "routes:\n  - custom_get:\n      path: /api/x\n      method: GET\n      service: CustomService\n      function: run\n",
        ),
    ])
    .unwrap();
    assert!(spec.types[0].mapping.is_none());
    assert!(spec.services.customs.iter().any(|item| item.name == "CustomService"));
    assert!(!spec.services.customs.iter().any(|item| item.name == "UserService"));

    let spec = parse(&[
        (
            "types.yaml",
            "types:\n  - user:\n      tags: [datasource_type]\n      fields: []\n",
        ),
        (
            "services.yaml",
            "includes:\n  - types:\n      filter: tag == \"datasource_type\"\nservices:\n  - name: Only\n    module: ./only\n",
        ),
    ])
    .unwrap();
    assert!(spec.services.customs.iter().find(|item| item.name == "Only").unwrap().methods.is_empty());
    let verbs = parse(&[
        ("types.yaml", "types:\n  - user:\n      tags: [view_type]\n      inherits: set\n      fields:\n        - email:\n            type: string\n"),
        ("routes.yaml", "includes:\n  - types:\n      filter: tag == \"view_type\"\nroutes:\n  - put_users_by_email\n  - delete_users_by_email\n  - named:\n      entity: user\n      byField: email\n      methods: [PATCH, nope]\n"),
    ]).unwrap();
    assert!(
        verbs.routes.candidates.iter().any(|item| item.by_fields.iter().any(|field| field.by_field == "email")),
        "candidates: {:?}",
        verbs.routes.candidates.iter().map(|item| item.name.clone()).collect::<Vec<_>>()
    );

    let spec = parse(&[(
        "datasource_seeds.yaml",
        "seeds:\n  - user:\n      - id1: hello\n      - id2:\n          email: a\n          flag: true\n          n: 2\n          empty: null\n",
    )])
    .unwrap();
    assert!(spec.datasource_seeds["user"][0].row.is_empty());
    assert_eq!(spec.datasource_seeds["user"][1].row["email"], SeedValue::String("a".into()));
    assert_eq!(spec.datasource_seeds["user"][1].row["flag"], SeedValue::Bool(true));
    assert_eq!(spec.datasource_seeds["user"][1].row["n"], SeedValue::Number(2.0));
    assert_eq!(spec.datasource_seeds["user"][1].row["empty"], SeedValue::Null);
}
