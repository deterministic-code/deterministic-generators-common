import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { fileReader, memoryReader } from "../deterministic-reader.ts";

describe("memoryReader", () => {
  it("throws when a file is missing", async () => {
    const reader = memoryReader({ "present.yaml": "ok" });
    assert.equal(await reader.exists("present.yaml"), true);
    assert.equal(await reader.exists("missing.yaml"), false);
    assert.equal(await reader.read("present.yaml"), "ok");
    await assert.rejects(
      () => reader.read("missing.yaml"),
      /deterministic reader: missing missing\.yaml/,
    );
  });
});

describe("fileReader", () => {
  it("reads and probes files on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deterministic-reader-"));
    await writeFile(join(dir, "present.yaml"), "ok\n");
    const reader = fileReader(dir);
    assert.equal(await reader.exists("present.yaml"), true);
    assert.equal(await reader.exists("missing.yaml"), false);
    assert.equal(await reader.read("present.yaml"), "ok\n");
    await assert.rejects(
      () => reader.read("missing.yaml"),
      new RegExp(`deterministic reader: missing missing\\.yaml in ${dir}`),
    );
  });
});
