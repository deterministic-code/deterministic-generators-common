import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, it } from "vitest";
import { VersionSnapshot } from "../version-snapshot.ts";
import type { YamlValue } from "../yaml-node.ts";

const contactsRoot =
  "/Users/ryan/Projects/cali-contacts-test/cali-contacts-tests2/deterministic";

const parseYaml = (text: string): YamlValue => parse(text) as YamlValue;

const serialize = (value: YamlValue): string =>
  VersionSnapshot.combine([{ "x.yaml": { added: true, content: value } }]).yaml("x.yaml");

const liveYaml = async (name: string): Promise<string> => {
  const live = parseYaml(await readFile(join(contactsRoot, name), "utf8"));
  return VersionSnapshot.combine([{ [name]: { added: true, content: live } }]).yaml(name);
};

describe("VersionSnapshot", () => {
  it("adds files for boolean and string added", () => {
    const snapshot = VersionSnapshot.combine([
      parseYaml(`
a.yaml:
  added: true
  content:
    n: 1
`),
      { "b.yaml": { added: "true", content: { n: 2 } } },
      { "c.yaml": { added: "True", content: { n: 3 } } },
    ]);
    assert.equal(snapshot.yaml("a.yaml"), serialize(parseYaml("n: 1\n")));
    assert.equal(snapshot.yaml("b.yaml"), serialize(parseYaml("n: 2\n")));
    assert.equal(snapshot.yaml("c.yaml"), serialize(parseYaml("n: 3\n")));
  });

  it("removes a file", () => {
    const snapshot = VersionSnapshot.combine([
      parseYaml(`
gone.yaml:
  added: true
  content: { n: 1 }
keep.yaml:
  added: true
  content: { n: 2 }
`),
      parseYaml(`
gone.yaml:
  removed: true
`),
    ]);
    assert.equal(Object.hasOwn(snapshot.documents, "gone.yaml"), false);
    assert.equal(snapshot.yaml("keep.yaml"), serialize(parseYaml("n: 2\n")));
  });

  it("merges object keys", () => {
    const snapshot = VersionSnapshot.combine([
      parseYaml(`
doc.yaml:
  added: true
  content:
    a: 1
    gone: true
    keep: old
    stay: prev
`),
      parseYaml(`
doc.yaml:
  b: 2
  keep: new
  stay: ~
  nested: ~
  removed:
    - gone
`),
    ]);
    assert.equal(
      snapshot.yaml("doc.yaml"),
      serialize(parseYaml("a: 1\nkeep: new\nstay: prev\nb: 2\nnested: ~\n")),
    );
  });

  it("stores removed true on an object", () => {
    const snapshot = VersionSnapshot.combine([
      parseYaml(`
doc.yaml:
  added: true
  content:
    a: 1
`),
      parseYaml(`
doc.yaml:
  removed: true
  extra: 2
`),
    ]);
    assert.equal(snapshot.yaml("doc.yaml"), serialize(parseYaml("a: 1\nremoved: true\nextra: 2\n")));
  });

  it("applies keyed add change and remove", () => {
    const snapshot = VersionSnapshot.combine([
      parseYaml(`
doc.yaml:
  added: true
  content:
    types:
      - a:
          n: 1
      - b:
          n: 2
`),
      parseYaml(`
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
`),
    ]);
    assert.equal(
      snapshot.yaml("doc.yaml"),
      serialize(parseYaml(`
types:
  - c:
      n: 3
  - a:
      n: 9
`)),
    );
  });

  it("replaces a value that is not a keyed split", () => {
    const snapshot = VersionSnapshot.combine([
      parseYaml(`
doc.yaml:
  added: true
  content:
    types:
      - a: 1
`),
      parseYaml(`
doc.yaml:
  types: replaced
`),
    ]);
    assert.equal(snapshot.yaml("doc.yaml"), serialize(parseYaml("types: replaced\n")));
  });

  it("keeps the previous file for a null envelope", () => {
    const snapshot = VersionSnapshot.combine([
      parseYaml(`
doc.yaml:
  added: true
  content:
    n: 1
`),
      parseYaml(`
doc.yaml: ~
`),
      null,
    ]);
    assert.equal(snapshot.yaml("doc.yaml"), serialize(parseYaml("n: 1\n")));
  });

  it("throws when a diff is not a mapping", () => {
    assert.throws(() => VersionSnapshot.combine([parseYaml("- a\n")]), /expected a mapping/);
    assert.throws(() => VersionSnapshot.combine([1]), /expected a mapping/);
  });

  it("replaces when added is not true", () => {
    const snapshot = VersionSnapshot.combine([
      parseYaml(`
doc.yaml:
  added: true
  content:
    n: 1
`),
      parseYaml(`
doc.yaml:
  added: false
  n: 2
`),
    ]);
    assert.equal(snapshot.yaml("doc.yaml"), serialize(parseYaml("n: 2\nadded: false\n")));
  });

  it("applies a scalar envelope and drops added null content", () => {
    const snapshot = VersionSnapshot.combine([
      parseYaml(`
a.yaml:
  added: true
  content:
    n: 1
b.yaml:
  added: true
  content:
    n: 2
`),
      { "a.yaml": 4 },
      parseYaml(`
b.yaml:
  added: true
  content: ~
`),
    ]);
    assert.equal(snapshot.yaml("a.yaml"), serialize(4));
    assert.equal(Object.hasOwn(snapshot.documents, "b.yaml"), false);
  });

  it("replaces an empty list instead of treating it as keyed", () => {
    const snapshot = VersionSnapshot.combine([
      parseYaml(`
doc.yaml:
  added: true
  content:
    types: []
`),
      parseYaml(`
doc.yaml:
  types:
    added:
      - a: 1
`),
    ]);
    assert.equal(
      snapshot.yaml("doc.yaml"),
      serialize(parseYaml(`
types:
  added:
    - a: 1
`)),
    );
  });

  it("replaces a keyed list when the delta has extra keys", () => {
    const snapshot = VersionSnapshot.combine([
      parseYaml(`
doc.yaml:
  added: true
  content:
    types:
      - a: 1
`),
      parseYaml(`
doc.yaml:
  types:
    added:
      - b: 2
    extra: 1
`),
    ]);
    assert.equal(
      snapshot.yaml("doc.yaml"),
      serialize(parseYaml(`
types:
  added:
    - b: 2
  extra: 1
`)),
    );
  });

  it("does not treat a two-key list as keyed", () => {
    const snapshot = VersionSnapshot.combine([
      parseYaml(`
doc.yaml:
  added: true
  content:
    types:
      - a: 1
        b: 2
`),
      parseYaml(`
doc.yaml:
  types:
    added:
      - c: 3
`),
    ]);
    assert.equal(
      snapshot.yaml("doc.yaml"),
      serialize(parseYaml(`
types:
  added:
    - c: 3
`)),
    );
  });

  it("throws for a missing yaml path", () => {
    const snapshot = VersionSnapshot.combine([]);
    assert.throws(() => snapshot.yaml("types.yaml"), /missing types.yaml/);
  });

  it("reads an empty directory and ignores non-version files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dgc-vs-"));
    try {
      await mkdir(join(dir, "not-a-version"));
      await writeFile(join(dir, "not-a-version", "diff.yaml"), "types.yaml: { added: true, content: 1 }\n");
      await mkdir(join(dir, "version-20261022T083957Z-001"));
      await writeFile(join(dir, "version-20261022T083957Z-001", "diff.yaml"), "");
      await mkdir(join(dir, "version-20261024T050249Z-002"));
      const empty = await VersionSnapshot.read(dir);
      assert.deepEqual(empty.documents, {});
      const only = await mkdtemp(join(tmpdir(), "dgc-empty-"));
      try {
        assert.deepEqual((await VersionSnapshot.read(only)).documents, {});
      } finally {
        await rm(only, { recursive: true, force: true });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws for a non-mapping or invalid diff", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dgc-vs-"));
    try {
      const version = join(dir, "version-20261022T083957Z-001");
      await mkdir(version);
      await writeFile(join(version, "diff.yaml"), "- not a map\n");
      await assert.rejects(
        () => VersionSnapshot.read(dir),
        (error: Error) => {
          assert.equal(error.message, "version-20261022T083957Z-001/diff.yaml: expected a mapping");
          return true;
        },
      );
      await writeFile(join(version, "diff.yaml"), ":\n  [");
      await assert.rejects(
        () => VersionSnapshot.read(dir),
        (error: Error) => {
          assert.match(error.message, /version-20261022T083957Z-001\/diff.yaml/);
          return true;
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("replays the contacts diffs onto live types and datasource", async () => {
    const snapshot = await VersionSnapshot.read(contactsRoot);
    assert.equal(snapshot.yaml("types.yaml"), await liveYaml("types.yaml"));
    assert.equal(snapshot.yaml("datasource.yaml"), await liveYaml("datasource.yaml"));
  });
});
