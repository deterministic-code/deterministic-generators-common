import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { TypesValidator } from "./TypesValidator.ts";
import { TypesValidator as Engine } from "./TypesValidator.ts";

const MINIMAL = `version: 1.0.0
types:
  - user:
      fields:
        - email:
            type: string
            size: 64
`;

const validator = () => new TypesValidator();

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "types-includes-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("TypesValidator include cycles", () => {
  test("validate() does not resolve file includes", async () => {
    const result = await validator().validate(`version: 1.0.0
includes:
  - file: missing.yaml
types: []
`);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  test("validateFile accepts multiple real parents", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, "identity.yaml"), MINIMAL);
      await writeFile(
        join(dir, "billing.yaml"),
        `version: 1.0.0
types:
  - account:
      fields:
        - name:
            type: string
            size: 32
`,
      );
      const path = join(dir, "types.yaml");
      await writeFile(
        path,
        `version: 1.0.0
includes:
  - file: identity.yaml
  - file: billing.yaml
types:
  - invoice:
      fields:
        - total:
            type: float
`,
      );
      expect((await validator().validateFile(path)).valid).toBe(true);
    });
  });

  test("validateFile rejects a circular include", async () => {
    await withDir(async (dir) => {
      await writeFile(
        join(dir, "parent.yaml"),
        `version: 1.0.0
includes:
  - file: child.yaml
types: []
`,
      );
      const path = join(dir, "child.yaml");
      await writeFile(
        path,
        `version: 1.0.0
includes:
  - file: parent.yaml
types: []
`,
      );
      const result = await validator().validateFile(path);
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.message).toMatch(/circular include:/);
    });
  });

  test("validateFile rejects a missing include file", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "types.yaml");
      await writeFile(
        path,
        `version: 1.0.0
includes:
  - file: nope.yaml
types: []
`,
      );
      const result = await validator().validateFile(path);
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.message).toContain("include file not found");
    });
  });

  test("schema errors win over include checks", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "types.yaml");
      await writeFile(path, "version: 1.0.0\ntypes: not-a-list\n");
      const result = await validator().validateFile(path);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /circular|not found/.test(e.message))).toBe(
        false,
      );
    });
  });

  test("live engine validateFile also walks includes", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "self.yaml");
      await writeFile(
        path,
        `version: 1.0.0
includes:
  - file: self.yaml
types: []
`,
      );
      const result = await new Engine().validateFile(path);
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.message).toMatch(/circular include:/);
    });
  });
});
