import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { YamlNode } from "../yaml-node.ts";

describe("YamlNode", () => {
  it("reads string, number, boolean, and null literals", () => {
    const node = YamlNode.fromYaml(`
a: hello
b: 3
c: true
d: false
e: null
f: 1.5
g: .inf
`);
    assert.equal(node.str("a"), "hello");
    assert.equal(node.literal("a"), "hello");
    assert.equal(node.finiteInt("b"), 3);
    assert.equal(node.finiteNumber("b"), 3);
    assert.equal(node.literal("b"), 3);
    assert.equal(node.bool("c"), true);
    assert.equal(node.bool("d"), false);
    assert.equal(node.literal("c"), true);
    assert.equal(node.literal("d"), false);
    assert.equal(node.literal("e"), null);
    assert.equal(node.finiteNumber("f"), 1.5);
    assert.equal(node.finiteInt("f"), undefined);
    assert.equal(node.finiteNumber("g"), undefined);
    assert.equal(node.str("b"), undefined);
    assert.equal(node.has("a"), true);
    assert.equal(node.has("missing"), false);
  });

  it("filters string lists and skips empty named items", () => {
    const node = YamlNode.fromYaml(`
tags:
  - alpha
  - 1
  - beta
items:
  - {}
  - []
  - named:
      ok: true
`);
    assert.deepEqual(node.strings("tags"), ["alpha", "beta"]);
    assert.deepEqual(node.strings("missing"), []);
    assert.deepEqual(
      node.namedList("items").map((e) => e.name),
      ["named"],
    );
    assert.deepEqual(node.items().map((n) => n.path), []);
  });
});
