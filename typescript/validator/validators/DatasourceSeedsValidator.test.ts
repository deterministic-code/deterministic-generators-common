import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DatasourceSeedsValidator } from "../index.ts";
import { DatasourceSeedsValidator as Engine } from "./DatasourceSeedsValidator.ts";

const TYPES = `version: 1.0.0
types:
  - user:
      fields:
        - email:
            type: string
            size: 256
        - nickname:
            type: string
            size: 64
            is_nullable: true
        - active:
            type: boolean
            default_value: true
        - score:
            type: integer
            is_nullable: true
`;

const validator = () => new DatasourceSeedsValidator();

async function check(seeds: string, types = TYPES) {
  return validator().validate(seeds, { types });
}

describe("DatasourceSeedsValidator semantics", () => {
  test("accepts a row that omits a nullable field", async () => {
    const result = await check(`version: 1.0.0
seeds:
  - user:
      - id1:
          email: a@b.c
`);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("accepts a row that omits a field with a default_value", async () => {
    const result = await check(`version: 1.0.0
seeds:
  - user:
      - id1:
          email: a@b.c
`);
    expect(result.errors.filter((e) => /active/.test(e.message))).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("accepts null on a nullable field", async () => {
    const result = await check(`version: 1.0.0
seeds:
  - user:
      - id1:
          email: a@b.c
          nickname: null
          score: null
`);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("rejects a missing non-nullable field with no default", async () => {
    const result = await check(`version: 1.0.0
seeds:
  - user:
      - id1:
          nickname: al
`);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /missing required field 'email'/.test(e.message))).toBe(
      true,
    );
  });

  test("rejects null on a non-nullable field", async () => {
    const result = await check(`version: 1.0.0
seeds:
  - user:
      - id1:
          email: null
`);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /not nullable/.test(e.message))).toBe(true);
  });

  test("rejects an unknown table", async () => {
    const result = await check(`version: 1.0.0
seeds:
  - account:
      - id1:
          email: a@b.c
`);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /unknown type 'account'/.test(e.message))).toBe(
      true,
    );
  });

  test("rejects an unknown field", async () => {
    const result = await check(`version: 1.0.0
seeds:
  - user:
      - id1:
          email: a@b.c
          extra: true
`);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /unknown field 'extra'/.test(e.message))).toBe(
      true,
    );
  });

  test("rejects a value that does not match the field type", async () => {
    const result = await check(`version: 1.0.0
seeds:
  - user:
      - id1:
          email: a@b.c
          score: "yes"
`);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /must be integer/.test(e.message))).toBe(true);
  });

  test("rejects non-empty seeds when types.yaml is missing", async () => {
    const result = await validator().validate(`version: 1.0.0
seeds:
  - user:
      - id1:
          email: a@b.c
`);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/types.yaml is required/);
  });

  test("accepts empty seeds without types.yaml", async () => {
    expect(
      await validator().validate("version: 1.0.0\nseeds: []\n"),
    ).toEqual({ valid: true, errors: [] });
  });

  test("validateFile loads a sibling types.yaml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seeds-sibling-"));
    try {
      await writeFile(join(dir, "types.yaml"), TYPES);
      const path = join(dir, "datasource_seeds.yaml");
      await writeFile(
        path,
        `version: 1.0.0
seeds:
  - user:
      - id1:
          email: a@b.c
`,
      );
      expect((await validator().validateFile(path)).valid).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("validateFile reads typesPath when no sibling is present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seeds-path-"));
    try {
      const typesPath = join(dir, "types.yaml");
      await writeFile(typesPath, TYPES);
      const path = join(dir, "datasource_seeds.yaml");
      await writeFile(
        path,
        `version: 1.0.0
seeds:
  - user:
      - id1:
          email: a@b.c
`,
      );
      expect(
        (await validator().validateFile(path, { typesPath }))
          .valid,
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("validateFile without companion types fails for non-empty seeds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seeds-missing-"));
    try {
      const path = join(dir, "datasource_seeds.yaml");
      await writeFile(
        path,
        `version: 1.0.0
seeds:
  - user:
      - id1:
          email: a@b.c
`,
      );
      const result = await validator().validateFile(path);
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.message).toMatch(/types.yaml is required/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects an invalid companion datasource.yaml document", async () => {
    const result = await validator().validate(
      `version: 1.0.0
seeds:
  - user:
      - id1:
          email: a@b.c
`,
      {
        types: TYPES,
        datasource: "version: 1.0.0\nnot_types: 1\n",
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(
      /companion datasource.yaml is invalid/,
    );
  });

  test("rejects an invalid companion types.yaml document", async () => {
    const result = await check(
      `version: 1.0.0
seeds:
  - user:
      - id1:
          email: a@b.c
`,
      "version: 1.0.0\nnot_types: 1\n",
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/companion types.yaml is invalid/);
  });

  test("rejects a duplicate table and duplicate seed id", async () => {
    const result = await check(`version: 1.0.0
seeds:
  - user:
      - id1:
          email: a@b.c
      - id1:
          email: b@c.d
  - user:
      - id2:
          email: c@d.e
`);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /duplicate seed id/.test(e.message))).toBe(
      true,
    );
    expect(result.errors.some((e) => /duplicate seed table/.test(e.message))).toBe(
      true,
    );
  });

  test("rejects auto-injected columns in a seed row", async () => {
    const result = await check(`version: 1.0.0
seeds:
  - user:
      - id1:
          email: a@b.c
          id: 1
`);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /auto-injected/.test(e.message))).toBe(true);
  });

  test("type-checks integers, unsigned values, decimals, and reference fields", async () => {
    const types = `version: 1.0.0
types:
  - user:
      fields:
        - email:
            type: string
            size: 256
        - count:
            type: integer
        - visits:
            type: unsignedinteger
            default_value: 0
        - big:
            type: biginteger
            default_value: "0"
        - price:
            type: decimal
            default_value: 0
        - parent_id:
            references: user.id
            is_nullable: true
        - email_ref:
            references: user.email
            is_nullable: true
`;
    const ok = await check(
      `version: 1.0.0
seeds:
  - user:
      - id1:
          email: a@b.c
          count: 2
          visits: 1
          big: "9"
          price: 1.5
          parent_id: 1
          email_ref: a@b.c
`,
      types,
    );
    expect(ok).toEqual({ valid: true, errors: [] });

    const bad = await check(
      `version: 1.0.0
seeds:
  - user:
      - id1:
          email: a@b.c
          count: 1.5
          visits: -1
          big: true
          price: false
          parent_id: "x"
`,
      types,
    );
    expect(bad.valid).toBe(false);
    expect(bad.errors.some((e) => /count/.test(e.message))).toBe(true);
    expect(bad.errors.some((e) => /visits/.test(e.message))).toBe(true);
  });

  test("engine validateFile loads a sibling types.yaml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seeds-engine-"));
    try {
      await writeFile(join(dir, "types.yaml"), TYPES);
      const path = join(dir, "datasource_seeds.yaml");
      await writeFile(
        path,
        `version: 1.0.0
seeds:
  - user:
      - id1:
          email: a@b.c
`,
      );
      expect((await new Engine().validateFile(path)).valid).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects a float/number typed as a string", async () => {
    const types = `version: 1.0.0
types:
  - sample:
      fields:
        - ratio:
            type: float
        - amount:
            type: number
`;
    const result = await check(
      `version: 1.0.0
seeds:
  - sample:
      - id1:
          ratio: "1.5"
          amount: "2"
`,
      types,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /must be number/.test(e.message))).toBe(
      true,
    );
  });
});
