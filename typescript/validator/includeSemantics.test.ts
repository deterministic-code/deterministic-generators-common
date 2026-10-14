import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseYamlWithPositions } from "./yamlPositions.ts";
import {
  checkIncludeCycles,
  withIncludeFilePath,
} from "./includeSemantics.ts";
import type { ParsedYaml } from "./SpecValidator.ts";

function parsed(text: string): ParsedYaml {
  const { doc, lineCounter } = parseYamlWithPositions(text);
  return { doc, lineCounter, data: doc.toJS() };
}

const LEAF = `version: 1.0.0
types:
  - user:
      fields:
        - email:
            type: string
            size: 64
`;

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "include-sem-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("withIncludeFilePath", () => {
  test("fills path and directory when options are empty", () => {
    expect(withIncludeFilePath("/tmp/app/types.yaml")).toEqual({
      includeFilePath: "/tmp/app/types.yaml",
      includeBasePath: "/tmp/app",
    });
  });

  test("keeps an explicit includeFilePath and includeBasePath", () => {
    expect(
      withIncludeFilePath("/tmp/app/types.yaml", {
        includeFilePath: "/other/file.yaml",
        includeBasePath: "/other",
        types: "inline",
      }),
    ).toEqual({
      includeFilePath: "/other/file.yaml",
      includeBasePath: "/other",
      types: "inline",
    });
  });
});

describe("checkIncludeCycles", () => {
  test("no-ops without a filesystem context", async () => {
    const doc = parsed(`version: 1.0.0
includes:
  - file: missing.yaml
types: []
`);
    expect(await checkIncludeCycles(doc)).toEqual({ valid: true, errors: [] });
    expect(await checkIncludeCycles(doc, {})).toEqual({
      valid: true,
      errors: [],
    });
  });

  test("accepts a document with no file includes", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "types.yaml");
      const doc = parsed(`version: 1.0.0
includes:
  - id: saved_backend
types: []
`);
      expect(
        await checkIncludeCycles(doc, { includeFilePath: path }),
      ).toEqual({ valid: true, errors: [] });
    });
  });

  test("skips include entries that are not a file path", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "child.yaml");
      const doc = parsed(`version: 1.0.0
includes:
  - []
  - file: 1
  - file: ""
  - uuid: 11111111-1111-1111-1111-111111111111
types: []
`);
      expect(
        await checkIncludeCycles(doc, { includeFilePath: path }),
      ).toEqual({ valid: true, errors: [] });
    });
  });

  test("accepts a single parent file", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, "identity.yaml"), LEAF);
      const path = join(dir, "child.yaml");
      const doc = parsed(`version: 1.0.0
includes:
  - file: identity.yaml
types: []
`);
      expect(
        await checkIncludeCycles(doc, { includeFilePath: path }),
      ).toEqual({ valid: true, errors: [] });
    });
  });

  test("accepts multiple parents and a recursive chain", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, "a.yaml"), LEAF);
      await writeFile(
        join(dir, "b.yaml"),
        `version: 1.0.0
includes:
  - file: a.yaml
types: []
`,
      );
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
      const path = join(dir, "child.yaml");
      const doc = parsed(`version: 1.0.0
includes:
  - file: b.yaml
  - file: billing.yaml
types: []
`);
      expect(
        await checkIncludeCycles(doc, { includeFilePath: path }),
      ).toEqual({ valid: true, errors: [] });
    });
  });

  test("accepts a diamond include (shared grandchild is not a cycle)", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, "d.yaml"), LEAF);
      await writeFile(
        join(dir, "b.yaml"),
        `version: 1.0.0
includes:
  - file: d.yaml
types: []
`,
      );
      await writeFile(
        join(dir, "c.yaml"),
        `version: 1.0.0
includes:
  - file: d.yaml
types: []
`,
      );
      const path = join(dir, "a.yaml");
      const doc = parsed(`version: 1.0.0
includes:
  - file: b.yaml
  - file: c.yaml
types: []
`);
      expect(
        await checkIncludeCycles(doc, { includeFilePath: path }),
      ).toEqual({ valid: true, errors: [] });
    });
  });

  test("accepts the same parent listed twice", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, "identity.yaml"), LEAF);
      const path = join(dir, "child.yaml");
      const doc = parsed(`version: 1.0.0
includes:
  - file: identity.yaml
  - file: ./identity.yaml
types: []
`);
      expect(
        await checkIncludeCycles(doc, { includeFilePath: path }),
      ).toEqual({ valid: true, errors: [] });
    });
  });

  test("resolves includes from includeBasePath when includeFilePath is omitted", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, "identity.yaml"), LEAF);
      const doc = parsed(`version: 1.0.0
includes:
  - file: identity.yaml
types: []
`);
      expect(
        await checkIncludeCycles(doc, { includeBasePath: dir }),
      ).toEqual({ valid: true, errors: [] });
    });
  });

  test("rejects a self-include", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "self.yaml");
      const doc = parsed(`version: 1.0.0
includes:
  - file: self.yaml
types: []
`);
      const result = await checkIncludeCycles(doc, { includeFilePath: path });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatchObject({
        instancePath: "/includes/0/file",
        message: expect.stringMatching(/circular include: self\.yaml → self\.yaml/),
      });
    });
  });

  test("rejects a two-node cycle", async () => {
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
      const doc = parsed(`version: 1.0.0
includes:
  - file: parent.yaml
types: []
`);
      const result = await checkIncludeCycles(doc, { includeFilePath: path });
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.message).toMatch(
        /circular include: child\.yaml → parent\.yaml → child\.yaml/,
      );
    });
  });

  test("rejects a three-node cycle and keeps the root include path", async () => {
    await withDir(async (dir) => {
      await writeFile(
        join(dir, "b.yaml"),
        `version: 1.0.0
includes:
  - file: c.yaml
types: []
`,
      );
      await writeFile(
        join(dir, "c.yaml"),
        `version: 1.0.0
includes:
  - file: a.yaml
types: []
`,
      );
      const path = join(dir, "a.yaml");
      const doc = parsed(`version: 1.0.0
includes:
  - id: skip-me
  - file: b.yaml
types: []
`);
      const result = await checkIncludeCycles(doc, { includeFilePath: path });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatchObject({
        instancePath: "/includes/1/file",
        message: expect.stringMatching(
          /circular include: a\.yaml → b\.yaml → c\.yaml → a\.yaml/,
        ),
      });
    });
  });

  test("rejects a missing include file", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "child.yaml");
      const doc = parsed(`version: 1.0.0
includes:
  - file: nope.yaml
types: []
`);
      const result = await checkIncludeCycles(doc, { includeFilePath: path });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatchObject({
        instancePath: "/includes/0/file",
        message: "include file not found: nope.yaml",
      });
    });
  });

  test("rejects an include that is a directory", async () => {
    await withDir(async (dir) => {
      await mkdir(join(dir, "nested"));
      const path = join(dir, "child.yaml");
      const doc = parsed(`version: 1.0.0
includes:
  - file: nested
types: []
`);
      const result = await checkIncludeCycles(doc, { includeFilePath: path });
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.message).toMatch(/cannot read include nested:/);
    });
  });

  test("rejects an include that is not valid YAML", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, "bad.yaml"), "foo: [unterminated\n");
      const path = join(dir, "child.yaml");
      const doc = parsed(`version: 1.0.0
includes:
  - file: bad.yaml
types: []
`);
      const result = await checkIncludeCycles(doc, { includeFilePath: path });
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.message).toMatch(/include is not valid YAML:/);
    });
  });

  test("rejects an include that is not a mapping", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, "list.yaml"), "- just a list\n");
      await writeFile(join(dir, "scalar.yaml"), "42\n");
      const path = join(dir, "child.yaml");
      const doc = parsed(`version: 1.0.0
includes:
  - file: list.yaml
  - file: scalar.yaml
types: []
`);
      const result = await checkIncludeCycles(doc, { includeFilePath: path });
      expect(result.valid).toBe(false);
      expect(
        result.errors.map((e) => e.message),
      ).toEqual([
        "include must be a mapping: list.yaml",
        "include must be a mapping: scalar.yaml",
      ]);
    });
  });

  test("reports a missing nested include against the root entry", async () => {
    await withDir(async (dir) => {
      await writeFile(
        join(dir, "mid.yaml"),
        `version: 1.0.0
includes:
  - file: missing.yaml
types: []
`,
      );
      const path = join(dir, "child.yaml");
      const doc = parsed(`version: 1.0.0
includes:
  - file: mid.yaml
types: []
`);
      const result = await checkIncludeCycles(doc, { includeFilePath: path });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatchObject({
        instancePath: "/includes/0/file",
        message: "include file not found: missing.yaml",
      });
    });
  });

  test("falls back when the includeFilePath directory does not exist", async () => {
    const doc = parsed(`version: 1.0.0
includes:
  - file: nope.yaml
types: []
`);
    const result = await checkIncludeCycles(doc, {
      includeFilePath: "/no/such/include-root/child.yaml",
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toBe("include file not found: nope.yaml");
  });

  test("skips includes when the root document has no includes array", async () => {
    await withDir(async (dir) => {
      const path = join(dir, "child.yaml");
      expect(
        await checkIncludeCycles(parsed("version: 1.0.0\ntypes: []\n"), {
          includeFilePath: path,
        }),
      ).toEqual({ valid: true, errors: [] });
    });
  });
});
