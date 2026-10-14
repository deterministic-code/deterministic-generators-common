import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import * as validators from "./index.ts";
import {
  DatasourceSeedsValidator,
  DatasourceValidator,
  FrontendBindingsValidator,
  RoutesApiValidator,
  RoutesValidator,
  ServicesValidator,
  TypesValidator,
} from "./index.ts";

const VALID = `version: 1.0.0
types:
  - user:
      fields:
        - email:
            type: string
`;

const MINIMAL: Record<string, string> = {
  DatasourceSeedsValidator: "version: 1.0.0\nseeds: []\n",
  DatasourceValidator: "version: 1.0.0\ntypes: []\n",
  ServicesValidator: "version: 1.0.0\nservices: []\n",
  RoutesValidator: "version: 1.0.0\nroutes: []\n",
  RoutesApiValidator: "version: 1.0.0\nroutes: []\ncomponents: {}\n",
  FrontendBindingsValidator: "version: 1.0.0\ndatasources: []\n",
};

describe("live validator facades", () => {
  test("exposes only validate entry points as values", () => {
    expect(Object.keys(validators).sort()).toEqual([
      "DatasourceSeedsValidator",
      "DatasourceValidator",
      "FrontendBindingsValidator",
      "RoutesApiValidator",
      "RoutesValidator",
      "ServicesValidator",
      "SpecValidator",
      "TypesValidator",
    ]);
  });

  test("accepts a valid types document", async () => {
    expect(await new TypesValidator().validate(VALID)).toEqual({
      valid: true,
      errors: [],
    });
  });

  test("rejects a missing version via JSON Schema", async () => {
    const result = await new TypesValidator().validate("types: []\n");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      message: expect.stringMatching(/required property 'version'|missing required property version/),
    });
  });

  test("rejects a non-mapping document", async () => {
    const result = await new TypesValidator().validate("- just a list\n");
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/must be/);
  });

  test("rejects a malformed version token via JSON Schema", async () => {
    const result = await new TypesValidator().validate(
      "version: latest\ntypes: []\n",
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/must match|pattern|semver/i);
  });

  test("reports YAML syntax errors", async () => {
    const result = await new TypesValidator().validate("foo: [unterminated\n");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({
      instancePath: "",
      message: expect.any(String),
    });
  });

  test("validateFile reads from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "facade-"));
    try {
      const path = join(dir, "ok.yaml");
      await writeFile(path, VALID);
      expect((await new TypesValidator().validateFile(path)).valid).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("other facades accept a minimal document", async () => {
    expect(
      (await new DatasourceSeedsValidator().validate(MINIMAL.DatasourceSeedsValidator))
        .valid,
    ).toBe(true);
    expect(
      (await new DatasourceValidator().validate(MINIMAL.DatasourceValidator)).valid,
    ).toBe(true);
    expect(
      (await new ServicesValidator().validate(MINIMAL.ServicesValidator)).valid,
    ).toBe(true);
    expect(
      (await new RoutesValidator().validate(MINIMAL.RoutesValidator)).valid,
    ).toBe(true);
    expect(
      (await new RoutesApiValidator().validate(MINIMAL.RoutesApiValidator)).valid,
    ).toBe(true);
    expect(
      (
        await new FrontendBindingsValidator().validate(
          MINIMAL.FrontendBindingsValidator,
        )
      ).valid,
    ).toBe(true);
  });
});
