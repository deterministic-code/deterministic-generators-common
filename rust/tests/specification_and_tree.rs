use deterministic_generators_common::{
    compare_by_datasource_type_order, compare_by_datasource_type_order_with, datasource_type_ancestry,
    datasource_type_graph, datasource_type_graph_json, datasource_type_graph_xml, datasource_type_graph_yaml,
    datasource_type_hierarchies, datasource_type_order, datasource_type_tree, datasource_type_tree_all,
    datasource_type_tree_first, datasource_type_tree_json, datasource_type_tree_xml, datasource_type_tree_yaml,
    expand_types, parse_field_type, primary_key_column, unique_lookup_fields, DatasourceFieldOverlay,
    DatasourceTable, DatasourceTypeGraph, DatasourceTypeGraphEdge, DatasourceTypeTree, FieldKind, FieldSize,
    MultiParent, References, ServiceByField, Type, TypeField, TypeKind,
};
use indexmap::IndexMap;

fn fld(name: &str, ty: &str) -> TypeField {
    let parsed = parse_field_type(ty);
    TypeField {
        name: name.into(),
        type_name: ty.into(),
        kind: parsed.kind,
        base: parsed.base,
        is_array: parsed.is_array,
        is_map: parsed.is_map,
        is_nullable: false,
        is_id: false,
        size: None,
        min_size: None,
        references: None,
        has_default: false,
        default_value: None,
    }
}

fn id_field(name: &str, ty: &str) -> TypeField {
    let mut field = fld(name, ty);
    field.is_id = true;
    field
}

fn sized(name: &str, ty: &str, size: f64) -> TypeField {
    let mut field = fld(name, ty);
    field.size = Some(FieldSize::Num(size));
    field
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

fn inherit(mut ty: Type, parent: &str) -> Type {
    ty.kind = TypeKind::Inherit;
    ty.inherits = Some(parent.into());
    ty
}

fn names_of(types: &[Type], name: &str) -> Vec<String> {
    types
        .iter()
        .find(|ty| ty.name == name)
        .unwrap()
        .fields
        .iter()
        .map(|field| field.name.clone())
        .collect()
}

fn table(name: &str, uniques: &[&str], indexes: &[&str]) -> DatasourceTable {
    DatasourceTable {
        name: name.into(),
        mapping: None,
        fields: uniques
            .iter()
            .map(|item| DatasourceFieldOverlay {
                name: (*item).into(),
                is_readonly: None,
                is_unique: Some(true),
                mapping: None,
                is_fixed_id: None,
                include_in_create: None,
                include_in_update: None,
                is_optimistic_concurrency: None,
                use_native_row_version: None,
            })
            .collect(),
        indexes: Vec::new(),
        unique_index_fields: indexes.iter().map(|item| (*item).to_string()).collect(),
        use_optimistic_concurrency: None,
    }
}

fn lookup(field: &str, ty: &str, size: Option<f64>) -> ServiceByField {
    ServiceByField {
        field: field.into(),
        type_name: ty.into(),
        size,
    }
}

#[test]
fn parse_field_type_and_primary_key() {
    let string = parse_field_type("string");
    assert_eq!(string.kind, FieldKind::Primitive);
    assert_eq!(string.base, "string");
    assert!(!string.is_array && !string.is_map);
    let role = parse_field_type("role[]");
    assert_eq!(role.kind, FieldKind::Type);
    assert_eq!(role.base, "role");
    assert!(role.is_array && !role.is_map);
    let settings = parse_field_type("settings{}");
    assert_eq!(settings.base, "settings");
    assert!(settings.is_map && !settings.is_array);
    assert_eq!(parse_field_type("user_summary").kind, FieldKind::Type);

    assert_eq!(primary_key_column(None, None), "id");
    assert_eq!(primary_key_column(None, Some(&inherit(shaped("user", vec![]), "set"))), "id");
    assert_eq!(primary_key_column(None, Some(&shaped("note", vec![fld("body", "string")]))), "id");
    assert_eq!(
        primary_key_column(None, Some(&inherit(shaped("person", vec![id_field("code", "integer"), fld("email", "string")]), "set"))),
        "code"
    );
    let mut link = shaped("link", vec![fld("left_id", "integer"), fld("right_id", "integer")]);
    link.ids = Some(vec!["left_id".into(), "right_id".into()]);
    assert_eq!(primary_key_column(None, Some(&link)), "left_id");
}

#[test]
fn unique_lookups_skip_duplicates_and_default_missing_type() {
    let person = inherit(
        shaped("person", vec![id_field("code", "integer"), sized("email", "string", 256.0)]),
        "set",
    );
    let overlays = table("person", &["email"], &[]);
    assert_eq!(
        unique_lookup_fields(&person, Some(&overlays)),
        vec![lookup("code", "integer", None), lookup("email", "string", Some(256.0))]
    );
    let user = shaped("user", vec![sized("email", "string", 256.0), fld("code", "string")]);
    let user_table = table("user", &["email"], &["code"]);
    assert_eq!(
        unique_lookup_fields(&user, Some(&user_table)),
        vec![lookup("email", "string", Some(256.0)), lookup("code", "string", None)]
    );
    let partial = shaped("user", vec![sized("email", "string", 256.0)]);
    let partial_table = table("user", &["email", "missing"], &["email"]);
    assert_eq!(
        unique_lookup_fields(&partial, Some(&partial_table)),
        vec![lookup("email", "string", Some(256.0)), lookup("missing", "string", None)]
    );
}

#[test]
fn expand_types_unions_identity_extract_collisions_and_dictionaries() {
    let mut combo = shaped("combo", vec![]);
    combo.kind = TypeKind::Union;
    let empty_union = expand_types(&[combo]).unwrap();
    assert!(empty_union[0].fields.is_empty());
    let _ = empty_union;

    let mut ghost = shaped("combo", vec![fld("extra", "string")]);
    ghost.kind = TypeKind::Union;
    ghost.union = Some(vec!["ghost".into()]);
    assert_eq!(
        expand_types(&[ghost]).unwrap()[0].fields.iter().map(|field| field.name.as_str()).collect::<Vec<_>>(),
        vec!["extra"]
    );

    let user = inherit(shaped("user", vec![fld("email", "string"), fld("bio", "string")]), "set");
    let mut person = inherit(shaped("person", vec![fld("display_name", "string")]), "user");
    person.tags = vec!["view_type".into()];
    person.remove_fields = Some(vec!["bio".into()]);
    let expanded = expand_types(&[user, person]).unwrap();
    assert_eq!(names_of(&expanded, "user"), vec!["id", "email", "bio"]);
    assert_eq!(names_of(&expanded, "person"), vec!["id", "email", "display_name"]);

    let person = inherit(shaped("person", vec![id_field("code", "integer"), fld("email", "string")]), "set");
    let mut link = inherit(shaped("link", vec![fld("left_id", "integer"), fld("right_id", "integer")]), "set");
    link.ids = Some(vec!["left_id".into(), "right_id".into()]);
    let expanded = expand_types(&[person, link]).unwrap();
    assert_eq!(names_of(&expanded, "person"), vec!["code", "email"]);
    assert!(expanded[0].fields[0].is_id);
    assert_eq!(names_of(&expanded, "link"), vec!["left_id", "right_id"]);
    assert_eq!(expanded[1].ids.as_ref().unwrap(), &vec!["left_id".to_string(), "right_id".to_string()]);

    let person = inherit(shaped("person", vec![id_field("code", "integer")]), "set");
    let alias = inherit(shaped("alias", vec![]), "person");
    let orphan = inherit(shaped("orphan", vec![]), "ghost");
    let expanded = expand_types(&[person, alias, orphan]).unwrap();
    assert_eq!(expanded.iter().find(|ty| ty.name == "alias").unwrap().ids, None);
    assert_eq!(expanded.iter().find(|ty| ty.name == "orphan").unwrap().ids, None);

    let mut link = inherit(shaped("link", vec![fld("left_id", "integer"), fld("right_id", "integer")]), "set");
    link.ids = Some(vec!["left_id".into(), "right_id".into()]);
    let tagged = inherit(shaped("tagged_link", vec![fld("tag", "string")]), "link");
    let expanded = expand_types(&[link, tagged]).unwrap();
    let tagged = expanded.iter().find(|ty| ty.name == "tagged_link").unwrap();
    assert_eq!(tagged.ids.as_ref().unwrap(), &vec!["left_id".to_string(), "right_id".to_string()]);
    assert_eq!(
        tagged.fields.iter().map(|field| field.name.as_str()).collect::<Vec<_>>(),
        vec!["left_id", "right_id", "tag"]
    );

    let base = inherit(
        shaped("contacts_base", vec![id_field("id", "integer"), fld("uuid", "uuid"), fld("email", "string")]),
        "set",
    );
    let source = inherit(
        shaped("contact_source", vec![id_field("id", "integer"), fld("uuid", "uuid"), fld("name", "string")]),
        "set",
    );
    let mut contact = inherit(shaped("contact", vec![]), "contacts_base");
    contact.union = Some(vec!["contact_source".into()]);
    contact.mapping = Some(IndexMap::from([("name".into(), "contact_source_name".into())]));
    contact.remove_fields = Some(vec!["contact_source.id".into(), "contact_source.uuid".into()]);
    contact.tags = vec!["view_type".into()];
    let expanded = expand_types(&[base, source, contact]).unwrap();
    assert_eq!(names_of(&expanded, "contact"), vec!["id", "uuid", "email", "contact_source_name"]);

    let base = inherit(shaped("contacts_base", vec![fld("email", "string")]), "set");
    let source = inherit(shaped("contact_source", vec![fld("name", "string")]), "set");
    let kind = inherit(shaped("contact_type", vec![fld("name", "string")]), "set");
    let mut contact = inherit(shaped("contact", vec![]), "contacts_base");
    contact.union = Some(vec!["contact_source".into(), "contact_type".into()]);
    contact.extract = Some(vec!["contact_source.name".into(), "contact_type.name".into()]);
    let mut mapping = IndexMap::new();
    mapping.insert("contact_source.name".into(), "contact_source_name".into());
    mapping.insert("contact_type.name".into(), "contact_type_name".into());
    contact.mapping = Some(mapping);
    contact.tags = vec!["view_type".into()];
    let expanded = expand_types(&[base, source, kind, contact]).unwrap();
    assert_eq!(
        names_of(&expanded, "contact"),
        vec!["id", "email", "contact_source_name", "contact_type_name"]
    );

    let user = inherit(shaped("user", vec![fld("email", "string"), fld("bio", "string")]), "set");
    let mut person = inherit(shaped("person", vec![fld("display_name", "string")]), "user");
    person.extract = Some(vec!["name".into(), "user.email".into(), "user.id".into()]);
    let expanded = expand_types(&[user, person]).unwrap();
    assert_eq!(names_of(&expanded, "person"), vec!["id", "email", "display_name"]);

    let source = inherit(shaped("contact_source", vec![fld("name", "string")]), "set");
    let kind = inherit(shaped("contact_type", vec![fld("name", "string")]), "set");
    let mut contact = shaped("contact", vec![]);
    contact.kind = TypeKind::Union;
    contact.union = Some(vec!["contact_source".into(), "contact_type".into()]);
    contact.tags = vec!["view_type".into()];
    let err = expand_types(&[source, kind, contact]).unwrap_err();
    assert!(err.to_string().contains("contact_source.id and contact_type.id collide on the composed shape of contact"));

    let file = inherit(shaped("file", vec![fld("name", "string")]), "set");
    let mut settings_fk = fld("setting_id", "integer");
    settings_fk.references = Some(References::One("file.id".into()));
    let settings = inherit(shaped("settings", vec![settings_fk, fld("key", "string"), fld("value", "string")]), "dictionary");
    let mut view = inherit(shaped("file_view", vec![]), "file");
    view.union = Some(vec!["settings".into()]);
    view.tags = vec!["view_type".into()];
    let expanded = expand_types(&[file, settings, view]).unwrap();
    assert_eq!(names_of(&expanded, "settings"), vec!["setting_id", "key", "value"]);
    assert_eq!(names_of(&expanded, "file_view"), vec!["id", "name", "key", "value"]);
}

#[test]
fn dictionary_owner_fk_rules() {
    let keyed = shaped("keyed", vec![id_field("code", "integer")]);
    let alias = inherit(shaped("alias", vec![]), "keyed");
    let mut owner = fld("owner_id", "integer");
    owner.references = Some(References::One("alias.code".into()));
    let settings = inherit(shaped("settings", vec![owner, fld("key", "string"), fld("value", "string")]), "dictionary");
    let mut alias_view = inherit(shaped("alias_view", vec![]), "alias");
    alias_view.union = Some(vec!["settings".into()]);
    alias_view.tags = vec!["view_type".into()];
    let mut link = shaped("link", vec![fld("left_id", "integer"), fld("right_id", "integer")]);
    link.ids = Some(vec!["left_id".into(), "right_id".into()]);
    let mut pair = fld("pair", "integer");
    pair.references = Some(References::Pair("link.left_id".into(), "link.right_id".into()));
    let link_settings = inherit(
        shaped("link_settings", vec![pair, fld("key", "string"), fld("value", "string")]),
        "dictionary",
    );
    let mut link_view = inherit(shaped("link_view", vec![]), "link");
    link_view.union = Some(vec!["link_settings".into()]);
    link_view.tags = vec!["view_type".into()];
    let expanded = expand_types(&[keyed, alias, settings, alias_view, link, link_settings, link_view]).unwrap();
    assert_eq!(names_of(&expanded, "alias_view"), vec!["code", "key", "value"]);
    assert_eq!(names_of(&expanded, "link_view"), vec!["left_id", "right_id", "key", "value"]);

    let note = shaped("note", vec![fld("body", "string")]);
    let orphan = inherit(shaped("orphan", vec![]), "ghost");
    let mut fields = vec![
        fld("note_body", "string"),
        fld("bare", "string"),
        fld("self_id", "string"),
        fld("ghost_id", "string"),
        fld("orphan_id", "string"),
        fld("mixed", "string"),
        fld("key", "string"),
        fld("value", "string"),
    ];
    fields[0].references = Some(References::One("note.body".into()));
    fields[1].references = Some(References::One("id".into()));
    fields[2].references = Some(References::One("settings.key".into()));
    fields[3].references = Some(References::One("ghost.id".into()));
    fields[4].references = Some(References::One("orphan.id".into()));
    fields[5].references = Some(References::Pair("note.body".into(), "orphan.id".into()));
    let settings = inherit(shaped("settings", fields), "dictionary");
    let mut note_view = inherit(shaped("note_view", vec![]), "note");
    note_view.union = Some(vec!["settings".into()]);
    note_view.tags = vec!["view_type".into()];
    let expanded = expand_types(&[note, orphan, settings, note_view]).unwrap();
    assert_eq!(
        names_of(&expanded, "note_view"),
        vec!["body", "note_body", "bare", "self_id", "ghost_id", "orphan_id", "mixed", "key", "value"]
    );
}

fn ds(name: &str, refs: &[&str]) -> Type {
    let mut ty = shaped(name, Vec::new());
    ty.fields = refs
        .iter()
        .enumerate()
        .map(|(index, references)| {
            let mut field = fld(&format!("fk_{index}"), "integer");
            field.references = Some(References::One((*references).into()));
            field
        })
        .collect();
    ty
}

const FIRST_YAML: &str = "\
root:
  contact_source:
    contact:
      address: {}
      phone: {}
      contact_group_member: {}
  contact_group: {}
  legacy_contact: {}
  contact_change_log: {}
";

const ALL_YAML: &str = "\
root:
  contact_source:
    contact:
      address: {}
      phone: {}
      contact_group_member: {}
  contact_group:
    contact_group_member: {}
  legacy_contact: {}
  contact_change_log: {}
";

const FIRST_JSON: &str = r#"{
  "root": {
    "contact_source": {
      "contact": {
        "address": {},
        "phone": {},
        "contact_group_member": {}
      }
    },
    "contact_group": {},
    "legacy_contact": {},
    "contact_change_log": {}
  }
}
"#;

const FIRST_XML: &str = "\
<root>
  <contact_source>
    <contact>
      <address/>
      <phone/>
      <contact_group_member/>
    </contact>
  </contact_source>
  <contact_group/>
  <legacy_contact/>
  <contact_change_log/>
</root>
";

const CONTACTS_GRAPH_YAML: &str = "\
nodes:
  - root
  - contact_source
  - contact
  - address
  - phone
  - contact_group
  - contact_group_member
  - legacy_contact
  - contact_change_log
edges:
  - from: contact_source
    to: root
  - from: contact
    to: contact_source
  - from: address
    to: contact
  - from: phone
    to: contact
  - from: contact_group
    to: root
  - from: contact_group_member
    to: contact
  - from: contact_group_member
    to: contact_group
  - from: legacy_contact
    to: root
  - from: contact_change_log
    to: root
";

const CONTACTS_GRAPH_JSON: &str = r#"{
  "nodes": [
    "root",
    "contact_source",
    "contact",
    "address",
    "phone",
    "contact_group",
    "contact_group_member",
    "legacy_contact",
    "contact_change_log"
  ],
  "edges": [
    {
      "from": "contact_source",
      "to": "root"
    },
    {
      "from": "contact",
      "to": "contact_source"
    },
    {
      "from": "address",
      "to": "contact"
    },
    {
      "from": "phone",
      "to": "contact"
    },
    {
      "from": "contact_group",
      "to": "root"
    },
    {
      "from": "contact_group_member",
      "to": "contact"
    },
    {
      "from": "contact_group_member",
      "to": "contact_group"
    },
    {
      "from": "legacy_contact",
      "to": "root"
    },
    {
      "from": "contact_change_log",
      "to": "root"
    }
  ]
}
"#;

const CONTACTS_GRAPH_XML: &str = "\
<graph>
  <nodes>
    <node>root</node>
    <node>contact_source</node>
    <node>contact</node>
    <node>address</node>
    <node>phone</node>
    <node>contact_group</node>
    <node>contact_group_member</node>
    <node>legacy_contact</node>
    <node>contact_change_log</node>
  </nodes>
  <edges>
    <edge from=\"contact_source\" to=\"root\"/>
    <edge from=\"contact\" to=\"contact_source\"/>
    <edge from=\"address\" to=\"contact\"/>
    <edge from=\"phone\" to=\"contact\"/>
    <edge from=\"contact_group\" to=\"root\"/>
    <edge from=\"contact_group_member\" to=\"contact\"/>
    <edge from=\"contact_group_member\" to=\"contact_group\"/>
    <edge from=\"legacy_contact\" to=\"root\"/>
    <edge from=\"contact_change_log\" to=\"root\"/>
  </edges>
</graph>
";

fn contacts() -> Vec<Type> {
    vec![
        ds("contact_source", &[]),
        ds("contact", &["contact_source.id"]),
        ds("address", &["contact.id"]),
        ds("phone", &["contact.id"]),
        ds("contact_group", &[]),
        ds("contact_group_member", &["contact.id", "contact_group.id"]),
        ds("legacy_contact", &[]),
        ds("contact_change_log", &[]),
    ]
}

#[test]
fn datasource_type_tree_matches_typescript_fixtures() {
    let contacts = contacts();
    let first = datasource_type_tree(&contacts, MultiParent::First);
    assert_eq!(datasource_type_tree_yaml(&first), FIRST_YAML);
    assert_eq!(datasource_type_tree_json(&first), FIRST_JSON);
    assert_eq!(datasource_type_tree_xml(&first), FIRST_XML);
    assert_eq!(datasource_type_tree_yaml(&datasource_type_tree(&contacts, MultiParent::All)), ALL_YAML);
    assert_eq!(datasource_type_tree_first(&contacts), first);
    assert_eq!(
        datasource_type_tree_yaml(&datasource_type_tree_all(&contacts)),
        ALL_YAML
    );
    assert_eq!(datasource_type_tree_yaml(&datasource_type_tree(&[ds("node", &["node.id"])], MultiParent::First)), "root:\n  node: {}\n");
    assert_eq!(
        datasource_type_tree_yaml(&datasource_type_tree(&[ds("a", &["b.id"]), ds("b", &["a.id"])], MultiParent::First)),
        "root:\n  a: {}\n  b: {}\n"
    );
    let nested = datasource_type_tree(&[ds("a", &["b.id"]), ds("b", &["a.id"]), ds("c", &["a.id"])], MultiParent::First);
    assert_eq!(datasource_type_tree_yaml(&nested), "root:\n  a:\n    c: {}\n  b: {}\n");
    let mut link = ds("link", &[]);
    let mut pair = fld("pair", "integer");
    pair.references = Some(References::Pair("".into(), "role.id".into()));
    link.fields = vec![pair];
    let composite = datasource_type_tree(&[ds("user", &[]), ds("role", &[]), link], MultiParent::First);
    let composite_yaml = datasource_type_tree_yaml(&composite);
    assert!(composite_yaml.contains("role:\n    link: {}"), "{composite_yaml}");
    assert!(composite_yaml.contains("user: {}"), "{composite_yaml}");
    assert_eq!(
        datasource_type_tree_yaml(&datasource_type_tree(&[ds("child", &["missing.id"])], MultiParent::First)),
        "root:\n  child: {}\n"
    );
}

#[test]
fn datasource_hierarchies_order_ancestry_and_compare() {
    let contacts = contacts();
    let hierarchies = datasource_type_hierarchies(&contacts);
    assert_eq!(datasource_type_tree_yaml(&hierarchies.first_parent_tree), FIRST_YAML);
    assert_eq!(datasource_type_tree_yaml(&hierarchies.all_parents_tree), ALL_YAML);
    let graph = datasource_type_graph(&contacts);
    assert_eq!(hierarchies.graph, graph);
    assert_eq!(
        graph,
        DatasourceTypeGraph {
            nodes: vec![
                "root".into(),
                "contact_source".into(),
                "contact".into(),
                "address".into(),
                "phone".into(),
                "contact_group".into(),
                "contact_group_member".into(),
                "legacy_contact".into(),
                "contact_change_log".into(),
            ],
            edges: vec![
                edge("contact_source", "root"),
                edge("contact", "contact_source"),
                edge("address", "contact"),
                edge("phone", "contact"),
                edge("contact_group", "root"),
                edge("contact_group_member", "contact"),
                edge("contact_group_member", "contact_group"),
                edge("legacy_contact", "root"),
                edge("contact_change_log", "root"),
            ],
        }
    );
    assert_eq!(datasource_type_graph_yaml(&graph), CONTACTS_GRAPH_YAML);
    assert_eq!(datasource_type_graph_json(&graph), CONTACTS_GRAPH_JSON);
    assert_eq!(datasource_type_graph_xml(&graph), CONTACTS_GRAPH_XML);
    assert_eq!(
        datasource_type_order(&contacts),
        vec![
            "contact_source",
            "contact",
            "address",
            "phone",
            "contact_group_member",
            "contact_group",
            "legacy_contact",
            "contact_change_log",
        ]
    );
    let compare = compare_by_datasource_type_order_with(&contacts, |name| {
        (name == "contact_card").then(|| "contact".to_string())
    });
    let mut names = vec!["legacy_contact", "contact_card", "address", "contact_source"];
    names.sort_by(|left, right| compare(left, right).cmp(&0));
    assert_eq!(names, vec!["contact_source", "contact_card", "address", "legacy_contact"]);
    assert_eq!(datasource_type_ancestry(&contacts, "address"), vec!["contact_source", "contact"]);
    assert_eq!(
        datasource_type_ancestry(&contacts, "contact_group_member"),
        vec!["contact_source", "contact", "contact_group"]
    );
    assert!(datasource_type_ancestry(&contacts, "contact_source").is_empty());
    assert!(datasource_type_ancestry(&contacts, "missing").is_empty());
    assert_eq!(
        datasource_type_ancestry(&[ds("a", &["b.id"]), ds("b", &["a.id"])], "a"),
        vec!["b".to_string()]
    );
    let cycle = datasource_type_graph(&[ds("a", &["b.id"]), ds("b", &["a.id"])]);
    assert_eq!(cycle.nodes, vec!["root".to_string(), "a".into(), "b".into()]);
    assert_eq!(cycle.edges, vec![edge("a", "b"), edge("b", "a")]);
    let plain = compare_by_datasource_type_order(&contacts);
    assert!(plain("contact", "address") < 0);
    assert!(plain("zeta", "alpha") > 0);
    assert_eq!(plain("orphan", "orphan"), 0);
    let missing_parent = compare_by_datasource_type_order_with(&contacts, |_| Some("not-in-tree".into()));
    assert_eq!(missing_parent("zeta", "alpha").signum(), plain("zeta", "alpha").signum());
    let outside = datasource_type_tree(
        &[
            ds("rootish", &[]),
            {
                let mut a = ds("a", &["b.id", "rootish.id"]);
                a.fields[0].references = Some(References::One("b.id".into()));
                a.fields[1].references = Some(References::One("rootish.id".into()));
                a
            },
            {
                let mut b = ds("b", &["a.id", "rootish.id"]);
                b.fields[0].references = Some(References::One("a.id".into()));
                b.fields[1].references = Some(References::One("rootish.id".into()));
                b
            },
        ],
        MultiParent::All,
    );
    assert_eq!(
        datasource_type_tree_yaml(&outside),
        "root:\n  rootish:\n    a:\n      b: {}\n    b:\n      a: {}\n"
    );
    assert!(datasource_type_order(&[]).is_empty());
    let mut solo = DatasourceTypeTree::default();
    solo.insert("solo".into(), DatasourceTypeTree::default());
    assert_eq!(datasource_type_tree_xml(&solo), "<solo/>\n");
    assert_eq!(
        datasource_type_graph(&[]),
        DatasourceTypeGraph {
            nodes: vec!["root".into()],
            edges: Vec::new(),
        }
    );
    assert!(datasource_type_ancestry(&[], "x").is_empty());
}

fn edge(from: &str, to: &str) -> DatasourceTypeGraphEdge {
    DatasourceTypeGraphEdge {
        from: from.into(),
        to: to.into(),
    }
}
