import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { DeterministicParser } from "../parser/specification-parser.ts";
import { memoryReader } from "../deterministic-reader.ts";

const parse = (files: Record<string, string>) =>
  DeterministicParser(memoryReader(files)).parse({});

describe("parse datasource.yaml", () => {
  it("reads overlays, uniqueness, identity, and indexes", async () => {
    const det = await parse({
      "types.yaml": `types:
  - user:
      tags: [datasource_type]
      inherits: set
      fields:
        - email:
            type: string
  - note:
      tags: [datasource_type]
      fields:
        - body:
            type: string
`,
      "datasource.yaml": `includes:
  - types:
      filter: tag == "datasource_type"
types:
  - user:
      mapping: users
      use_optimistic_concurrency: true
      fields:
        - email:
            is_unique: true
            mapping: email_address
        - updated:
            is_optimistic_concurrency: true
        - version:
            is_optimistic_concurrency: false
            use_native_row_version: false
      indexes:
        - email_uidx:
            fields: [email]
            is_unique: true
  - note: {}
`,
    });
    assert.equal(det.datasource.length, 2);
    const user = det.datasource.find((t) => t.name === "user");
    assert.equal(user?.mapping, "users");
    assert.equal(user?.useOptimisticConcurrency, true);
    assert.equal(user?.fields[0]?.isUnique, true);
    assert.equal(user?.fields[0]?.mapping, "email_address");
    assert.equal(user?.fields[1]?.isOptimisticConcurrency, true);
    assert.equal(user?.fields[2]?.useNativeRowVersion, false);
    assert.deepEqual(user?.uniqueIndexFields, ["email"]);
    assert.ok(det.datasource.some((t) => t.name === "note"));
  });

  it("selects tables with the types filter", async () => {
    const det = await parse({
      "types.yaml": `types:
  - user:
      tags: [datasource_type]
      fields:
        - email:
            type: string
  - legacy:
      tags: [datasource_type]
      fields:
        - n:
            type: integer
  - person:
      tags: [view_type]
      fields: []
`,
      "datasource.yaml": `includes:
  - types:
      filter: tag == "datasource_type" && type != "legacy"
types: []
`,
    });
    assert.deepEqual(
      det.datasource.map((t) => t.name),
      ["user"],
    );
  });
});
