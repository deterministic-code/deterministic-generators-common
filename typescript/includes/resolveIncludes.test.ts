import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveIncludes } from "./datasource-types-includes.ts";

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
