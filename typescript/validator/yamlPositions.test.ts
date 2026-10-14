import { describe, expect, test } from "vitest";
import { Document, LineCounter, Pair, Scalar } from "yaml";
import {
  asRecord,
  parseJsonPointer,
  parseYamlWithPositions,
  positionFor,
} from "./yamlPositions.ts";

describe("asRecord", () => {
  test("returns the object for plain objects and arrays", () => {
    const obj = { a: 1 };
    expect(asRecord(obj)).toBe(obj);
    const arr = [1];
    expect(asRecord(arr)).toBe(arr);
  });

  test("returns null for null, primitives, and non-objects", () => {
    expect(asRecord(null)).toBeNull();
    expect(asRecord(undefined)).toBeNull();
    expect(asRecord(0)).toBeNull();
    expect(asRecord("x")).toBeNull();
    expect(asRecord(true)).toBeNull();
  });
});

describe("parseJsonPointer", () => {
  test("empty or root pointers yield no segments", () => {
    expect(parseJsonPointer("")).toEqual([]);
    expect(parseJsonPointer("/")).toEqual([""]);
  });

  test("unescapes ~1 as / and ~0 as ~", () => {
    expect(parseJsonPointer("/a~1b/~0c")).toEqual(["a/b", "~c"]);
  });
});

describe("positionFor", () => {
  const yaml = `types:
  - user:
      fields:
        - id:
            type: integer
      target: StandardCrud
lonely:
`;

  test("resolves a present path to a source position", () => {
    const { doc, lineCounter } = parseYamlWithPositions(yaml);
    const pos = positionFor(doc, lineCounter, "/types/0/user/fields/0/id/type");
    expect(pos.line).toBeGreaterThan(0);
    expect(pos.col).toBeGreaterThan(0);
  });

  test("stops at the last found map node when a key is missing", () => {
    const { doc, lineCounter } = parseYamlWithPositions(yaml);
    expect(positionFor(doc, lineCounter, "/types/0/user/nope")).toEqual({
      line: expect.any(Number),
      col: expect.any(Number),
    });
  });

  test("stops at a sequence for a bad, negative, or out-of-range index", () => {
    const { doc, lineCounter } = parseYamlWithPositions(yaml);
    for (const path of ["/types/notanindex", "/types/-1", "/types/99"]) {
      expect(positionFor(doc, lineCounter, path)).toEqual({
        line: expect.any(Number),
        col: expect.any(Number),
      });
    }
  });

  test("stops at a scalar when the path continues past it", () => {
    const { doc, lineCounter } = parseYamlWithPositions(yaml);
    expect(
      positionFor(doc, lineCounter, "/types/0/user/target/deeper"),
    ).toEqual({ line: expect.any(Number), col: expect.any(Number) });
  });

  test("walks into a null pair value then returns the document origin", () => {
    const { doc, lineCounter } = parseYamlWithPositions(yaml);
    expect(positionFor(doc, lineCounter, "/lonely/child")).toEqual({
      line: expect.any(Number),
      col: expect.any(Number),
    });
  });

  test("an empty document has no contents; position falls back to origin", () => {
    const { doc, lineCounter } = parseYamlWithPositions("");
    expect(doc.contents).toBeNull();
    expect(positionFor(doc, lineCounter, "")).toEqual({
      line: expect.any(Number),
      col: expect.any(Number),
    });
    expect(positionFor(doc, lineCounter, "/foo")).toEqual({
      line: expect.any(Number),
      col: expect.any(Number),
    });
  });

  test("compares a non-scalar map key by String(key)", () => {
    const { doc, lineCounter } = parseYamlWithPositions(
      "? { nested: key }\n: hello\nsimple: 1\n",
    );
    expect(positionFor(doc, lineCounter, "/simple")).toEqual({
      line: expect.any(Number),
      col: expect.any(Number),
    });
  });

  test("a Pair document uses the key range, then the value range", () => {
    const lineCounter = new LineCounter();
    const withKey = new Document();
    const key = new Scalar("k");
    key.range = [0, 1, 1];
    const value = new Scalar("v");
    (withKey as { contents: unknown }).contents = new Pair(key, value);
    expect(positionFor(withKey, lineCounter, "")).toEqual({
      line: expect.any(Number),
      col: expect.any(Number),
    });

    const withValueOnly = new Document();
    const bareKey = new Scalar("k");
    const valued = new Scalar("v");
    valued.range = [4, 5, 5];
    (withValueOnly as { contents: unknown }).contents = new Pair(bareKey, valued);
    expect(positionFor(withValueOnly, lineCounter, "")).toEqual({
      line: expect.any(Number),
      col: expect.any(Number),
    });

    const withNeither = new Document();
    (withNeither as { contents: unknown }).contents = new Pair(
      new Scalar("k"),
      new Scalar("v"),
    );
    expect(positionFor(withNeither, lineCounter, "")).toEqual({
      line: expect.any(Number),
      col: expect.any(Number),
    });
  });
});
