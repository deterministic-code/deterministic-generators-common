import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  RoutesValidator,
  ServicesValidator,
  TypesValidator,
} from "./index.ts";
import { RoutesValidator as RoutesEngine } from "./validators/RoutesValidator.ts";
import { ServicesValidator as ServicesEngine } from "./validators/ServicesValidator.ts";
import { TypesValidator as TypesEngine } from "./validators/TypesValidator.ts";

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "inc-other-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("file: include cycles on types, routes, and services", () => {
  test("TypesValidator validateFile rejects a circular include", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "types.yaml");
      await writeFile(
        path,
        `version: 1.0.0
includes:
  - file: types.yaml
types: []
`,
      );
      const result = await new TypesValidator().validateFile(path);
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.message).toMatch(/circular include:/);
    });
  });

  test("RoutesValidator validateFile rejects a missing include file", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "routes.yaml");
      await writeFile(
        path,
        `version: 1.0.0
includes:
  - file: nope.yaml
routes: []
`,
      );
      const result = await new RoutesValidator().validateFile(path);
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.message).toContain("include file not found");
    });
  });

  test("ServicesValidator validateFile accepts a real parent include", async () => {
    await withDir(async (dir) => {
      await writeFile(
        join(dir, "base.yaml"),
        `version: 1.0.0
services: []
`,
      );
      const path = join(dir, "services.yaml");
      await writeFile(
        path,
        `version: 1.0.0
includes:
  - file: base.yaml
services: []
`,
      );
      expect((await new ServicesValidator().validateFile(path)).valid).toBe(
        true,
      );
    });
  });

  test("in-memory validate() still skips file includes", async () => {
    const result = await new TypesValidator().validate(`version: 1.0.0
includes:
  - file: missing.yaml
types: []
`);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("live engines walk includes from validateFile", async () => {
    await withDir(async (dir) => {
      const typesPath = join(dir, "types.yaml");
      await writeFile(
        typesPath,
        `version: 1.0.0
includes:
  - file: types.yaml
types: []
`,
      );
      expect((await new TypesEngine().validateFile(typesPath)).valid).toBe(false);

      const routePath = join(dir, "routes.yaml");
      await writeFile(
        routePath,
        `version: 1.0.0
includes:
  - file: missing.yaml
routes: []
`,
      );
      expect((await new RoutesEngine().validateFile(routePath)).valid).toBe(
        false,
      );

      await writeFile(join(dir, "base.yaml"), "version: 1.0.0\nservices: []\n");
      const svcPath = join(dir, "services.yaml");
      await writeFile(
        svcPath,
        `version: 1.0.0
includes:
  - file: base.yaml
services: []
`,
      );
      expect((await new ServicesEngine().validateFile(svcPath)).valid).toBe(
        true,
      );
    });
  });
});
