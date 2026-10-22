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

  it("keeps authored include_in_create on the overlay", async () => {
    const det = await parse({
      "types.yaml": `types:
  - user:
      tags: [datasource_type]
      fields:
        - email:
            type: string
        - created:
            type: datetime
`,
      "datasource.yaml": `includes:
  - types:
      filter: tag == "datasource_type"
types:
  - user:
      fields:
        - created:
            include_in_create: false
`,
    });
    const created = det.datasource
      .find((t) => t.name === "user")
      ?.fields.find((f) => f.name === "created");
    assert.equal(created?.includeInCreate, false);
    assert.equal(created?.includeInUpdate, undefined);
  });

  it("merges ancestor write inclusion onto a filtered child table", async () => {
    const det = await parse({
      "types.yaml": `types:
  - base:
      fields:
        - created:
            type: datetime
        - updated:
            type: datetime
        - stamp:
            type: datetime
        - name:
            type: string
  - item:
      tags: [datasource_type]
      inherits: base
      fields: []
`,
      "datasource.yaml": `includes:
  - types:
      filter: tag == "datasource_type"
types:
  - base:
      fields:
        - created:
            include_in_create: false
            include_in_update: false
        - updated:
            include_in_update: false
        - stamp:
            include_in_create: false
`,
    });
    assert.deepEqual(
      det.datasource.map((t) => t.name),
      ["item"],
    );
    const created = det.datasource[0]?.fields.find((f) => f.name === "created");
    const updated = det.datasource[0]?.fields.find((f) => f.name === "updated");
    const stamp = det.datasource[0]?.fields.find((f) => f.name === "stamp");
    assert.equal(created?.includeInCreate, false);
    assert.equal(created?.includeInUpdate, false);
    assert.equal(updated?.includeInUpdate, false);
    assert.equal(stamp?.includeInCreate, false);
  });

  it("lets a child overlay win per key and leaves other overlay keys local", async () => {
    const det = await parse({
      "types.yaml": `types:
  - base:
      fields:
        - key:
            type: string
  - item:
      tags: [datasource_type]
      inherits: base
      fields: []
`,
      "datasource.yaml": `includes:
  - types:
      filter: tag == "datasource_type"
types:
  - base:
      fields:
        - key:
            include_in_create: false
            include_in_update: false
            is_fixed_id: true
  - item:
      fields:
        - key:
            include_in_create: true
`,
    });
    const key = det.datasource
      .find((t) => t.name === "item")
      ?.fields.find((f) => f.name === "key");
    assert.equal(key?.includeInCreate, true);
    assert.equal(key?.includeInUpdate, false);
    assert.equal(key?.isFixedId, undefined);
  });

  it("merges overlays for a table that is not in types.yaml", async () => {
    const det = await parse({
      "types.yaml": `types: []
`,
      "datasource.yaml": `types:
  - ghost: {}
`,
    });
    assert.deepEqual(
      det.datasource.map((t) => t.name),
      ["ghost"],
    );
  });

  it("does not put include_in_create on TypeField", async () => {
    const det = await parse({
      "types.yaml": `types:
  - user:
      tags: [datasource_type]
      fields:
        - created:
            type: datetime
            include_in_create: false
            include_in_update: false
`,
    });
    const created = det.types
      .find((t) => t.name === "user")
      ?.fields.find((f) => f.name === "created");
    assert.ok(created);
    assert.equal("includeInCreate" in created!, false);
    assert.equal("includeInUpdate" in created!, false);
    assert.equal("include_in_create" in created!, false);
  });
});
