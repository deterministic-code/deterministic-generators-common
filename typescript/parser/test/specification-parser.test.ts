import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { memoryReader } from "../deterministic-reader.ts";
import { DeterministicParser } from "../parser/specification-parser.ts";

const serviceClassName = (entity: string) => `${entity}_service`;

describe("DeterministicParser", () => {
  it("returns types, datasource, service, and route objects", async () => {
    const spec = await DeterministicParser(
      memoryReader({
        "types.yaml": `types:
  - user:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - email:
            type: string
        - role_id:
            references: role.id
            type: integer
  - role:
      tags: [datasource_type]
      inherits: set
      fields:
        - code:
            type: string
`,
        "datasource.yaml": `includes:
  - types:
      filter: tag == "datasource_type"
types:
  - user:
      fields:
        - email:
            is_unique: true
  - role: {}
`,
        "services.yaml": `includes:
  - types:
      filter: tag == "datasource_type" || tag == "view_type"
services: []
`,
        "routes.yaml": `includes:
  - types:
      filter: tag == "view_type"
routes: []
`,
      }),
    ).parse({}, { serviceClassName });
    const user = spec.expandedTypes.find((t) => t.name === "user");
    assert.equal(user?.fields.find((f) => f.name === "role_id")?.type, "integer");
    assert.ok(spec.types.some((t) => t.name === "user"));
    assert.ok(spec.datasource.some((t) => t.name === "user"));
    assert.ok(spec.services.generics.some((g) => g.name === "user"));
    assert.equal(spec.routes.customs[0]?.name, "getHealth");
    assert.ok(spec.routes.candidates.some((c) => c.name === "user"));
  });
});
