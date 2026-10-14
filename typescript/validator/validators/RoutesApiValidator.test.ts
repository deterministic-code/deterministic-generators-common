import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { RoutesApiValidator } from "../index.ts";
import { findAncestorPath } from "../resolveSpecPath.ts";

const MINIMAL = `version: 1.0.0
routes: []
components: {}
`;

const validator = () => new RoutesApiValidator();

describe("RoutesApiValidator", () => {
  test("validate accepts a minimal document", async () => {
    expect(await validator().validate(MINIMAL)).toEqual({
      valid: true,
      errors: [],
    });
  });

  test("validateFile accepts the kitchen-sink sample", async () => {
    const samples = await findAncestorPath("samples/valid");
    if (!samples) throw new Error("samples/valid not found");
    const path = join(dirname(samples), "valid", "routes_api.yaml");
    expect(await validator().validateFile(path)).toEqual({
      valid: true,
      errors: [],
    });
  });

  test("validate rejects a missing components map", async () => {
    const result = await validator().validate(
      "version: 1.0.0\nroutes: []\n",
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /components/.test(e.message))).toBe(true);
  });

  test("validate rejects a duplicate route name", async () => {
    const result = await validator().validate(`version: 1.0.0
routes:
  - health:
      path: /api/health
      method: GET
      entity: null
      isCustom: true
  - health:
      path: /api/health
      method: GET
      entity: null
      isCustom: true
components: {}
`);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /duplicate route/.test(e.message))).toBe(
      true,
    );
  });
});
