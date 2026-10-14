import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compileTypesFilter } from "../parser/compile-filter.ts";

const cand = (name: string, tags: string[] = [], inherits?: string) => ({
  name,
  tags,
  inherits,
});

describe("compileTypesFilter", () => {
  it("matches type, tag, and inherits", () => {
    const byName = compileTypesFilter('type == "user"');
    const byTag = compileTypesFilter('tag == "view_type"');
    const byInherits = compileTypesFilter('inherits == "set"');
    const notTag = compileTypesFilter('tag != "datasource_type"');
    assert.equal(byName(cand("user", ["datasource_type"])), true);
    assert.equal(byName(cand("role", ["datasource_type"])), false);
    assert.equal(byTag(cand("person", ["view_type"])), true);
    assert.equal(byTag(cand("user", ["datasource_type"])), false);
    assert.equal(byInherits(cand("user", ["datasource_type"], "set")), true);
    assert.equal(
      compileTypesFilter('inherits != "set"')(cand("user", [], "set")),
      false,
    );
    assert.equal(notTag(cand("person", ["view_type"])), true);
    assert.equal(notTag(cand("user", ["datasource_type"])), false);
  });

  it("combines with && and ||", () => {
    const pred = compileTypesFilter(
      'tag == "datasource_type" && type != "legacy"',
    );
    assert.equal(pred(cand("user", ["datasource_type"])), true);
    assert.equal(pred(cand("legacy", ["datasource_type"])), false);
  });

  it("returns true when the filter is empty", () => {
    assert.equal(compileTypesFilter(undefined)(cand("user")), true);
    assert.equal(compileTypesFilter("1==1")(cand("user")), true);
  });

  it("rejects unknown identifiers", () => {
    assert.throws(
      () => compileTypesFilter("type is datasource_type"),
      /unknown identifier/,
    );
  });
});
