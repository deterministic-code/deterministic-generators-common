import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveIncludes } from "./datasource-types-includes.ts";
import { combineDatasourceSeeds, resolveSeedIncludes } from "./datasource-seeds-includes.ts";

const loadText = (text: string, key: string) => async () => ({
  text,
  key,
  ctx: {},
});

describe("resolveIncludes", () => {
  it("returns the document when includes is empty", async () => {
    const yaml = "types:\n  - user:\n      fields: []\n";
    const result = await resolveIncludes(yaml, async () => {
      throw new Error("load");
    });
    assert.equal(result.yaml, yaml);
  });

  it("folds an included document before the includer's types", async () => {
    const result = await resolveIncludes(
      "includes:\n  - file: users.yaml\ntypes:\n  - extra:\n      fields: []\n",
      loadText("types:\n  - user:\n      fields: []\n", "users.yaml"),
    );
    assert.match(result.yaml, /user:/);
    assert.match(result.yaml, /extra:/);
    assert.ok(result.yaml.indexOf("user:") < result.yaml.indexOf("extra:"));
  });
});

const loadSeeds = (text: string, key: string) => async () => ({
  text,
  key,
  ctx: {},
});

describe("resolveSeedIncludes", () => {
  it("returns the document when includes is empty", async () => {
    const yaml = "version: 1.0.0\nseeds: []\n";
    const result = await resolveSeedIncludes(yaml, async () => {
      throw new Error("load");
    });
    assert.equal(result.yaml, yaml);
  });

  it("folds an included document before the includer's seeds", async () => {
    const result = await resolveSeedIncludes(
      "version: 1.0.0\nincludes:\n  - file: users.yaml\nseeds:\n  - note:\n      - id1:\n          body: n\n",
      loadSeeds(
        "version: 1.0.0\nseeds:\n  - user:\n      - id1:\n          email: a\n",
        "users.yaml",
      ),
    );
    assert.doesNotMatch(result.yaml, /includes:/);
    assert.match(result.yaml, /user:/);
    assert.match(result.yaml, /note:/);
    assert.ok(result.yaml.indexOf("user:") < result.yaml.indexOf("note:"));
    assert.match(result.yaml, /^version: 1\.0\.0/m);
  });

  it("drops a colliding type with remove_types and throws when it remains", async () => {
    const source = "version: 1.0.0\nseeds:\n  - user:\n      - id1:\n          email: a\n  - role:\n      - id1:\n          code: r\n";
    const dest = "version: 1.0.0\nseeds:\n  - user:\n      - id2:\n          email: b\n";
    const dropped = combineDatasourceSeeds(source, dest, {
      source: { remove_types: ["user"] },
    });
    assert.match(dropped.yaml, /role:/);
    assert.doesNotMatch(dropped.yaml, /email: a/);
    assert.match(dropped.yaml, /email: b/);
    assert.throws(
      () => combineDatasourceSeeds(source, dest),
      /duplicate type 'user'/,
    );
  });

  it("throws when remove_types names a missing type", () => {
    assert.throws(
      () =>
        combineDatasourceSeeds(
          "version: 1.0.0\nseeds: []\n",
          "version: 1.0.0\nseeds: []\n",
          { source: { remove_types: ["missing"] } },
        ),
      /unknown remove_types target/,
    );
  });
});
