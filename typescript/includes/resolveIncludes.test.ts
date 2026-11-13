import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { combineDatasourceTypes } from "./datasource-types-combine.ts";
import { resolveIncludes } from "./datasource-types-includes.ts";
import { combineDatasourceSeeds, resolveSeedIncludes } from "./datasource-seeds-includes.ts";

const loadText = (text: string, key: string) => async () => ({
  text,
  key,
  ctx: {},
});

const loadFiles =
  (files: Record<string, string>) =>
  async (include: { file?: string }) => {
    const key = include.file ?? "";
    const text = files[key];
    if (text === undefined) throw new Error(`missing ${key}`);
    return { text, key, ctx: {} };
  };

const typeDoc = (name: string) =>
  `version: 1.0.0\ntypes:\n  - ${name}:\n      fields: []\n`;

const seedDoc = (name: string) =>
  `version: 1.0.0\nseeds:\n  - ${name}:\n      - id1:\n          x: 1\n`;

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

  it("folds a diamond include to one copy", async () => {
    const result = await resolveIncludes(
      "includes:\n  - file: base.yaml\n  - file: lookups.yaml\ntypes:\n  - extra:\n      fields: []\n",
      loadFiles({
        "base.yaml": typeDoc("base"),
        "lookups.yaml":
          "includes:\n  - file: base.yaml\ntypes:\n  - lookup:\n      fields: []\n",
      }),
    );
    assert.equal([...result.yaml.matchAll(/- base:/g)].length, 1);
    assert.match(result.yaml, /lookup:/);
    assert.match(result.yaml, /extra:/);
    assert.ok(result.yaml.indexOf("base:") < result.yaml.indexOf("lookup:"));
    assert.ok(result.yaml.indexOf("lookup:") < result.yaml.indexOf("extra:"));
  });

  it("folds base once when two sibling includes each nest base.yaml", async () => {
    const child = (name: string) =>
      `includes:\n  - file: base.yaml\ntypes:\n  - ${name}:\n      fields: []\n`;
    const result = await resolveIncludes(
      "includes:\n  - file: user-roles.yaml\n  - file: applications.yaml\ntypes:\n  - extra:\n      fields: []\n",
      loadFiles({
        "base.yaml": typeDoc("base"),
        "user-roles.yaml": child("role"),
        "applications.yaml": child("app"),
      }),
    );
    assert.equal([...result.yaml.matchAll(/- base:/g)].length, 1);
    assert.match(result.yaml, /role:/);
    assert.match(result.yaml, /app:/);
    assert.match(result.yaml, /extra:/);
  });

  it("skips a second include of the same path when combine_options is {}", async () => {
    const result = await resolveIncludes(
      "includes:\n  - file: base.yaml\n    combine_options: {}\n  - file: child.yaml\ntypes: []\n",
      loadFiles({
        "base.yaml": typeDoc("base"),
        "child.yaml":
          "includes:\n  - file: base.yaml\ntypes:\n  - child:\n      fields: []\n",
      }),
    );
    assert.equal([...result.yaml.matchAll(/- base:/g)].length, 1);
  });

  it("throws when the same path is included with different combine_options", async () => {
    await assert.rejects(
      () =>
        resolveIncludes(
          "includes:\n  - file: base.yaml\n  - file: child.yaml\ntypes: []\n",
          loadFiles({
            "base.yaml": typeDoc("base"),
            "child.yaml":
              "includes:\n  - file: base.yaml\n    combine_options:\n      source:\n        remove_types: [base]\ntypes:\n  - child:\n      fields: []\n",
          }),
        ),
      /base\.yaml.*combine_options differ/,
    );
  });

  it("throws on an include cycle", async () => {
    await assert.rejects(
      () =>
        resolveIncludes(
          "includes:\n  - file: a.yaml\ntypes: []\n",
          loadFiles({
            "a.yaml": "includes:\n  - file: b.yaml\ntypes: []\n",
            "b.yaml": "includes:\n  - file: a.yaml\ntypes: []\n",
          }),
        ),
      /include cycle detected at 'a\.yaml'/,
    );
  });

  it("throws when two different files define the same type name", async () => {
    await assert.rejects(
      () =>
        resolveIncludes(
          "includes:\n  - file: a.yaml\n  - file: b.yaml\ntypes: []\n",
          loadFiles({
            "a.yaml": typeDoc("user"),
            "b.yaml": typeDoc("user"),
          }),
        ),
      /duplicate type 'user'/,
    );
  });

  it("treats remove_types as done when diamond skip already left the type on dest", async () => {
    const result = await resolveIncludes(
      "includes:\n  - file: base.yaml\n  - file: child.yaml\n    combine_options:\n      source:\n        remove_types: [base]\ntypes:\n  - extra:\n      fields: []\n",
      loadFiles({
        "base.yaml": typeDoc("base"),
        "child.yaml":
          "includes:\n  - file: base.yaml\ntypes:\n  - child:\n      fields: []\n",
      }),
    );
    assert.equal([...result.yaml.matchAll(/- base:/g)].length, 1);
    assert.match(result.yaml, /child:/);
    assert.match(result.yaml, /extra:/);
  });

  it("keeps one base when several children remove_types a nested base include", async () => {
    const child = (name: string) =>
      `includes:\n  - file: base.yaml\ntypes:\n  - ${name}:\n      fields: []\n`;
    const result = await resolveIncludes(
      "includes:\n  - file: base.yaml\n  - file: a.yaml\n    combine_options:\n      source:\n        remove_types: [base]\n  - file: b.yaml\n    combine_options:\n      source:\n        remove_types: [base]\n  - file: c.yaml\n    combine_options:\n      source:\n        remove_types: [base]\ntypes:\n  - extra:\n      fields: []\n",
      loadFiles({
        "base.yaml": typeDoc("base"),
        "a.yaml": child("a"),
        "b.yaml": child("b"),
        "c.yaml": child("c"),
      }),
    );
    assert.equal([...result.yaml.matchAll(/- base:/g)].length, 1);
    assert.match(result.yaml, /- a:/);
    assert.match(result.yaml, /- b:/);
    assert.match(result.yaml, /- c:/);
    assert.match(result.yaml, /extra:/);
  });

  it("restores user_base when a later include needs it after remove_types stripped the first copy", async () => {
    const result = await resolveIncludes(
      "includes:\n  - file: games.yaml\n  - file: identity.yaml\n    combine_options:\n      source:\n        remove_types: [user_base]\ntypes: []\n",
      loadFiles({
        "user-roles.yaml": typeDoc("user_base"),
        "reviews.yaml":
          "includes:\n  - file: user-roles.yaml\ntypes:\n  - review:\n      fields: []\n",
        "games.yaml":
          "includes:\n  - file: user-roles.yaml\n  - file: reviews.yaml\ntypes:\n  - game:\n      fields: []\n",
        "identity.yaml":
          "includes:\n  - file: user-roles.yaml\ntypes:\n  - oauth:\n      fields: []\n",
      }),
    );
    assert.equal([...result.yaml.matchAll(/- user_base:/g)].length, 1);
    assert.match(result.yaml, /- review:/);
    assert.match(result.yaml, /- game:/);
    assert.match(result.yaml, /- oauth:/);
  });

  it("drops source remove_types when dest already has the type", () => {
    const result = combineDatasourceTypes(
      typeDoc("child"),
      typeDoc("base"),
      { source: { remove_types: ["base"] } },
    );
    assert.match(result.yaml, /child:/);
    assert.match(result.yaml, /base:/);
  });

  it("throws when remove_types names a type on neither side", () => {
    assert.throws(
      () =>
        combineDatasourceTypes(typeDoc("child"), typeDoc("base"), {
          source: { remove_types: ["missing"] },
        }),
      /unknown remove_types target/,
    );
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

  it("treats seed remove_types as done when dest already has the type", () => {
    const result = combineDatasourceSeeds(seedDoc("child"), seedDoc("base"), {
      source: { remove_types: ["base"] },
    });
    assert.match(result.yaml, /child:/);
    assert.match(result.yaml, /base:/);
  });

  it("treats seed remove_types as done when diamond skip already left the type on dest", async () => {
    const result = await resolveSeedIncludes(
      "version: 1.0.0\nincludes:\n  - file: base.yaml\n  - file: child.yaml\n    combine_options:\n      source:\n        remove_types: [base]\nseeds:\n  - extra:\n      - id1:\n          x: 1\n",
      loadFiles({
        "base.yaml": seedDoc("base"),
        "child.yaml":
          "version: 1.0.0\nincludes:\n  - file: base.yaml\nseeds:\n  - child:\n      - id1:\n          x: 1\n",
      }),
    );
    assert.equal([...result.yaml.matchAll(/- base:/g)].length, 1);
    assert.match(result.yaml, /child:/);
    assert.match(result.yaml, /extra:/);
  });

  it("folds a diamond include to one copy", async () => {
    const result = await resolveSeedIncludes(
      "version: 1.0.0\nincludes:\n  - file: base.yaml\n  - file: child.yaml\nseeds:\n  - extra:\n      - id1:\n          x: 1\n",
      loadFiles({
        "base.yaml": seedDoc("base"),
        "child.yaml":
          "version: 1.0.0\nincludes:\n  - file: base.yaml\nseeds:\n  - child:\n      - id1:\n          x: 1\n",
      }),
    );
    assert.equal([...result.yaml.matchAll(/- base:/g)].length, 1);
    assert.match(result.yaml, /child:/);
    assert.match(result.yaml, /extra:/);
  });

  it("folds base once when two sibling seed includes each nest base.yaml", async () => {
    const child = (name: string) =>
      `version: 1.0.0\nincludes:\n  - file: base.yaml\nseeds:\n  - ${name}:\n      - id1:\n          x: 1\n`;
    const result = await resolveSeedIncludes(
      "version: 1.0.0\nincludes:\n  - file: user-roles.yaml\n  - file: applications.yaml\nseeds:\n  - extra:\n      - id1:\n          x: 1\n",
      loadFiles({
        "base.yaml": seedDoc("base"),
        "user-roles.yaml": child("role"),
        "applications.yaml": child("app"),
      }),
    );
    assert.equal([...result.yaml.matchAll(/- base:/g)].length, 1);
    assert.match(result.yaml, /role:/);
    assert.match(result.yaml, /app:/);
    assert.match(result.yaml, /extra:/);
  });

  it("throws when the same path is included with different combine_options", async () => {
    await assert.rejects(
      () =>
        resolveSeedIncludes(
          "version: 1.0.0\nincludes:\n  - file: base.yaml\n  - file: child.yaml\nseeds: []\n",
          loadFiles({
            "base.yaml": seedDoc("base"),
            "child.yaml":
              "version: 1.0.0\nincludes:\n  - file: base.yaml\n    combine_options:\n      source:\n        remove_types: [base]\nseeds:\n  - child:\n      - id1:\n          x: 1\n",
          }),
        ),
      /base\.yaml.*combine_options differ/,
    );
  });

  it("throws on an include cycle", async () => {
    await assert.rejects(
      () =>
        resolveSeedIncludes(
          "version: 1.0.0\nincludes:\n  - file: a.yaml\nseeds: []\n",
          loadFiles({
            "a.yaml": "version: 1.0.0\nincludes:\n  - file: b.yaml\nseeds: []\n",
            "b.yaml": "version: 1.0.0\nincludes:\n  - file: a.yaml\nseeds: []\n",
          }),
        ),
      /include cycle detected at 'a\.yaml'/,
    );
  });

  it("throws when two different files define the same type name", async () => {
    await assert.rejects(
      () =>
        resolveSeedIncludes(
          "version: 1.0.0\nincludes:\n  - file: a.yaml\n  - file: b.yaml\nseeds: []\n",
          loadFiles({
            "a.yaml": seedDoc("user"),
            "b.yaml": seedDoc("user"),
          }),
        ),
      /duplicate type 'user'/,
    );
  });
});
