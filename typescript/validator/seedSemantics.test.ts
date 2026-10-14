import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseYamlWithPositions } from "./yamlPositions.ts";
import {
  checkSeedSemantics,
  seedsNeedCompanions,
  withSiblingCompanions,
} from "./seedSemantics.ts";
import type { ParsedYaml } from "./SpecValidator.ts";

function parsed(text: string): ParsedYaml {
  const { doc, lineCounter } = parseYamlWithPositions(text);
  return { doc, lineCounter, data: doc.toJS() };
}

describe("seedSemantics helpers", () => {
  test("seedsNeedCompanions is false for empty or missing seeds", () => {
    expect(seedsNeedCompanions({ version: "1.0.0", seeds: [] })).toBe(false);
    expect(seedsNeedCompanions({ version: "1.0.0" })).toBe(false);
    expect(seedsNeedCompanions(null)).toBe(false);
    expect(
      seedsNeedCompanions({
        version: "1.0.0",
        seeds: [{ user: [{ id1: { email: "a" } }] }],
      }),
    ).toBe(true);
  });

  test("withSiblingCompanions prefers an explicit document, then a path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seed-opts-"));
    try {
      const typesPath = join(dir, "t.yaml");
      await writeFile(typesPath, "version: 1.0.0\ntypes: []\n");
      expect(
        await withSiblingCompanions(join(dir, "seeds.yaml"), {
          types: "inline",
          typesPath: typesPath,
        }),
      ).toEqual({
        types: "inline",
        typesPath: typesPath,
      });
      const fromPath = await withSiblingCompanions(join(dir, "seeds.yaml"), {
        typesPath: typesPath,
      });
      expect(fromPath.types).toContain("types: []");
      const dsPath = join(dir, "ds.yaml");
      await writeFile(dsPath, "version: 1.0.0\ntypes: []\n");
      const withDs = await withSiblingCompanions(join(dir, "seeds.yaml"), {
        types: "inline",
        datasourcePath: dsPath,
      });
      expect(withDs.datasource).toContain("types: []");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("checkSeedSemantics skips malformed entries and unknown field types", () => {
    const seeds = parsed(`version: 1.0.0
seeds:
  - []
  - {}
  - other: not-a-list
  - user:
      - []
      - {}
      - id1:
          email: a@b.c
          weird: 1
`);
    const result = checkSeedSemantics(seeds, {
      types: [
        null,
        {},
        {
          user: {
            fields: [null, {}, { email: { type: "mystery" } }, { weird: {} }],
          },
        },
        { other: { fields: [{ n: { type: "integer" } }] } },
      ],
    });
    expect(result.valid).toBe(true);
  });

  test("checkSeedSemantics accepts unsigned bigintegers and rejects non-finite numbers", () => {
    const seeds = parsed(`version: 1.0.0
seeds:
  - sample:
      - id1:
          big: 1
          huge: -1
          ratio: 1.25
          flag: 1
          broken: 0
`);
    const data = seeds.data as {
      seeds: Array<Record<string, Array<Record<string, Record<string, unknown>>>>>;
    };
    data.seeds[0]!.sample![0]!.id1!.broken = Number.NaN;
    const result = checkSeedSemantics(seeds, {
      types: [
        {
          sample: {
            fields: [
              { big: { type: "unsignedbiginteger" } },
              { huge: { type: "unsignedbiginteger" } },
              { ratio: { type: "float" } },
              { flag: { type: "boolean" } },
              { broken: { type: "number" } },
            ],
          },
        },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /huge/.test(e.message))).toBe(true);
    expect(result.errors.some((e) => /flag/.test(e.message))).toBe(true);
    expect(result.errors.some((e) => /broken/.test(e.message))).toBe(true);
  });

  test("checkSeedSemantics resolves a dangling references string as a number", () => {
    const seeds = parsed(`version: 1.0.0
seeds:
  - user:
      - id1:
          owner: 1
          bad_ref: "x"
`);
    const result = checkSeedSemantics(seeds, {
      types: [
        {
          user: {
            fields: [
              { owner: { references: "missing.col" } },
              { bad_ref: { references: "nope.col" } },
            ],
          },
        },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /bad_ref/.test(e.message))).toBe(true);
  });

  test("checkSeedSemantics skips primitive table entries and row wraps", () => {
    const seeds = parsed(`version: 1.0.0
seeds:
  - user:
      - id1:
          email: a@b.c
`);
    const data = seeds.data as { seeds: unknown[] };
    data.seeds.unshift(null, "nope", 1);
    const rows = (data.seeds[3] as Record<string, unknown[]>).user;
    rows.unshift(null, "nope");
    const result = checkSeedSemantics(seeds, {
      types: [{ user: { fields: [{ email: { type: "string", size: 8 } }] } }],
    });
    expect(result.valid).toBe(true);
  });

  test("checkSeedSemantics no-ops when seeds is not an array", () => {
    expect(checkSeedSemantics(parsed("version: 1.0.0\n"), { types: [] })).toEqual(
      { valid: true, errors: [] },
    );
  });

  test("indexTypes skips non-tables and scalar field defs", () => {
    const seeds = parsed(`version: 1.0.0
seeds:
  - user:
      - id1:
          email: a@b.c
          extra: 1
  - ghost:
      - id1: {}
`);
    const result = checkSeedSemantics(seeds, {
      types: "nope",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /unknown type 'user'/.test(e.message))).toBe(
      true,
    );

    const result2 = checkSeedSemantics(seeds, {
      types: [
        { user: null },
        {
          user: {
            fields: [{ email: 1 }, { extra: { type: "mystery" } }],
          },
        },
        { ghost: { target: "None" } },
      ],
    });
    expect(result2.valid).toBe(true);

    const result3 = checkSeedSemantics(seeds, null);
    expect(result3.valid).toBe(false);
  });

  test("fieldType ignores malformed references and treats id as number", () => {
    const seeds = parsed(`version: 1.0.0
seeds:
  - user:
      - id1:
          a: 1
          b: 1
          c: 1
          d: "x"
          e: 1
`);
    const result = checkSeedSemantics(seeds, {
      types: [
        {
          user: {
            fields: [
              { a: { references: 1 } },
              { b: { references: "." } },
              { c: { references: "user." } },
              { d: { references: "user.id" } },
              { e: { references: "user.id" } },
            ],
          },
        },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /d/.test(e.message))).toBe(true);
  });

  test("STRING_OR_NUMBER rejects Infinity and unsigned small integers reject negatives", () => {
    const seeds = parsed(`version: 1.0.0
seeds:
  - sample:
      - id1:
          big: "1"
          tiny: -1
          created: "x"
          updated: "x"
`);
    const data = seeds.data as {
      seeds: Array<Record<string, Array<Record<string, Record<string, unknown>>>>>;
    };
    data.seeds[0]!.sample![0]!.id1!.big = Number.POSITIVE_INFINITY;
    const result = checkSeedSemantics(seeds, {
      types: [
        {
          sample: {
            fields: [
              { big: { type: "decimal" } },
              { tiny: { type: "unsignedsmallinteger" } },
              { created: { type: "string", size: 8 } },
              { updated: { type: "string", size: 8 } },
            ],
          },
        },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /auto-injected/.test(e.message))).toBe(true);
    expect(result.errors.some((e) => /tiny/.test(e.message))).toBe(true);
    expect(result.errors.some((e) => /big/.test(e.message))).toBe(true);
  });

  test("covers table-name and type-candidate edge cases", () => {
    const seeds = parsed(`version: 1.0.0
seeds:
  - user:
      - id1:
          email: a
`);
    expect(
      checkSeedSemantics(seeds, { types: "nope" }, {
        includes: [{ types: { filter: 'type == "user"' } }],
      }).valid,
    ).toBe(false);
    expect(
      checkSeedSemantics(seeds, { types: [{ user: { fields: [] } }] }, {
        types: "nope",
      }).valid,
    ).toBe(false);
    expect(
      checkSeedSemantics(
        seeds,
        {
          types: [
            null,
            {},
            { "": {} },
            { skip: 1 },
            { user: { fields: [{ email: { type: "string" } }] } },
          ],
        },
        {
          includes: [{ types: { filter: 'type == "user"' } }],
        },
      ).valid,
    ).toBe(true);
  });

  test("ignores a non-array includes list when resolving seed tables", () => {
    const seeds = parsed(`version: 1.0.0
seeds:
  - user:
      - id1:
          email: a
`);
    const result = checkSeedSemantics(
      seeds,
      { types: [{ user: { fields: [{ email: { type: "string" } }] } }] },
      { includes: [{ types: { filter: 1 } }, {}], types: [{ user: {} }] },
    );
    expect(result.valid).toBe(true);
  });

  test("datasource table names skip malformed entries when no filter is present", () => {
    const seeds = parsed(`version: 1.0.0
seeds:
  - user:
      - id1:
          email: a
`);
    const result = checkSeedSemantics(
      seeds,
      { types: [{ user: { fields: [{ email: { type: "string" } }] } }] },
      { types: [null, {}, { user: {} }] },
    );
    expect(result.valid).toBe(true);
  });

  test("a types filter on datasource.yaml selects seed tables", () => {
    const seeds = parsed(`version: 1.0.0
seeds:
  - project:
      - id1:
          name: Inbox
`);
    const types = {
      types: [
        {
          project: {
            tags: ["datasource_type"],
            fields: [{ name: { type: "string" } }],
          },
        },
        {
          ghost: {
            tags: ["view_type"],
            fields: [{ name: { type: "string" } }],
          },
        },
      ],
    };
    const datasource = {
      includes: [{ types: { filter: 'tag == "datasource_type"' } }],
      types: [],
    };
    expect(checkSeedSemantics(seeds, types, datasource)).toEqual({
      valid: true,
      errors: [],
    });
    const ghost = parsed(`version: 1.0.0
seeds:
  - ghost:
      - id1:
          name: x
`);
    const rejected = checkSeedSemantics(ghost, types, datasource);
    expect(rejected.valid).toBe(false);
    expect(rejected.errors[0]?.message).toMatch(/not in datasource.yaml/);
  });

  test("row values that are not mappings are treated as empty", () => {
    const seeds = parsed(`version: 1.0.0
seeds:
  - user:
      - id1: 1
`);
    const result = checkSeedSemantics(seeds, {
      types: [{ user: { fields: [{ email: { type: "string" } }] } }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /missing required field 'email'/.test(e.message))).toBe(
      true,
    );
  });
});
