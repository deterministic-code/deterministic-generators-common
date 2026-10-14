import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { memoryReader } from "../deterministic-reader.ts";
import { DeterministicParser } from "../parser/specification-parser.ts";
import { compileTypesFilter } from "../parser/compile-filter.ts";
import {
  expandTypes,
  typeHasTag,
  uniqueLookupFields,
  type Type,
} from "../specification.ts";

const parse = (files: Record<string, string>) =>
  DeterministicParser(memoryReader(files)).parse({});

const shaped = (name: string, extra: Partial<Type> = {}): Type => ({
  name,
  tags: extra.tags ?? ["datasource_type"],
  kind: extra.kind ?? "shaped",
  fields: extra.fields ?? [],
  ...extra,
});

describe("parser coverage", () => {
  it("returns empty collections when no YAML is present", async () => {
    const spec = await parse({});
    assert.deepEqual(spec.types, []);
    assert.deepEqual(spec.datasource, []);
    assert.deepEqual(spec.expandedTypes, []);
  });

  it("parses seeds and empty custom lists", async () => {
    const spec = await parse({
      "types.yaml": `types:
  - user:
      tags: [datasource_type]
      fields:
        - email:
            type: string
            size: unlimited
            min_size: 1
            is_nullable: true
            default_value: ""
`,
      "datasource.yaml": `types:
  - user: {}
`,
      "datasource_seeds.yaml": `seeds:
  - user:
      - id1:
          email: a@b.c
`,
      "services.yaml": `services: []`,
      "routes.yaml": `routes: []`,
    });
    assert.equal(spec.datasourceSeeds.get("user")?.[0]?.id, 1);
    assert.deepEqual(spec.services.generics, []);
    assert.deepEqual(spec.routes.candidates, []);
    assert.equal(spec.types[0]?.fields[0]?.size, "unlimited");
    assert.equal(spec.types[0]?.fields[0]?.hasDefault, true);
  });

  it("throws on an invalid seed row key", async () => {
    await assert.rejects(
      () =>
        parse({
          "datasource_seeds.yaml": `seeds:
  - user:
      - row1:
          email: a
`,
        }),
      /Invalid seed row key/,
    );
  });

  it("throws on circular inherit", () => {
    assert.throws(
      () =>
        expandTypes(
          [
            shaped("a", { kind: "inherit", inherits: "b" }),
            shaped("b", { kind: "inherit", inherits: "a" }),
          ],
        ),
      /circular inherit/,
    );
  });

  it("reports typeHasTag and uniqueLookupFields for authored identity", () => {
    const type = shaped("user", {
      fields: [
        {
          name: "code",
          type: "string",
          kind: "primitive",
          base: "string",
          isArray: false,
          isNullable: false,
          isId: true,
        },
      ],
    });
    assert.equal(typeHasTag(type, "datasource_type"), true);
    assert.deepEqual(
      uniqueLookupFields(type, {
        name: "user",
        fields: [{ name: "code", isFixedId: true }],
        indexes: [],
        uniqueIndexFields: [],
      }).map((f) => f.field),
      ["code"],
    );
  });

  it("rejects a malformed filter expression", () => {
    assert.throws(
      () => compileTypesFilter('type == "user" &&'),
      /not a valid expression/,
    );
  });

  it("throws on an empty shorthand route token", async () => {
    await assert.rejects(
      () =>
        parse({
          "types.yaml": `types:
  - user:
      tags: [view_type]
      fields:
        - email:
            type: string
`,
          "routes.yaml": `routes:
  - ""
`,
        }),
      /expected non-empty string token/,
    );
  });

  it("throws on a shorthand route without _by_", async () => {
    await assert.rejects(
      () =>
        parse({
          "types.yaml": `types:
  - user:
      tags: [view_type]
      fields:
        - email:
            type: string
`,
          "routes.yaml": `routes:
  - get_users
`,
        }),
      /missing `_by_`/,
    );
  });

  it("throws on a shorthand route with an empty field", async () => {
    await assert.rejects(
      () =>
        parse({
          "types.yaml": `types:
  - user:
      tags: [view_type]
      fields:
        - email:
            type: string
`,
          "routes.yaml": `routes:
  - get_users_by_
`,
        }),
      /empty entity or field/,
    );
  });

  it("throws on a shorthand route for an unknown entity", async () => {
    await assert.rejects(
      () =>
        parse({
          "types.yaml": `types:
  - user:
      tags: [view_type]
      fields:
        - email:
            type: string
`,
          "routes.yaml": `routes:
  - get_roles_by_name
`,
        }),
      /unknown entity/,
    );
  });

  it("throws when the shorthand field is missing", async () => {
    await assert.rejects(
      () =>
        parse({
          "types.yaml": `types:
  - user:
      tags: [view_type]
      fields:
        - email:
            type: string
`,
          "routes.yaml": `routes:
  - get_users_by_missing
`,
        }),
      /field `missing` not found/,
    );
  });

  it("throws on a verbose by-field with a non-string entity", async () => {
    await assert.rejects(
      () =>
        parse({
          "types.yaml": `types:
  - user:
      tags: [view_type]
      fields:
        - email:
            type: string
`,
          "routes.yaml": `routes:
  - named:
      entity: 1
      byField: email
`,
        }),
      /non-string entity/,
    );
  });

  it("detects an implicit M2M junction and rejects an ambiguous one", async () => {
    const types = `types:
  - user:
      tags: [view_type]
      inherits: set
      fields: []
  - role:
      tags: [view_type]
      inherits: set
      fields: []
  - link:
      tags: [many_to_many]
      fields:
        - left_id:
            references: user.id
            type: integer
        - right_id:
            references: role.id
            type: integer
`;
    const implicit = await parse({
      "types.yaml": types,
      "routes.yaml": `combined_routes:
  - user:
      combines:
        - role
routes: []
`,
    });
    assert.equal(implicit.routes.nested[0]?.kind, "m2m");

    await assert.rejects(
      () =>
        parse({
          "types.yaml": `${types}
  - link2:
      tags: [many_to_many]
      fields:
        - left_id:
            references: user.id
            type: integer
        - right_id:
            references: role.id
            type: integer
`,
          "routes.yaml": `combined_routes:
  - user:
      combines:
        - role
routes: []
`,
        }),
      /ambiguous junction/,
    );
  });

  it("rejects incomplete and unknown M2M / combined children", async () => {
    await assert.rejects(
      () =>
        parse({
          "types.yaml": `types:
  - user:
      tags: [view_type]
      fields: []
`,
          "routes.yaml": `combined_routes:
  - user:
      combines:
        - role:
            via: link
routes: []
`,
        }),
      /must declare both via: and target:/,
    );

    await assert.rejects(
      () =>
        parse({
          "types.yaml": `types:
  - user:
      tags: [view_type]
      fields: []
`,
          "routes.yaml": `combined_routes:
  - user:
      combines:
        - role:
            via: missing
            target: role
routes: []
`,
        }),
      /junction "missing" not found/,
    );

    await assert.rejects(
      () =>
        parse({
          "types.yaml": `types:
  - user:
      tags: [view_type]
      fields: []
  - link:
      tags: [many_to_many]
      fields:
        - left_id:
            references: user.id
            type: integer
`,
          "routes.yaml": `combined_routes:
  - user:
      combines:
        - role:
            via: link
            target: role
routes: []
`,
        }),
      /missing FK/,
    );

    await assert.rejects(
      () =>
        parse({
          "types.yaml": `types:
  - user:
      tags: [view_type]
      fields: []
`,
          "routes.yaml": `combined_routes:
  - user:
      combines:
        - ghost
routes: []
`,
        }),
      /child "ghost" not found/,
    );

    await assert.rejects(
      () =>
        parse({
          "types.yaml": `types:
  - user:
      tags: [view_type]
      fields: []
  - note:
      tags: [view_type]
      fields: []
`,
          "routes.yaml": `combined_routes:
  - user:
      combines:
        - note
routes: []
`,
        }),
      /no FK to parent/,
    );
  });

  it("treats a null route overlay as shorthand and a parent as not children-only", async () => {
    const spec = await parse({
      "types.yaml": `types:
  - user:
      tags: [view_type]
      inherits: set
      fields:
        - email:
            type: string
  - person:
      tags: [view_type]
      inherits: user
      fields:
        - user_id:
            references: user.id
            type: integer
`,
      "routes.yaml": `includes:
  - types:
      filter: tag == "view_type"
combined_routes:
  - user:
      combines:
        - person:
            route: /people
routes:
  - get_users_by_email:
  - get_users_by_email
`,
    });
    assert.ok(spec.routes.candidates.some((c) => c.name === "user"));
    assert.ok(spec.routes.childrenOnly.has("person"));
    assert.ok(!spec.routes.childrenOnly.has("user"));
  });

  it("merges overlapping by-field methods and parses verbose entries", async () => {
    const spec = await parse({
      "types.yaml": `types:
  - user:
      tags: [view_type]
      inherits: set
      fields:
        - email:
            type: string
`,
      "datasource.yaml": `types:
  - user:
      fields:
        - email:
            is_unique: true
`,
      "routes.yaml": `includes:
  - types:
      filter: tag == "view_type"
routes:
  - get_users_by_email
  - put_users_by_email
  - named:
      entity: user
      byField: email
      methods: [DELETE]
  - users_by_email
`,
    });
    const user = spec.routes.candidates.find((c) => c.name === "user");
    assert.ok(user?.byFields.some((f) => f.byField === "email"));
  });

  it("covers size tuples, overlays, seed scalars, and route edge entries", async () => {
    const spec = await parse({
      "types.yaml": `types:
  - user:
      tags: [view_type, datasource_type, many_to_many]
      inherits: set
      mapping:
        id: 1
      fields:
        - email:
            type: string
            size: [10, 2]
        - score:
            type: integer
        - code:
            type: string
        - pair:
            references: [user.id, note.id]
  - note:
      tags: [view_type]
      fields:
        - body:
            type: string
        - user_id:
            references: user.id
            type: integer
  - extra:
      tags: [view_type]
      fields:
        - note_id:
            references: note.id
            type: integer
  - role:
      tags: [view_type]
      inherits: set
      fields: []
  - link:
      tags: [many_to_many]
      fields:
        - pair:
            references: [user.id, role.id]
        - left_id:
            references: user.id
            type: integer
        - right_id:
            references: role.id
            type: integer
`,
      "datasource.yaml": `types:
  - user:
      fields:
        - email:
            is_readonly: true
            is_fixed_id: true
        - score:
            is_unique: true
      indexes:
        - broken:
            fields: not-a-list
        - score_uidx:
            fields: [score]
            is_unique: true
`,
      "datasource_seeds.yaml": `seeds:
  - user:
      - id1: hello
      - id2:
          email: a
          nested:
            x: 1
`,
      "services.yaml": `includes:
  - file: other.yaml
  - types:
      filter: tag == "datasource_type"
services:
  - module: ./orphan
  - name: OrphanService
    module: ./services/orphan
`,
      "routes.yaml": `includes:
  - types:
      filter: tag == "view_type"
combined_routes:
  - role:
  - note:
      combines:
        - extra
  - user:
      combines:
        - note:
            route: /
        - role
routes:
  - ~
  - 1
  - {}
  - named: email
  - verbose:
      entity: user
      byField: email
  - get_users_by_id
  - users_by_code
  - user:
      eager_read_path:
        - email
  - note:
      eager_update_path:
        - body
  - extra:
      eager_read_member_only:
        - note_id
  - dangling:
      method: GET
`,
    });
    assert.equal(spec.types[0]?.fields[0]?.size?.[0], 10);
    assert.equal(spec.datasourceSeeds.get("user")?.[0]?.row.email, undefined);
    assert.ok(spec.routes.candidates.some((c) => c.name === "user"));
    const user = spec.routes.candidates.find((c) => c.name === "user");
    assert.ok(user?.byFields.some((f) => f.byField === "id"));
    assert.ok(user?.eagerReadPath);
    assert.ok(spec.services.customs.some((s) => s.name === "OrphanService"));
    assert.equal(spec.routes.nested.some((n) => n.segmentTail === ""), true);
    const servicesOnly = await parse({
      "types.yaml": `types:
  - user:
      tags: [datasource_type]
      fields: []
`,
      "services.yaml": `includes:
  - types:
      filter: tag == "datasource_type"
services:
  - name: Only
    module: ./only
`,
    });
    assert.deepEqual(
      servicesOnly.services.customs.find((s) => s.name === "Only")?.methods,
      [],
    );
  });

  it("skips generated service modules and empty mapping", async () => {
    const spec = await parse({
      "types.yaml": `types:
  - user:
      tags: [datasource_type]
      mapping: {}
      fields: []
`,
      "services.yaml": `includes:
  - types:
      filter: tag == "datasource_type"
services:
  - name: UserService
    module: ./services/generated/user
  - name: CustomService
    module: ./services/custom
`,
      "routes.yaml": `routes:
  - custom_get:
      path: /api/x
      method: GET
      service: CustomService
      function: run
`,
    });
    assert.equal(spec.types[0]?.mapping, undefined);
    assert.ok(spec.services.customs.some((s) => s.name === "CustomService"));
    assert.ok(!spec.services.customs.some((s) => s.name === "UserService"));
  });
});
