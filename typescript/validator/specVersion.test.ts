import { VALIDATOR_ENGINES, isSpecRef } from "./specVersion.ts";
import { describe, expect, test } from "vitest";

describe("catalog", () => {
  test("named engines are listed", () => {
    expect(VALIDATOR_ENGINES.map(([className]) => className)).toEqual([
      "TypesValidator",
      "DatasourceValidator",
      "DatasourceSeedsValidator",
      "RoutesValidator",
      "RoutesApiValidator",
      "ServicesValidator",
      "FrontendBindingsValidator",
    ]);
  });
});

describe("isSpecRef", () => {
  test("requires string subdir and name", () => {
    expect(isSpecRef({ subdir: "backend", name: "x.spec.yaml" })).toBe(true);
    expect(isSpecRef({ subdir: "backend", name: "x.spec.yaml", version: "1.0.0" })).toBe(
      true,
    );
    expect(isSpecRef(null)).toBe(false);
    expect(isSpecRef("backend")).toBe(false);
    expect(isSpecRef({ subdir: 1, name: "x" })).toBe(false);
    expect(isSpecRef({ subdir: "backend", name: 1 })).toBe(false);
    expect(isSpecRef({ subdir: "backend" })).toBe(false);
  });
});
