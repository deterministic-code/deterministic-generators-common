import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  loadFieldTypeCatalog,
  parseFieldTypeCatalog,
} from "./fieldTypeCatalog.ts";

describe("fieldTypeCatalog", () => {
  test("parses tokens, ranges, and types with no defaults", () => {
    const catalog = parseFieldTypeCatalog(`version: 1.0.0
types:
  - integer:
      min_value: "-2"
      max_value: "2"
      defaults:
        - Literal:
            regex: '^-?\\d+$'
            description: integer literal
  - reference:
      supports_size: false
`);
    expect(catalog.get("integer")).toMatchObject({
      name: "integer",
      min_value: "-2",
      max_value: "2",
      defaults: [{ token: "Literal", regex: "^-?\\d+$" }],
    });
    expect(catalog.get("reference")?.defaults).toEqual([]);
  });

  test("skips malformed entries and optional catalog fields", () => {
    expect(parseFieldTypeCatalog("[]").size).toBe(0);
    expect(parseFieldTypeCatalog("types: nope\n").size).toBe(0);
    const catalog = parseFieldTypeCatalog(`version: 1.0.0
types: not-a-list
`);
    expect(catalog.size).toBe(0);
    const mixed = parseFieldTypeCatalog(`version: 1.0.0
types:
  - null
  - {}
  - integer: null
  - onlymin:
      min_value: null
      max_value: 3
  - integer:
      supports_size: yes
      min_value: 1
      max_value: null
      defaults:
        - {}
        - Literal: {}
        - Literal:
            regex: 1
        - Literal:
            regex: "^-?\\\\d+$"
            description: 4
  - bounded:
      supports_size: false
      min_value: "0"
      max_value: "9"
      implicit_default: 0
      defaults:
        - Literal:
            regex: "^\\\\d+$"
            description: digits
`);
    expect(mixed.has("")).toBe(false);
    expect(mixed.get("onlymin")).toMatchObject({
      min_value: null,
      max_value: undefined,
    });
    expect(mixed.get("integer")).toMatchObject({
      supports_size: undefined,
      min_value: undefined,
      max_value: null,
      defaults: [{ token: "Literal", regex: "^-?\\d+$", description: undefined }],
    });
    expect(mixed.get("bounded")?.defaults[0]?.description).toBe("digits");
  });

  test("loadFieldTypeCatalog throws when the catalog file is missing", async () => {
    await expect(loadFieldTypeCatalog(tmpdir())).rejects.toThrow(
      "field type catalog not found: backend/types.yaml",
    );
  });

  async function writeCatalog(text: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "catalog-"));
    await mkdir(join(dir, "backend"));
    await writeFile(join(dir, "backend", "types.yaml"), text);
    return dir;
  }

  test("loadFieldTypeCatalog throws when a catalog entry is missing required keys", async () => {
    const dir = await writeCatalog(`version: 1.0.0
types:
  - integer:
      supports_size: false
      implicit_default: 0
      min_value: "0"
      max_value: "1"
`);
    await expect(loadFieldTypeCatalog(dir)).rejects.toThrow(
      "field type 'integer' is missing defaults",
    );
  });

  test("loadFieldTypeCatalog throws when the catalog has no types array", async () => {
    const dir = await writeCatalog("version: 1.0.0\n");
    await expect(loadFieldTypeCatalog(dir)).rejects.toThrow(
      "field type catalog missing types array",
    );
  });

  test("loadFieldTypeCatalog throws when a catalog entry is malformed", async () => {
    const dir = await writeCatalog("version: 1.0.0\ntypes:\n  - 1\n");
    await expect(loadFieldTypeCatalog(dir)).rejects.toThrow(
      "field type catalog has a malformed type entry",
    );
  });

  test("datetime and uuid expose the symbolic default tokens", async () => {
    const catalog = await loadFieldTypeCatalog();
    expect(catalog.get("datetime")?.defaults.map((d) => d.token)).toEqual([
      "Now",
      "UtcNow",
      "DateTime",
    ]);
    expect(catalog.get("uuid")?.defaults.map((d) => d.token)).toEqual([
      "NewId",
      "Empty",
      "Uuid",
    ]);
    expect(catalog.get("binary")?.defaults.map((d) => d.token)).toEqual(["Hex"]);
  });
});
