import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  findAncestorPath,
  findSpecPath,
  resolveSpecPath,
  specRelPath,
} from "./resolveSpecPath.ts";
import { SPEC_FILES } from "./specVersion.ts";

describe("specRelPath", () => {
  test("joins subdir and name", () => {
    expect(specRelPath("backend", "routes.spec.yaml")).toBe(
      join("backend", "routes.spec.yaml"),
    );
    expect(specRelPath("frontend", "bindings.spec.yaml")).toBe(
      join("frontend", "bindings.spec.yaml"),
    );
  });
});

describe("findSpecPath", () => {
  test("resolves a bundled backend spec to a readable file", async () => {
    const path = await findSpecPath("backend", "routes.spec.yaml");
    expect(path).not.toBeNull();
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(path!, "utf8");
    expect(text).toContain("$schema");
  });

  test("resolves a bundled frontend spec", async () => {
    const path = await findSpecPath("frontend", "bindings.spec.yaml");
    expect(path).not.toBeNull();
  });

  test("returns null for an unknown spec", async () => {
    expect(await findSpecPath("backend", "does-not-exist.spec.yaml")).toBeNull();
  });

  test("returns a candidate that lives under an ancestor directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "has-spec-"));
    try {
      await mkdir(join(dir, "backend"));
      const spec = join(dir, "backend", "types.spec.yaml");
      await writeFile(spec, "x\n");
      expect(
        await findAncestorPath(
          join("backend", "types.spec.yaml"),
          join(dir, "nested", "deeper"),
        ),
      ).toBe(spec);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns null when walking from a tree that has no specs", async () => {
    expect(
      await findSpecPath("backend", "routes.spec.yaml", tmpdir()),
    ).toBeNull();
  });
});

describe("findAncestorPath", () => {
  test("returns null when the relative path is never found", async () => {
    expect(await findAncestorPath("no-such-rel-path-xyz", tmpdir())).toBeNull();
  });
});

describe("resolveSpecPath", () => {
  test("returns the path for a known spec", async () => {
    await expect(
      resolveSpecPath("backend", "services.spec.yaml"),
    ).resolves.toContain("services.spec.yaml");
  });

  test("throws for an unknown spec", async () => {
    await expect(
      resolveSpecPath("backend", "nope.spec.yaml"),
    ).rejects.toThrow(/spec file not found: backend[/\\]nope\.spec\.yaml/);
  });

  test("throws when walking from a tree that has no specs", async () => {
    await expect(
      resolveSpecPath("backend", "routes.spec.yaml", tmpdir()),
    ).rejects.toThrow(/spec file not found/);
  });
});

describe("live spec completeness", () => {
  test("every catalogued spec is readable", async () => {
    for (const spec of SPEC_FILES) {
      await expect(resolveSpecPath(spec.subdir, spec.name)).resolves.toContain(
        spec.name,
      );
    }
  });

  test("backend and frontend spec directories exist", async () => {
    const backend = await findAncestorPath(join("backend", "types.spec.yaml"));
    const frontend = await findAncestorPath(join("frontend", "bindings.spec.yaml"));
    expect(backend).not.toBeNull();
    expect(frontend).not.toBeNull();
    await access(backend!);
    const names = (await readdir(join(backend!, ".."))).filter((f) =>
      f.endsWith(".spec.yaml"),
    );
    expect(names.length).toBeGreaterThan(0);
  });
});
