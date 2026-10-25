use std::fs;

use deterministic_generators_common::{VersionSnapshot, YamlNode, YamlValue};
use indexmap::IndexMap;

const CONTACTS: &str = "/Users/ryan/Projects/cali-contacts-test/cali-contacts-tests2/deterministic";

fn parse(text: &str) -> YamlValue {
    YamlNode::from_yaml(text).unwrap().value().cloned().unwrap()
}

fn serialize(value: YamlValue) -> String {
    let mut content = IndexMap::new();
    content.insert("added".into(), YamlValue::Bool(true));
    content.insert("content".into(), value);
    let mut doc = IndexMap::new();
    doc.insert("x.yaml".into(), YamlValue::Map(content));
    VersionSnapshot::combine([Some(YamlValue::Map(doc))])
        .unwrap()
        .yaml("x.yaml")
        .unwrap()
}

fn live_yaml(name: &str) -> String {
    let live = parse(&fs::read_to_string(format!("{CONTACTS}/{name}")).unwrap());
    let mut content = IndexMap::new();
    content.insert("added".into(), YamlValue::Bool(true));
    content.insert("content".into(), live);
    let mut doc = IndexMap::new();
    doc.insert(name.into(), YamlValue::Map(content));
    VersionSnapshot::combine([Some(YamlValue::Map(doc))])
        .unwrap()
        .yaml(name)
        .unwrap()
}

fn map(entries: &[(&str, YamlValue)]) -> YamlValue {
    let mut out = IndexMap::new();
    for (key, value) in entries {
        out.insert((*key).into(), value.clone());
    }
    YamlValue::Map(out)
}

#[test]
fn combine_adds_files_for_boolean_and_string_added() {
    let snapshot = VersionSnapshot::combine([
        Some(parse(
            "
a.yaml:
  added: true
  content:
    n: 1
",
        )),
        Some(map(&[(
            "b.yaml",
            map(&[
                ("added", YamlValue::String("true".into())),
                ("content", map(&[("n", YamlValue::Number(2.0))])),
            ]),
        )])),
        Some(map(&[(
            "c.yaml",
            map(&[
                ("added", YamlValue::String("True".into())),
                ("content", map(&[("n", YamlValue::Number(3.0))])),
            ]),
        )])),
    ])
    .unwrap();
    assert_eq!(snapshot.yaml("a.yaml").unwrap(), serialize(parse("n: 1\n")));
    assert_eq!(snapshot.yaml("b.yaml").unwrap(), serialize(parse("n: 2\n")));
    assert_eq!(snapshot.yaml("c.yaml").unwrap(), serialize(parse("n: 3\n")));
}

#[test]
fn combine_removes_a_file() {
    let snapshot = VersionSnapshot::combine([
        Some(parse(
            "
gone.yaml:
  added: true
  content: { n: 1 }
keep.yaml:
  added: true
  content: { n: 2 }
",
        )),
        Some(parse(
            "
gone.yaml:
  removed: true
",
        )),
    ])
    .unwrap();
    assert!(!snapshot.documents.contains_key("gone.yaml"));
    assert_eq!(snapshot.yaml("keep.yaml").unwrap(), serialize(parse("n: 2\n")));
}

#[test]
fn combine_merges_object_keys() {
    let snapshot = VersionSnapshot::combine([
        Some(parse(
            "
doc.yaml:
  added: true
  content:
    a: 1
    gone: true
    keep: old
    stay: prev
",
        )),
        Some(parse(
            "
doc.yaml:
  b: 2
  keep: new
  stay: ~
  nested: ~
  removed:
    - gone
",
        )),
    ])
    .unwrap();
    assert_eq!(
        snapshot.yaml("doc.yaml").unwrap(),
        serialize(parse("a: 1\nkeep: new\nstay: prev\nb: 2\nnested: ~\n"))
    );
}

#[test]
fn combine_stores_removed_true_on_an_object() {
    let snapshot = VersionSnapshot::combine([
        Some(parse(
            "
doc.yaml:
  added: true
  content:
    a: 1
",
        )),
        Some(parse(
            "
doc.yaml:
  removed: true
  extra: 2
",
        )),
    ])
    .unwrap();
    assert_eq!(
        snapshot.yaml("doc.yaml").unwrap(),
        serialize(parse("a: 1\nremoved: true\nextra: 2\n"))
    );
}

#[test]
fn combine_applies_keyed_add_change_and_remove() {
    let snapshot = VersionSnapshot::combine([
        Some(parse(
            "
doc.yaml:
  added: true
  content:
    types:
      - a:
          n: 1
      - b:
          n: 2
",
        )),
        Some(parse(
            "
doc.yaml:
  types:
    added:
      - c:
          n: 3
    changed:
      - a:
          n: 9
      - {}
      - 1
    removed:
      - b
      - 1
      - ~
      - { x: 1 }
      - false
      - 1.5
",
        )),
    ])
    .unwrap();
    assert_eq!(
        snapshot.yaml("doc.yaml").unwrap(),
        serialize(parse(
            "
types:
  - c:
      n: 3
  - a:
      n: 9
"
        ))
    );
}

#[test]
fn combine_replaces_and_keeps_null_envelopes() {
    let replaced = VersionSnapshot::combine([
        Some(parse(
            "
doc.yaml:
  added: true
  content:
    types:
      - a: 1
",
        )),
        Some(parse(
            "
doc.yaml:
  types: replaced
",
        )),
    ])
    .unwrap();
    assert_eq!(replaced.yaml("doc.yaml").unwrap(), serialize(parse("types: replaced\n")));

    let kept = VersionSnapshot::combine([
        Some(parse(
            "
doc.yaml:
  added: true
  content:
    n: 1
",
        )),
        Some(parse("doc.yaml: ~\n")),
        None,
    ])
    .unwrap();
    assert_eq!(kept.yaml("doc.yaml").unwrap(), serialize(parse("n: 1\n")));
}

#[test]
fn combine_throws_when_a_diff_is_not_a_mapping() {
    let err = match VersionSnapshot::combine([Some(parse("- a\n"))]) {
        Err(err) => err.to_string(),
        Ok(_) => panic!("expected a mapping"),
    };
    assert_eq!(err, "expected a mapping");
    let err = match VersionSnapshot::combine([Some(YamlValue::Number(1.0))]) {
        Err(err) => err.to_string(),
        Ok(_) => panic!("expected a mapping"),
    };
    assert_eq!(err, "expected a mapping");
}

#[test]
fn combine_scalar_empty_list_and_extra_keys() {
    let added_false = VersionSnapshot::combine([
        Some(parse(
            "
doc.yaml:
  added: true
  content:
    n: 1
",
        )),
        Some(parse(
            "
doc.yaml:
  added: false
  n: 2
",
        )),
    ])
    .unwrap();
    assert_eq!(
        added_false.yaml("doc.yaml").unwrap(),
        serialize(parse("n: 2\nadded: false\n"))
    );

    let scalar = VersionSnapshot::combine([
        Some(parse(
            "
a.yaml:
  added: true
  content:
    n: 1
b.yaml:
  added: true
  content:
    n: 2
",
        )),
        Some(map(&[("a.yaml", YamlValue::Number(4.0))])),
        Some(parse(
            "
b.yaml:
  added: true
  content: ~
",
        )),
    ])
    .unwrap();
    assert_eq!(scalar.yaml("a.yaml").unwrap(), serialize(YamlValue::Number(4.0)));
    assert!(!scalar.documents.contains_key("b.yaml"));

    let empty = VersionSnapshot::combine([
        Some(parse(
            "
doc.yaml:
  added: true
  content:
    types: []
",
        )),
        Some(parse(
            "
doc.yaml:
  types:
    added:
      - a: 1
",
        )),
    ])
    .unwrap();
    assert_eq!(
        empty.yaml("doc.yaml").unwrap(),
        serialize(parse(
            "
types:
  added:
    - a: 1
"
        ))
    );

    let extra = VersionSnapshot::combine([
        Some(parse(
            "
doc.yaml:
  added: true
  content:
    types:
      - a: 1
",
        )),
        Some(parse(
            "
doc.yaml:
  types:
    added:
      - b: 2
    extra: 1
",
        )),
    ])
    .unwrap();
    assert_eq!(
        extra.yaml("doc.yaml").unwrap(),
        serialize(parse(
            "
types:
  added:
    - b: 2
  extra: 1
"
        ))
    );

    let two_key = VersionSnapshot::combine([
        Some(parse(
            "
doc.yaml:
  added: true
  content:
    types:
      - a: 1
        b: 2
",
        )),
        Some(parse(
            "
doc.yaml:
  types:
    added:
      - c: 3
",
        )),
    ])
    .unwrap();
    assert_eq!(
        two_key.yaml("doc.yaml").unwrap(),
        serialize(parse(
            "
types:
  added:
    - c: 3
"
        ))
    );
}

#[test]
fn yaml_throws_for_a_missing_path() {
    let snapshot = VersionSnapshot::combine([]).unwrap();
    assert_eq!(snapshot.yaml("types.yaml").unwrap_err().to_string(), "missing types.yaml");
}

#[test]
fn read_empty_and_invalid_and_contacts() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("not-a-version")).unwrap();
    fs::write(
        dir.path().join("not-a-version").join("diff.yaml"),
        "types.yaml: { added: true, content: 1 }\n",
    )
    .unwrap();
    fs::create_dir(dir.path().join("version-20261022T083957Z-001")).unwrap();
    fs::write(dir.path().join("version-20261022T083957Z-001").join("diff.yaml"), "").unwrap();
    fs::create_dir(dir.path().join("version-20261024T050249Z-002")).unwrap();
    assert!(VersionSnapshot::read(dir.path()).unwrap().documents.is_empty());

    let only = tempfile::tempdir().unwrap();
    assert!(VersionSnapshot::read(only.path()).unwrap().documents.is_empty());

    let bad = tempfile::tempdir().unwrap();
    let version = bad.path().join("version-20261022T083957Z-001");
    fs::create_dir(&version).unwrap();
    fs::write(version.join("diff.yaml"), "- not a map\n").unwrap();
    let mapping = match VersionSnapshot::read(bad.path()) {
        Err(err) => err.to_string(),
        Ok(_) => panic!("expected a mapping"),
    };
    assert_eq!(mapping, "version-20261022T083957Z-001/diff.yaml: expected a mapping");
    fs::write(version.join("diff.yaml"), ":\n  [").unwrap();
    let parse_err = match VersionSnapshot::read(bad.path()) {
        Err(err) => err.to_string(),
        Ok(_) => panic!("expected parse error"),
    };
    assert!(parse_err.contains("version-20261022T083957Z-001/diff.yaml"));

    let missing = match VersionSnapshot::read("/no/such/dgc-version-snapshot") {
        Err(err) => err.to_string(),
        Ok(_) => panic!("expected missing root"),
    };
    assert!(!missing.is_empty());

    let snapshot = VersionSnapshot::read(CONTACTS).unwrap();
    assert_eq!(snapshot.yaml("types.yaml").unwrap(), live_yaml("types.yaml"));
    assert_eq!(snapshot.yaml("datasource.yaml").unwrap(), live_yaml("datasource.yaml"));
}

#[test]
fn emit_covers_empty_and_bool_false() {
    let snapshot = VersionSnapshot::combine([Some(parse(
        "
doc.yaml:
  added: true
  content:
    flag: false
    empty_list: []
    empty_map: {}
    items:
      - 1
      - two
",
    ))])
    .unwrap();
    let text = snapshot.yaml("doc.yaml").unwrap();
    assert!(text.contains("false"));
    assert!(text.contains("[]"));
    assert!(text.contains("{}"));
}
