import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { TypesValidator } from "./TypesValidator.ts";
import { DatasourceSeedsValidator } from "./DatasourceSeedsValidator.ts";
import { DatasourceValidator } from "./DatasourceValidator.ts";
import { FrontendBindingsValidator } from "./FrontendBindingsValidator.ts";
import { RoutesApiValidator } from "./RoutesApiValidator.ts";
import { RoutesValidator } from "./RoutesValidator.ts";
import { ServicesValidator } from "./ServicesValidator.ts";
import { VALIDATOR_ENGINES } from "../specVersion.ts";

const yaml = (body: string) => `version: 1.0.0\n${body}`;

const VALID_BODY = `types:
  - user:
      fields:
        - email:
            type: string
`;

const ENGINES = {
  TypesValidator,
  DatasourceValidator,
  DatasourceSeedsValidator,
  RoutesValidator,
  RoutesApiValidator,
  ServicesValidator,
  FrontendBindingsValidator,
} as const;

const MINIMAL: Record<string, string> = {
  DatasourceSeedsValidator: "seeds: []\n",
  DatasourceValidator: "types: []\n",
  ServicesValidator: "services: []\n",
  FrontendBindingsValidator: "datasources: []\n",
  RoutesValidator: "routes: []\n",
  RoutesApiValidator: "routes: []\ncomponents: {}\n",
};

describe("live engines", () => {
  const datasource = new TypesValidator();

  test("accepts a valid types document", async () => {
    expect(await datasource.validate(yaml(VALID_BODY))).toEqual({
      valid: true,
      errors: [],
    });
  });

  test("reports a positioned error for a missing top-level required key", async () => {
    const result = await datasource.validate("not_types: 1\n");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      line: expect.any(Number),
      col: expect.any(Number),
      message: expect.any(String),
    });
  });

  test("reports only the unexpected type property", async () => {
    const result = await datasource.validate(
      yaml(`types:
  - base:
      tags: [view_type]
      tags2: [x]
      fields:
        - name:
            type: string
`),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.message)).toEqual([
      "/types/0/base must NOT have additional properties (property: tags2)",
    ]);
  });

  test("accepts a type that has tags and no inherits, union, or fields", async () => {
    expect(
      await datasource.validate(yaml("types:\n  - user:\n      tags: [view_type]\n")),
    ).toEqual({ valid: true, errors: [] });
  });

  test("rejects dictionary without fields", async () => {
    const result = await datasource.validate(
      yaml("types:\n  - settings:\n      inherits: dictionary\n"),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /fields/.test(e.message))).toBe(true);
    expect(result.errors.some((e) => /oneOf|exactly one/.test(e.message))).toBe(
      false,
    );
  });

  test("rejects a leftover one_of on an inherit type", async () => {
    const result = await datasource.validate(
      yaml("types:\n  - user:\n      inherits: set\n      one_of: [a, b]\n"),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("accepts unsigned integer-family field types", async () => {
    const result = await datasource.validate(
      yaml(`types:
  - sample:
      fields:
        - count:
            type: unsignedinteger
            default_value: 0
        - big_count:
            type: unsignedbiginteger
            default_value: "18446744073709551615"
        - small_count:
            type: unsignedsmallinteger
            min_size: 0
`),
    );
    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("rejects a negative default_value on unsignedinteger", async () => {
    const result = await datasource.validate(
      yaml(`types:
  - sample:
      fields:
        - count:
            type: unsignedinteger
            default_value: -1
`),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("reports a positioned error for a field-shape mismatch", async () => {
    const result = await datasource.validate(
      yaml(
        "types:\n  - user:\n      fields:\n        - email:\n            bogus_field_key: true\n",
      ),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      instancePath: expect.any(String),
    });
  });

  test("reports a type mismatch (scalar where an array is required)", async () => {
    const result = await datasource.validate(yaml("types: not-a-list\n"));
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("an empty document is invalid", async () => {
    const result = await datasource.validate("");
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("reports a positioned parse error for unterminated input", async () => {
    const result = await datasource.validate("foo: [unterminated\n");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      instancePath: "",
      message: expect.any(String),
      line: expect.any(Number),
      col: expect.any(Number),
    });
  });

  test("validateFile reads a valid file from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spec-validate-"));
    try {
      const path = join(dir, "valid.yaml");
      await writeFile(path, yaml(VALID_BODY));
      expect((await datasource.validateFile(path)).valid).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("validateFile reports positioned errors for an invalid file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spec-validate-"));
    try {
      const path = join(dir, "invalid.yaml");
      await writeFile(path, "not_types: 1\n");
      const result = await datasource.validateFile(path);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("other spec validators accept a minimal document", async () => {
    for (const [className, body] of Object.entries(MINIMAL)) {
      const Ctor = ENGINES[className as keyof typeof ENGINES];
      expect((await new Ctor().validate(yaml(body))).valid).toBe(true);
    }
  });

  test("TypesValidator rejects a leftover one_of property", async () => {
    const result = await new TypesValidator().validate(
      yaml("types:\n  - foo:\n      one_of: [a]\n      fields: []\n"),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("RoutesValidator rejects a nested route-shape mismatch", async () => {
    const result = await new RoutesValidator().validate(
      yaml(
        "routes:\n  - custom_route:\n      methods: [GET]\n      path: /x\n      bogus: true\n",
      ),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("every spec validator rejects an empty document", async () => {
    for (const [className] of VALIDATOR_ENGINES) {
      const Ctor = ENGINES[className];
      const result = await new Ctor().validate("");
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});
