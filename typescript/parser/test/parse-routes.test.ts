import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { memoryReader } from "../deterministic-reader.ts";
import {
  DeterministicParser,
  inheritsChain,
} from "../parser/specification-parser.ts";
import type { Type } from "../specification.ts";

const parse = (files: Record<string, string>) =>
  DeterministicParser(memoryReader(files)).parse({});

const TYPES = `types:
  - user:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - email:
            type: string
        - reports:
            type: person[]
            references: person.user_id
  - person:
      tags: [view_type]
      inherits: user
      fields:
        - user_id:
            references: user.id
            type: integer
  - link:
      tags: [datasource_type, many_to_many]
      fields:
        - left_id:
            references: user.id
            type: integer
        - right_id:
            references: role.id
            type: integer
  - role:
      tags: [datasource_type]
      inherits: set
      fields: []
`;

describe("parse routes.yaml", () => {
  it("filters candidates, attaches eager overlays, and reads function", async () => {
    const spec = await parse({
      "types.yaml": TYPES,
      "datasource.yaml": `types:
  - user:
      fields:
        - email:
            is_unique: true
`,
      "routes.yaml": `includes:
  - types:
      filter: tag == "view_type"
combined_routes:
  - user:
      route: /api/users
      combines:
        - person:
            via: link
            target: role
            route: /api/users/:id/roles
routes:
  - user:
      eager_read_path:
        - reports
      eager_update_path:
        - reports
      eager_read_member_only:
        - reports
  - get_users_by_email
  - custom_post:
      path: /api/people
      method: POST
      service: PersonService
      function: create
`,
    });
    const user = spec.routes.candidates.find((c) => c.name === "user");
    assert.ok(user);
    assert.deepEqual(user?.eagerReadPath, ["reports"]);
    assert.ok(user?.byFields.some((f) => f.byField === "email"));
    assert.equal(spec.routes.customs.some((c) => c.path === "/api/people"), true);
    assert.equal(spec.routes.nested[0]?.kind, "m2m");
  });

  it("detects a direct FK child", async () => {
    const spec = await parse({
      "types.yaml": TYPES,
      "routes.yaml": `includes:
  - types:
      filter: tag == "view_type"
combined_routes:
  - user:
      route: /api/users
      combines:
        - person
routes: []
`,
    });
    assert.equal(spec.routes.nested[0]?.kind, "direct-fk");
    assert.ok(spec.routes.childrenOnly.has("person"));
  });

  it("matches a direct FK when the parent view inherits the referenced type", async () => {
    const spec = await parse({
      "types.yaml": `types:
  - contacts_base:
      tags: [datasource_type]
      inherits: set
      fields: []
  - addresses_base:
      tags: [datasource_type]
      inherits: set
      fields:
        - contact_id:
            type: integer
            references: contacts_base.id
  - contact:
      tags: [view_type]
      inherits: contacts_base
      fields: []
  - address:
      tags: [view_type]
      inherits: addresses_base
      fields: []
`,
      "routes.yaml": `combined_routes:
  - contact:
      route: /api/contacts
      combines:
        - address
routes: []
`,
    });
    assert.equal(spec.routes.nested[0]?.kind, "direct-fk");
    assert.equal(
      spec.routes.nested[0] && spec.routes.nested[0].kind === "direct-fk"
        ? spec.routes.nested[0].fkColumn
        : undefined,
      "contact_id",
    );
    assert.ok(spec.routes.childrenOnly.has("address"));
  });

  it("still finds the ancestor FK when the child view removes it", async () => {
    const spec = await parse({
      "types.yaml": `types:
  - contacts_base:
      tags: [datasource_type]
      inherits: set
      fields: []
  - addresses_base:
      tags: [datasource_type]
      inherits: set
      fields:
        - contact_id:
            type: integer
            references: contacts_base.id
        - line1:
            type: string
  - contact:
      tags: [view_type]
      inherits: contacts_base
      fields: []
  - address:
      tags: [view_type]
      inherits: addresses_base
      remove_fields: [contact_id]
      fields: []
`,
      "routes.yaml": `combined_routes:
  - contact:
      combines:
        - address
routes: []
`,
    });
    assert.equal(spec.routes.nested[0]?.kind, "direct-fk");
    assert.equal(
      spec.routes.nested[0] && spec.routes.nested[0].kind === "direct-fk"
        ? spec.routes.nested[0].fkColumn
        : undefined,
      "contact_id",
    );
  });

  it("detects M2M when junction FKs point at bases and combined names are views", async () => {
    const spec = await parse({
      "types.yaml": `types:
  - contacts_base:
      tags: [datasource_type]
      inherits: set
      fields: []
  - contact_groups_base:
      tags: [datasource_type]
      inherits: set
      fields: []
  - contact:
      tags: [view_type]
      inherits: contacts_base
      fields: []
  - contact_group:
      tags: [view_type]
      inherits: contact_groups_base
      fields: []
  - contact_group_member:
      tags: [datasource_type, many_to_many]
      fields:
        - contact_id:
            type: integer
            references: contacts_base.id
        - contact_group_id:
            type: integer
            references: contact_groups_base.id
`,
      "routes.yaml": `combined_routes:
  - contact:
      combines:
        - contact_group
routes: []
`,
    });
    assert.equal(spec.routes.nested[0]?.kind, "m2m");
    assert.equal(
      spec.routes.nested[0] && spec.routes.nested[0].kind === "m2m"
        ? spec.routes.nested[0].junction
        : undefined,
      "contact_group_member",
    );
  });

  it("covers inherit chain stops for missing and dictionary", async () => {
    const spec = await parse({
      "types.yaml": `types:
  - parent:
      tags: [view_type]
      inherits: set
      fields: []
  - via_dict:
      tags: [view_type]
      inherits: dictionary
      fields:
        - parent_id:
            type: integer
            references: parent.id
        - key:
            type: string
        - value:
            type: string
  - via_missing:
      tags: [view_type]
      inherits: ghost_base
      fields:
        - parent_id:
            type: integer
            references: parent.id
`,
      "routes.yaml": `combined_routes:
  - parent:
      combines:
        - via_dict
        - via_missing
routes: []
`,
    });
    assert.equal(spec.routes.nested.length, 2);
    assert.ok(spec.routes.nested.every((n) => n.kind === "direct-fk"));
  });

  it("stops inheritsChain on a cycle", () => {
    const type = (name: string, inherits: string): Type => ({
      name,
      tags: ["view_type"],
      kind: "inherit",
      inherits,
      fields: [],
    });
    const typeByName = new Map<string, Type>([
      ["cyc_a", type("cyc_a", "cyc_b")],
      ["cyc_b", type("cyc_b", "cyc_a")],
    ]);
    assert.deepEqual(inheritsChain("cyc_a", typeByName), ["cyc_b"]);
  });
});
