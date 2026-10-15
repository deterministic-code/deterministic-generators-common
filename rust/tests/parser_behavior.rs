use std::collections::HashMap;

use deterministic_generators_common::{
    compile_filter, compile_types_filter, ensure_health, file_reader, from_settings, inherits_chain,
    memory_reader, type_has_tag, CustomRouteEntry, CustomServiceEntry, Deterministic,
    DeterministicParser, DeterministicReader, Error, FieldKind, FilterCandidate, NestedRouteDescriptor,
    ParsedRoutes, ParsedServices, References, Type, TypeKind, YamlLiteral, YamlNode, HEALTH_ROUTE_NAME,
    HEALTH_ROUTE_PATH, HEALTH_SERVICE_METHOD, HEALTH_SERVICE_NAME,
};
use indexmap::IndexMap;

const CONTACTS_TYPES: &str = include_str!(
    "../../typescript/validator/test/fixtures/contacts.types.yaml"
);

fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
        .collect()
}

fn parse(pairs: &[(&str, &str)]) -> Deterministic {
    DeterministicParser::new(memory_reader(map(pairs)))
        .parse(&HashMap::new())
        .unwrap_or_else(|err| panic!("{err}"))
}

fn field_names(det: &Deterministic, name: &str) -> Vec<String> {
    det.expanded_types
        .iter()
        .find(|ty| ty.name == name)
        .unwrap_or_else(|| panic!("missing {name}"))
        .fields
        .iter()
        .map(|field| field.name.clone())
        .collect()
}

fn cand(name: &str, tags: &[&str], inherits: Option<&str>) -> FilterCandidate {
    FilterCandidate {
        name: name.to_string(),
        tags: tags.iter().map(|tag| (*tag).to_string()).collect(),
        inherits: inherits.map(str::to_string),
    }
}

fn empty_det() -> Deterministic {
    Deterministic::new(
        Vec::new(),
        Vec::new(),
        Vec::new(),
        IndexMap::new(),
        ParsedServices {
            generics: Vec::new(),
            customs: Vec::new(),
        },
        ParsedRoutes {
            candidates: Vec::new(),
            customs: Vec::new(),
            nested: Vec::new(),
            children_only: Default::default(),
            datasource: Vec::new(),
        },
    )
}

fn bare_type(name: &str, inherits: &str) -> Type {
    Type {
        name: name.to_string(),
        tags: vec!["view_type".to_string()],
        kind: TypeKind::Inherit,
        inherits: Some(inherits.to_string()),
        union: None,
        mapping: None,
        extract: None,
        remove_fields: None,
        ids: None,
        fields: Vec::new(),
    }
}

#[test]
fn memory_reader_missing_file() {
    let reader = memory_reader(map(&[("present.yaml", "ok")]));
    assert!(reader.exists("present.yaml"));
    assert!(!reader.exists("missing.yaml"));
    assert_eq!(reader.read("present.yaml").unwrap(), "ok");
    let err = reader.read("missing.yaml").unwrap_err();
    assert_eq!(err.to_string(), "deterministic reader: missing missing.yaml");
}

#[test]
fn file_reader_reads_and_probes() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("present.yaml"), "ok\n").unwrap();
    let reader = file_reader(dir.path());
    assert!(reader.exists("present.yaml"));
    assert!(!reader.exists("missing.yaml"));
    assert_eq!(reader.read("present.yaml").unwrap(), "ok\n");
    let err = reader.read("missing.yaml").unwrap_err().to_string();
    let expected = format!(
        "deterministic reader: missing missing.yaml in {}",
        dir.path().display()
    );
    assert_eq!(err, expected);
}

#[test]
fn from_settings_defaults_and_overrides() {
    let empty = from_settings(&HashMap::new()).unwrap();
    assert_eq!(empty.application_name, "generated-frontend");
    assert_eq!(empty.schema_version, "1.0");
    assert!(empty.create_index);
    assert_eq!(empty.library_reference_mode, None);
    assert_eq!(empty.frontend_framework, "vite");
    assert!(!empty.full_stack);
    assert!(empty.simple_doc);
    assert!(!empty.description_doc);

    assert_eq!(
        from_settings(&map(&[("application_name", "catalog-ui")]))
            .unwrap()
            .application_name,
        "catalog-ui"
    );
    assert_eq!(
        from_settings(&map(&[("application_name", "")]))
            .unwrap()
            .application_name,
        "generated-frontend"
    );
    assert_eq!(
        from_settings(&map(&[("frontend_generate_framework", "")]))
            .unwrap()
            .frontend_framework,
        "vite"
    );
    assert_eq!(
        from_settings(&map(&[("frontend_generate_framework", "next")]))
            .unwrap()
            .frontend_framework,
        "next"
    );
    assert!(
        from_settings(&map(&[("application_tier", "full-stack")]))
            .unwrap()
            .full_stack
    );
    let err = from_settings(&map(&[("frontend_generate_framework", "remix")])).unwrap_err();
    assert!(err
        .to_string()
        .contains("settings.frontend_generate_framework must be \"vite\", \"next\", \"svelte\", \"angular\""));

    let settings = from_settings(&map(&[
        ("codegen.schema_version", "9.9"),
        ("languages.typescript.library_reference_mode", "bundled"),
    ]))
    .unwrap();
    assert_eq!(settings.schema_version, "9.9");
    assert_eq!(settings.library_reference_mode.as_deref(), Some("bundled"));
    assert!(from_settings(&map(&[("codegen.create_index", "true")])).unwrap().create_index);
    assert!(!from_settings(&map(&[("codegen.create_index", "false")])).unwrap().create_index);
    assert!(from_settings(&map(&[("comments", "simple")])).unwrap().simple_doc);
    assert!(!from_settings(&map(&[("comments", "simple")])).unwrap().description_doc);
    let description = from_settings(&map(&[("comments", "description")])).unwrap();
    assert!(!description.simple_doc);
    assert!(description.description_doc);
    let none = from_settings(&map(&[("comments", "none")])).unwrap();
    assert!(!none.simple_doc);
    assert!(!none.description_doc);
}

#[test]
fn yaml_node_literals_and_named_lists() {
    let node = YamlNode::from_yaml(
        "
a: hello
b: 3
c: true
d: false
e: null
f: 1.5
g: .inf
",
    )
    .unwrap();
    assert_eq!(node.str("a").as_deref(), Some("hello"));
    assert_eq!(node.literal("a"), Some(YamlLiteral::String("hello".into())));
    assert_eq!(node.finite_int("b"), Some(3));
    assert_eq!(node.finite_number("b"), Some(3.0));
    assert_eq!(node.literal("b"), Some(YamlLiteral::Number(3.0)));
    assert!(node.bool("c"));
    assert!(!node.bool("d"));
    assert_eq!(node.literal("c"), Some(YamlLiteral::Bool(true)));
    assert_eq!(node.literal("d"), Some(YamlLiteral::Bool(false)));
    assert_eq!(node.literal("e"), Some(YamlLiteral::Null));
    assert_eq!(node.finite_number("f"), Some(1.5));
    assert_eq!(node.finite_int("f"), None);
    assert_eq!(node.finite_number("g"), None);
    assert_eq!(node.str("b"), None);
    assert!(node.has("a"));
    assert!(!node.has("missing"));
    assert!(node.bool("missing") == false);
    assert_eq!(node.str("missing"), None);

    let lists = YamlNode::from_yaml(
        "
tags:
  - alpha
  - 1
  - beta
items:
  - {}
  - []
  - named:
      ok: true
",
    )
    .unwrap();
    assert_eq!(lists.strings("tags"), vec!["alpha".to_string(), "beta".to_string()]);
    assert!(lists.strings("missing").is_empty());
    assert_eq!(
        lists.named_list("items").into_iter().map(|item| item.name).collect::<Vec<_>>(),
        vec!["named".to_string()]
    );
    assert!(lists.items().is_empty());
}

#[test]
fn compile_filter_matches_type_tag_inherits_and_logic() {
    let by_name = compile_types_filter(Some(r#"type == "user""#)).unwrap();
    let by_tag = compile_types_filter(Some(r#"tag == "view_type""#)).unwrap();
    let by_inherits = compile_types_filter(Some(r#"inherits == "set""#)).unwrap();
    let not_tag = compile_types_filter(Some(r#"tag != "datasource_type""#)).unwrap();
    assert!(by_name(&cand("user", &["datasource_type"], None)));
    assert!(!by_name(&cand("role", &["datasource_type"], None)));
    assert!(by_tag(&cand("person", &["view_type"], None)));
    assert!(!by_tag(&cand("user", &["datasource_type"], None)));
    assert!(by_inherits(&cand("user", &["datasource_type"], Some("set"))));
    assert!(!compile_types_filter(Some(r#"inherits != "set""#)).unwrap()(&cand("user", &[], Some("set"))));
    assert!(not_tag(&cand("person", &["view_type"], None)));
    assert!(!not_tag(&cand("user", &["datasource_type"], None)));

    let pred = compile_types_filter(Some(r#"tag == "datasource_type" && type != "legacy""#)).unwrap();
    assert!(pred(&cand("user", &["datasource_type"], None)));
    assert!(!pred(&cand("legacy", &["datasource_type"], None)));
    assert!(compile_types_filter(None).unwrap()(&cand("user", &[], None)));
    assert!(compile_types_filter(Some("")).unwrap()(&cand("user", &[], None)));
    assert!(compile_types_filter(Some("1==1")).unwrap()(&cand("user", &[], None)));

    match compile_types_filter(Some("type is datasource_type")) {
        Err(err) => {
            assert!(err.to_string().contains("unknown identifier"));
            assert!(err.to_string().contains("types.filter"));
        }
        Ok(_) => panic!("expected unknown identifier"),
    }
    match compile_types_filter(Some(r#"type == "user" &&"#)) {
        Err(err) => {
            assert!(err.to_string().contains("not a valid expression"));
            assert!(err.to_string().contains("Unexpected token ')'"));
        }
        Ok(_) => panic!("expected syntax error"),
    }

    let or_pred = compile_filter(
        Some(r#"tag == "view_type" || inherits == "set""#),
        "types.filter",
    )
    .unwrap();
    assert!(or_pred(&cand("person", &["view_type"], None)));
    assert!(or_pred(&cand("user", &[], Some("set"))));
    assert!(!or_pred(&cand("other", &["datasource_type"], Some("role"))));

    let bang = compile_filter(Some(r#"!(type == "user")"#), "ctx").unwrap();
    assert!(!bang(&cand("user", &[], None)));
    assert!(bang(&cand("role", &[], None)));

    let strict = compile_filter(Some(r#"1 === 1 && 1 !== 2 && null == undefined && 1 == "1""#), "ctx").unwrap();
    assert!(strict(&cand("x", &[], None)));
    let loose_false = compile_filter(Some(r#"1 === "1" || 0 || """#), "ctx").unwrap();
    assert!(!loose_false(&cand("x", &[], None)));
    let includes = compile_filter(Some(r#"__tags.includes("view_type")"#), "ctx").unwrap();
    assert!(includes(&cand("person", &["view_type"], None)));
    assert!(!includes(&cand("user", &["datasource_type"], None)));
}

#[test]
fn ensure_health_seeds_moves_and_is_idempotent() {
    let seeded = ensure_health(empty_det());
    assert_eq!(seeded.services.customs[0].name, HEALTH_SERVICE_NAME);
    assert_eq!(seeded.services.customs[0].methods, vec![HEALTH_SERVICE_METHOD.to_string()]);
    assert_eq!(seeded.services.customs[0].module, None);
    assert_eq!(seeded.routes.customs[0].name, HEALTH_ROUTE_NAME);
    assert_eq!(seeded.routes.customs[0].path.as_deref(), Some(HEALTH_ROUTE_PATH));
    assert_eq!(seeded.routes.customs[0].method.as_deref(), Some("GET"));
    assert_eq!(seeded.routes.customs[0].entity, None);

    let mut authored = empty_det();
    authored.services.customs = vec![
        CustomServiceEntry {
            name: "ReportService".into(),
            module: None,
            methods: vec!["run".into()],
        },
        CustomServiceEntry {
            name: HEALTH_SERVICE_NAME.into(),
            module: Some("./services/custom/mine".into()),
            methods: vec!["probe".into()],
        },
    ];
    authored.routes.customs = vec![
        CustomRouteEntry {
            name: "getReport".into(),
            path: Some("/api/report".into()),
            method: Some("GET".into()),
            entity: None,
            request: None,
            response: None,
            module: None,
            route_class: None,
        },
        CustomRouteEntry {
            name: "ready".into(),
            path: Some(HEALTH_ROUTE_PATH.into()),
            method: Some("GET".into()),
            entity: None,
            request: None,
            response: None,
            module: None,
            route_class: None,
        },
    ];
    let moved = ensure_health(authored);
    assert_eq!(
        moved.services.customs.iter().map(|item| item.name.as_str()).collect::<Vec<_>>(),
        vec![HEALTH_SERVICE_NAME, "ReportService"]
    );
    assert_eq!(moved.services.customs[0].module.as_deref(), Some("./services/custom/mine"));
    assert_eq!(moved.services.customs[0].methods, vec!["probe".to_string()]);
    assert_eq!(moved.routes.customs[0].name, "ready");
    assert_eq!(moved.routes.customs[1].name, "getReport");

    let twice = ensure_health(seeded.clone());
    assert_eq!(twice.services.customs, seeded.services.customs);
    assert_eq!(twice.routes.customs, seeded.routes.customs);
}

#[test]
fn parse_types_inherit_union_mapping_extract_ids_and_contacts() {
    let det = parse(&[(
        "types.yaml",
        r#"types:
  - user:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - email:
            type: string
            size: 256
        - bio:
            type: string
  - role:
      tags: [datasource_type]
      inherits: set
      fields:
        - name:
            type: string
        - code:
            type: string
  - settings:
      tags: [datasource_type]
      inherits: dictionary
      fields:
        - user_id:
            references: user.id
            type: integer
        - key:
            type: string
        - value:
            type: string
  - person:
      tags: [view_type]
      inherits: user
      remove_fields: [bio]
      fields:
        - display_name:
            type: string
        - role:
            type: role
  - phone_contact:
      tags: [view_type]
      union: [user, role]
      mapping:
        name: role_name
      remove_fields: [id]
      fields:
        - phone:
            type: string
"#,
    )]);
    assert_eq!(field_names(&det, "user"), vec!["id", "email", "bio"]);
    assert_eq!(field_names(&det, "role"), vec!["id", "name", "code"]);
    assert_eq!(field_names(&det, "settings"), vec!["user_id", "key", "value"]);
    assert_eq!(field_names(&det, "person"), vec!["id", "email", "display_name", "role"]);
    let phone = det.expanded_types.iter().find(|ty| ty.name == "phone_contact").unwrap();
    assert!(phone.fields.iter().any(|field| field.name == "role_name"));
    assert!(!phone.fields.iter().any(|field| field.name == "id"));

    let extracted = parse(&[(
        "types.yaml",
        r#"types:
  - contacts_base:
      tags: [view_type]
      inherits: set
      fields:
        - email:
            type: string
  - contact_source:
      tags: [datasource_type]
      inherits: set
      fields:
        - name:
            type: string
  - contact_type:
      tags: [datasource_type]
      inherits: set
      fields:
        - name:
            type: string
  - contact:
      tags: [view_type]
      inherits: contacts_base
      union: [contact_source, contact_type]
      extract: [contact_source.name, contact_type.name]
      mapping:
        contact_source.name: contact_source_name
        contact_type.name: contact_type_name
"#,
    )]);
    let contact = extracted.types.iter().find(|ty| ty.name == "contact").unwrap();
    assert_eq!(
        contact.extract.as_ref().unwrap(),
        &vec!["contact_source.name".to_string(), "contact_type.name".to_string()]
    );
    let mapping = contact.mapping.as_ref().unwrap();
    assert_eq!(mapping.get("contact_source.name").map(String::as_str), Some("contact_source_name"));
    assert_eq!(mapping.get("contact_type.name").map(String::as_str), Some("contact_type_name"));
    assert_eq!(
        field_names(&extracted, "contact"),
        vec!["id", "email", "contact_source_name", "contact_type_name"]
    );

    let contacts = parse(&[("types.yaml", CONTACTS_TYPES)]);
    let contact = contacts.types.iter().find(|ty| ty.name == "contact").unwrap();
    assert_eq!(contact.kind, TypeKind::Inherit);
    assert_eq!(contact.inherits.as_deref(), Some("contacts_base"));
    assert_eq!(contact.union.as_ref().unwrap(), &vec!["contact_source".to_string()]);
    assert_eq!(contact.mapping.as_ref().unwrap().get("name").map(String::as_str), Some("contact_source_name"));
    assert_eq!(
        field_names(&contacts, "contact"),
        vec![
            "id",
            "uuid",
            "created",
            "updated",
            "version",
            "contact_source_id",
            "first_name",
            "last_name",
            "email",
            "notes",
            "contact_source_name",
            "description",
            "addresses",
            "phones",
            "settings",
            "prefs",
        ]
    );
    assert_eq!(
        field_names(&contacts, "address"),
        vec![
            "id",
            "uuid",
            "created",
            "updated",
            "version",
            "contact_id",
            "address_type_id",
            "line1",
            "line2",
            "city",
            "region",
            "postal_code",
            "country",
            "address_type_name",
            "description",
        ]
    );
    assert!(field_names(&contacts, "contact_group").iter().any(|name| name == "members"));

    let ids = parse(&[(
        "types.yaml",
        r#"types:
  - person:
      tags: [datasource_type]
      inherits: set
      fields:
        - code:
            type: integer
            is_id: true
        - email:
            type: string
  - link:
      tags: [datasource_type]
      inherits: set
      ids: [left_id, right_id]
      fields:
        - left_id:
            type: integer
        - right_id:
            type: integer
  - user:
      tags: [datasource_type]
      inherits: set
      fields:
        - email:
            type: string
"#,
    )]);
    let person = ids.expanded_types.iter().find(|ty| ty.name == "person").unwrap();
    assert_eq!(person.fields.iter().map(|field| field.name.as_str()).collect::<Vec<_>>(), vec!["code", "email"]);
    assert!(person.fields[0].is_id);
    let link = ids.expanded_types.iter().find(|ty| ty.name == "link").unwrap();
    assert_eq!(link.ids.as_ref().unwrap(), &vec!["left_id".to_string(), "right_id".to_string()]);
    assert_eq!(field_names(&ids, "user"), vec!["id", "email"]);

    let composite = parse(&[(
        "types.yaml",
        r#"types:
  - link:
      tags: [datasource_type, many_to_many]
      fields:
        - left_id:
            type: integer
            references: user.id
        - right_id:
            type: integer
            references: role.id
        - pair:
            references: [link.left_id, link.right_id]
"#,
    )]);
    let pair = composite.types[0].fields.iter().find(|field| field.name == "pair").unwrap();
    assert_eq!(
        pair.references,
        Some(References::Pair("link.left_id".into(), "link.right_id".into()))
    );
    assert_eq!(pair.kind, FieldKind::Primitive);
    assert!(type_has_tag(&composite.types[0], "many_to_many"));
}

#[test]
fn parse_datasource_overlays_and_filter() {
    let det = parse(&[
        (
            "types.yaml",
            r#"types:
  - user:
      tags: [datasource_type]
      inherits: set
      fields:
        - email:
            type: string
  - note:
      tags: [datasource_type]
      fields:
        - body:
            type: string
"#,
        ),
        (
            "datasource.yaml",
            r#"includes:
  - types:
      filter: tag == "datasource_type"
types:
  - user:
      mapping: users
      use_optimistic_concurrency: true
      fields:
        - email:
            is_unique: true
            mapping: email_address
        - updated:
            is_optimistic_concurrency: true
        - version:
            is_optimistic_concurrency: false
            use_native_row_version: false
      indexes:
        - email_uidx:
            fields: [email]
            is_unique: true
  - note: {}
"#,
        ),
    ]);
    assert_eq!(det.datasource.len(), 2);
    let user = det.datasource.iter().find(|table| table.name == "user").unwrap();
    assert_eq!(user.mapping.as_deref(), Some("users"));
    assert_eq!(user.use_optimistic_concurrency, Some(true));
    assert_eq!(user.fields[0].is_unique, Some(true));
    assert_eq!(user.fields[0].mapping.as_deref(), Some("email_address"));
    assert_eq!(user.fields[1].is_optimistic_concurrency, Some(true));
    assert_eq!(user.fields[2].use_native_row_version, Some(false));
    assert_eq!(user.unique_index_fields, vec!["email".to_string()]);
    assert!(det.datasource.iter().any(|table| table.name == "note"));

    let filtered = parse(&[
        (
            "types.yaml",
            r#"types:
  - user:
      tags: [datasource_type]
      fields:
        - email:
            type: string
  - legacy:
      tags: [datasource_type]
      fields:
        - n:
            type: integer
  - person:
      tags: [view_type]
      fields: []
"#,
        ),
        (
            "datasource.yaml",
            r#"includes:
  - types:
      filter: tag == "datasource_type" && type != "legacy"
types: []
"#,
        ),
    ]);
    assert_eq!(
        filtered.datasource.iter().map(|table| table.name.as_str()).collect::<Vec<_>>(),
        vec!["user"]
    );
}

#[test]
fn parse_services_filters_and_custom_methods() {
    let spec = parse(&[
        (
            "types.yaml",
            r#"types:
  - user:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - email:
            type: string
  - health:
      tags: [view_type]
      fields:
        - ok:
            type: boolean
"#,
        ),
        (
            "datasource.yaml",
            r#"types:
  - user:
      fields:
        - email:
            is_unique: true
"#,
        ),
        (
            "services.yaml",
            r#"includes:
  - types:
      filter: tag == "datasource_type"
services:
  - name: HealthService
    description: Liveness
    module: ./services/health
"#,
        ),
        (
            "routes.yaml",
            r#"routes:
  - custom_get:
      path: /api/health
      method: GET
      service: HealthService
      function: check
"#,
        ),
    ]);
    assert_eq!(
        spec.services.generics.iter().map(|item| item.name.as_str()).collect::<Vec<_>>(),
        vec!["user"]
    );
    assert!(spec.services.generics[0].by_fields.iter().any(|field| field.field == "email"));
    let health = spec.services.customs.iter().find(|item| item.name == "HealthService").unwrap();
    assert_eq!(health.methods, vec!["check".to_string()]);
}

const ROUTE_TYPES: &str = r#"types:
  - user:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - email:
            type: string
        - reports:
            type: person[]
            references: person.user_id
  - person:
      tags: [view_type]
      inherits: user
      fields:
        - user_id:
            references: user.id
            type: integer
  - link:
      tags: [datasource_type, many_to_many]
      fields:
        - left_id:
            references: user.id
            type: integer
        - right_id:
            references: role.id
            type: integer
  - role:
      tags: [datasource_type]
      inherits: set
      fields: []
"#;

#[test]
fn parse_routes_nested_fk_m2m_and_inherit_chain() {
    let spec = parse(&[
        ("types.yaml", ROUTE_TYPES),
        (
            "datasource.yaml",
            r#"types:
  - user:
      fields:
        - email:
            is_unique: true
"#,
        ),
        (
            "routes.yaml",
            r#"includes:
  - types:
      filter: tag == "view_type"
combined_routes:
  - user:
      route: /api/users
      combines:
        - person:
            via: link
            target: role
            route: /api/users/:id/roles
routes:
  - user:
      eager_read_path:
        - reports
      eager_update_path:
        - reports
      eager_read_member_only:
        - reports
  - get_users_by_email
  - custom_post:
      path: /api/people
      method: POST
      service: PersonService
      function: create
"#,
        ),
    ]);
    let user = spec.routes.candidates.iter().find(|item| item.name == "user").unwrap();
    assert_eq!(user.eager_read_path.as_ref().unwrap(), &vec!["reports".to_string()]);
    assert!(user.by_fields.iter().any(|field| field.by_field == "email"));
    assert!(spec.routes.customs.iter().any(|item| item.path.as_deref() == Some("/api/people")));
    assert!(matches!(spec.routes.nested.first(), Some(NestedRouteDescriptor::M2m(_))));

    let direct = parse(&[
        ("types.yaml", ROUTE_TYPES),
        (
            "routes.yaml",
            r#"includes:
  - types:
      filter: tag == "view_type"
combined_routes:
  - user:
      route: /api/users
      combines:
        - person
routes: []
"#,
        ),
    ]);
    match &direct.routes.nested[0] {
        NestedRouteDescriptor::DirectFk(desc) => assert_eq!(desc.fk_column, "user_id"),
        other => panic!("expected direct fk, got {other:?}"),
    }
    assert!(direct.routes.children_only.contains("person"));

    let inherited = parse(&[
        (
            "types.yaml",
            r#"types:
  - contacts_base:
      tags: [datasource_type]
      inherits: set
      fields: []
  - addresses_base:
      tags: [datasource_type]
      inherits: set
      fields:
        - contact_id:
            type: integer
            references: contacts_base.id
  - contact:
      tags: [view_type]
      inherits: contacts_base
      fields: []
  - address:
      tags: [view_type]
      inherits: addresses_base
      fields: []
"#,
        ),
        (
            "routes.yaml",
            r#"combined_routes:
  - contact:
      route: /api/contacts
      combines:
        - address
routes: []
"#,
        ),
    ]);
    match &inherited.routes.nested[0] {
        NestedRouteDescriptor::DirectFk(desc) => assert_eq!(desc.fk_column, "contact_id"),
        other => panic!("expected direct fk, got {other:?}"),
    }
    assert!(inherited.routes.children_only.contains("address"));

    let removed = parse(&[
        (
            "types.yaml",
            r#"types:
  - contacts_base:
      tags: [datasource_type]
      inherits: set
      fields: []
  - addresses_base:
      tags: [datasource_type]
      inherits: set
      fields:
        - contact_id:
            type: integer
            references: contacts_base.id
        - line1:
            type: string
  - contact:
      tags: [view_type]
      inherits: contacts_base
      fields: []
  - address:
      tags: [view_type]
      inherits: addresses_base
      remove_fields: [contact_id]
      fields: []
"#,
        ),
        (
            "routes.yaml",
            r#"combined_routes:
  - contact:
      combines:
        - address
routes: []
"#,
        ),
    ]);
    match &removed.routes.nested[0] {
        NestedRouteDescriptor::DirectFk(desc) => assert_eq!(desc.fk_column, "contact_id"),
        other => panic!("expected direct fk, got {other:?}"),
    }

    let m2m = parse(&[
        (
            "types.yaml",
            r#"types:
  - contacts_base:
      tags: [datasource_type]
      inherits: set
      fields: []
  - contact_groups_base:
      tags: [datasource_type]
      inherits: set
      fields: []
  - contact:
      tags: [view_type]
      inherits: contacts_base
      fields: []
  - contact_group:
      tags: [view_type]
      inherits: contact_groups_base
      fields: []
  - contact_group_member:
      tags: [datasource_type, many_to_many]
      fields:
        - contact_id:
            type: integer
            references: contacts_base.id
        - contact_group_id:
            type: integer
            references: contact_groups_base.id
"#,
        ),
        (
            "routes.yaml",
            r#"combined_routes:
  - contact:
      combines:
        - contact_group
routes: []
"#,
        ),
    ]);
    match &m2m.routes.nested[0] {
        NestedRouteDescriptor::M2m(desc) => assert_eq!(desc.junction, "contact_group_member"),
        other => panic!("expected m2m, got {other:?}"),
    }

    let stops = parse(&[
        (
            "types.yaml",
            r#"types:
  - parent:
      tags: [view_type]
      inherits: set
      fields: []
  - via_dict:
      tags: [view_type]
      inherits: dictionary
      fields:
        - parent_id:
            type: integer
            references: parent.id
        - key:
            type: string
        - value:
            type: string
  - via_missing:
      tags: [view_type]
      inherits: ghost_base
      fields:
        - parent_id:
            type: integer
            references: parent.id
"#,
        ),
        (
            "routes.yaml",
            r#"combined_routes:
  - parent:
      combines:
        - via_dict
        - via_missing
routes: []
"#,
        ),
    ]);
    assert_eq!(stops.routes.nested.len(), 2);
    assert!(stops.routes.nested.iter().all(|item| matches!(item, NestedRouteDescriptor::DirectFk(_))));

    let mut type_by_name = IndexMap::new();
    type_by_name.insert("cyc_a".into(), bare_type("cyc_a", "cyc_b"));
    type_by_name.insert("cyc_b".into(), bare_type("cyc_b", "cyc_a"));
    assert_eq!(inherits_chain("cyc_a", &type_by_name), vec!["cyc_b".to_string()]);
}

#[test]
fn parser_returns_types_datasource_services_and_routes() {
    let spec = DeterministicParser::new(memory_reader(map(&[
        (
            "types.yaml",
            r#"types:
  - user:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - email:
            type: string
        - role_id:
            references: role.id
            type: integer
  - role:
      tags: [datasource_type]
      inherits: set
      fields:
        - code:
            type: string
"#,
        ),
        (
            "datasource.yaml",
            r#"includes:
  - types:
      filter: tag == "datasource_type"
types:
  - user:
      fields:
        - email:
            is_unique: true
  - role: {}
"#,
        ),
        (
            "services.yaml",
            r#"includes:
  - types:
      filter: tag == "datasource_type" || tag == "view_type"
services: []
"#,
        ),
        (
            "routes.yaml",
            r#"includes:
  - types:
      filter: tag == "view_type"
routes: []
"#,
        ),
    ])))
    .parse_with(&HashMap::new(), |entity| format!("{entity}_service"))
    .unwrap();
    let user = spec.expanded_types.iter().find(|ty| ty.name == "user").unwrap();
    assert_eq!(
        user.fields.iter().find(|field| field.name == "role_id").unwrap().type_name,
        "integer"
    );
    assert!(spec.types.iter().any(|ty| ty.name == "user"));
    assert!(spec.datasource.iter().any(|table| table.name == "user"));
    assert!(spec.services.generics.iter().any(|item| item.name == "user"));
    assert_eq!(spec.routes.customs[0].name, "getHealth");
    assert!(spec.routes.candidates.iter().any(|item| item.name == "user"));
}

#[test]
fn error_display_is_the_message() {
    let err = Error::new("plain");
    assert_eq!(err.to_string(), "plain");
    assert_eq!(format!("{err:?}"), "Error(\"plain\")");
}
