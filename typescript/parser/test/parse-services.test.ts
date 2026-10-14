import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { memoryReader } from "../deterministic-reader.ts";
import { DeterministicParser } from "../parser/specification-parser.ts";

const parse = (files: Record<string, string>) =>
  DeterministicParser(memoryReader(files)).parse({});

describe("parse services.yaml", () => {
  it("filters types and collects custom service functions", async () => {
    const spec = await parse({
      "types.yaml": `types:
  - user:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - email:
            type: string
  - health:
      tags: [view_type]
      fields:
        - ok:
            type: boolean
`,
      "datasource.yaml": `types:
  - user:
      fields:
        - email:
            is_unique: true
`,
      "services.yaml": `includes:
  - types:
      filter: tag == "datasource_type"
services:
  - name: HealthService
    description: Liveness
    module: ./services/health
`,
      "routes.yaml": `routes:
  - custom_get:
      path: /api/health
      method: GET
      service: HealthService
      function: check
`,
    });
    assert.deepEqual(
      spec.services.generics.map((g) => g.name),
      ["user"],
    );
    assert.ok(spec.services.generics[0]?.byFields.some((f) => f.field === "email"));
    const health = spec.services.customs.find((s) => s.name === "HealthService");
    assert.deepEqual(health?.methods, ["check"]);
  });
});
