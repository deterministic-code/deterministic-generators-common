import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { fromSettings } from "../settings.ts";

describe("fromSettings", () => {
  it("defaults schemaVersion to 1.0 and createIndex on", () => {
    const settings = fromSettings({});
    assert.equal(settings.applicationName, "generated-frontend");
    assert.equal(settings.schemaVersion, "1.0");
    assert.equal(settings.createIndex, true);
    assert.equal(settings.libraryReferenceMode, undefined);
  });

  it("reads applicationName and falls back when blank", () => {
    assert.equal(
      fromSettings({ application_name: "catalog-ui" }).applicationName,
      "catalog-ui",
    );
    assert.equal(
      fromSettings({ application_name: "" }).applicationName,
      "generated-frontend",
    );
  });

  it("defaults frontendFramework to vite", () => {
    assert.equal(fromSettings({}).frontendFramework, "vite");
    assert.equal(
      fromSettings({ frontend_generate_framework: "" }).frontendFramework,
      "vite",
    );
    assert.equal(
      fromSettings({ frontend_generate_framework: "next" }).frontendFramework,
      "next",
    );
    assert.equal(fromSettings({}).fullStack, false);
    assert.equal(
      fromSettings({ application_tier: "full-stack" }).fullStack,
      true,
    );
  });

  it("rejects an unknown frontend_generate_framework", () => {
    assert.throws(
      () => fromSettings({ frontend_generate_framework: "remix" }),
      /settings\.frontend_generate_framework must be "vite", "next", "svelte", "angular"/,
    );
  });

  it("reads schemaVersion and libraryReferenceMode", () => {
    const settings = fromSettings({
      "codegen.schema_version": "9.9",
      "languages.typescript.library_reference_mode": "bundled",
    });
    assert.equal(settings.schemaVersion, "9.9");
    assert.equal(settings.libraryReferenceMode, "bundled");
  });

  it("createIndex is off only when codegen.create_index is false", () => {
    assert.equal(fromSettings({}).createIndex, true);
    assert.equal(
      fromSettings({ "codegen.create_index": "true" }).createIndex,
      true,
    );
    assert.equal(
      fromSettings({ "codegen.create_index": "false" }).createIndex,
      false,
    );
  });

  it("comments=simple and unset emit simpleDoc", () => {
    assert.equal(fromSettings({}).simpleDoc, true);
    assert.equal(fromSettings({}).descriptionDoc, false);
    assert.equal(fromSettings({ comments: "simple" }).simpleDoc, true);
    assert.equal(fromSettings({ comments: "simple" }).descriptionDoc, false);
  });

  it("comments=description emits descriptionDoc", () => {
    const settings = fromSettings({ comments: "description" });
    assert.equal(settings.simpleDoc, false);
    assert.equal(settings.descriptionDoc, true);
  });

  it("comments=none omits both doc flags", () => {
    const settings = fromSettings({ comments: "none" });
    assert.equal(settings.simpleDoc, false);
    assert.equal(settings.descriptionDoc, false);
  });
});
