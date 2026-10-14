import assert from "node:assert/strict";
import { describe, it } from "vitest";
import * as parser from "../specification-parser.ts";

describe("parser public exports", () => {
  it("exposes only DeterministicParser as a value", () => {
    assert.deepEqual(Object.keys(parser).sort(), ["DeterministicParser"]);
  });
});
