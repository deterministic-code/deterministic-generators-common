import { describe, expect, test } from "vitest";
import { SpecValidator } from "./index.ts";
import { resolveSpecPath } from "./resolveSpecPath.ts";
import {
  errorFromUnknown,
  formatAjvError,
  resolveAjvCtor,
  yamlErrorOffset,
} from "./SpecValidator.ts";

const VALID = `version: 1.0.0
types:
  - user:
      fields:
        - email:
            type: string
`;

describe("yamlErrorOffset / resolveAjvCtor / formatAjvError / errorFromUnknown", () => {
  class FakeAjv {
    opts: unknown;
    constructor(opts: unknown) {
      this.opts = opts;
    }
    compile(): () => boolean {
      return () => true;
    }
  }

  test("yamlErrorOffset uses the first pos entry or 0", () => {
    expect(yamlErrorOffset([12, 15])).toBe(12);
    expect(yamlErrorOffset(undefined)).toBe(0);
    expect(yamlErrorOffset(null)).toBe(0);
  });

  test("resolveAjvCtor prefers a default export, else the module itself", () => {
    expect(resolveAjvCtor({ default: FakeAjv })).toBe(FakeAjv);
    expect(resolveAjvCtor(FakeAjv)).toBe(FakeAjv);
  });

  test.each([
    [
      { keyword: "type", instancePath: "", message: "must be string" },
      "(root) must be string",
    ],
    [
      {
        keyword: "additionalProperties",
        instancePath: "/x",
        message: "must NOT have additional properties",
        params: { additionalProperty: "bogus" },
      },
      "/x must NOT have additional properties (property: bogus)",
    ],
    [
      {
        keyword: "required",
        instancePath: "/x",
        message: "must have required property 'fields'",
        params: { missingProperty: "fields" },
      },
      "/x must have required property 'fields' (missing: fields)",
    ],
    [
      {
        keyword: "enum",
        instancePath: "/x",
        message: "must be equal to one of the allowed values",
        params: { allowedValues: ["a", "b"] },
      },
      "/x must be equal to one of the allowed values (allowed: a, b)",
    ],
    [
      {
        keyword: "type",
        instancePath: "/x",
        message: "must be string",
        params: {},
      },
      "/x must be string",
    ],
    [
      {
        keyword: "additionalProperties",
        instancePath: "/x",
        message: "must NOT have additional properties",
        params: { additionalProperty: "" },
      },
      "/x must NOT have additional properties",
    ],
    [
      {
        keyword: "not",
        instancePath: "/types/0/person/fields/0/id/is_id",
        message: "must NOT be valid",
      },
      "/types/0/person/fields/0/id/is_id ids and is_id are mutually exclusive",
    ],
  ] as const)("formatAjvError %#", (error, expected) => {
    expect(formatAjvError(error)).toBe(expected);
  });

  test("errorFromUnknown uses Error.message or String() for other values", () => {
    expect(errorFromUnknown(new Error("boom"))).toBe("boom");
    expect(errorFromUnknown("nope")).toBe("nope");
  });
});

describe("SpecValidator constructed with an absolute spec path", () => {
  test("validates against that spec and reuses the compiled schema", async () => {
    const specPath = await resolveSpecPath("backend", "types.spec.yaml");
    const validator = new SpecValidator(specPath);
    const first = await validator.validate(VALID);
    const second = await validator.validate(VALID);
    expect(first).toEqual({ valid: true, errors: [] });
    expect(second).toEqual({ valid: true, errors: [] });
  });

  test("accepts a path thunk", async () => {
    const specPath = await resolveSpecPath("backend", "types.spec.yaml");
    const validator = new SpecValidator(async () => specPath);
    expect(await validator.validate(VALID)).toEqual({
      valid: true,
      errors: [],
    });
  });
});

describe("SpecValidator constructed with a spec ref", () => {
  test("resolves the live types spec", async () => {
    const result = await new SpecValidator({
      subdir: "backend",
      name: "types.spec.yaml",
    }).validate(VALID);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("surfaces a missing spec file", async () => {
    const result = await new SpecValidator({
      subdir: "backend",
      name: "does-not-exist.spec.yaml",
    }).validate("version: 1.0.0\ntypes: []\n");
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/spec file not found/);
  });
});
