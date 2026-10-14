import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  expandTypes,
  parseFieldType,
  primaryKeyColumn,
  uniqueLookupFields,
  type Type,
} from "../specification.ts";

const shaped = (
  name: string,
  fields: Type["fields"],
  extra: Partial<Type> = {},
): Type => ({
  name,
  tags: extra.tags ?? ["datasource_type"],
  kind: extra.kind ?? "shaped",
  fields,
  ...extra,
});

describe("specification helpers", () => {
  it("parses primitive and type-name field types", () => {
    assert.deepEqual(parseFieldType("string"), {
      kind: "primitive",
      base: "string",
      isArray: false,
      isMap: false,
    });
    assert.deepEqual(parseFieldType("role[]"), {
      kind: "type",
      base: "role",
      isArray: true,
      isMap: false,
    });
    assert.deepEqual(parseFieldType("settings{}"), {
      kind: "type",
      base: "settings",
      isArray: false,
      isMap: true,
    });
    assert.deepEqual(parseFieldType("user_summary"), {
      kind: "type",
      base: "user_summary",
      isArray: false,
      isMap: false,
    });
  });

  it("defaults primaryKeyColumn to id", () => {
    assert.equal(primaryKeyColumn(undefined), "id");
    assert.equal(
      primaryKeyColumn(undefined, shaped("user", [], { inherits: "set" })),
      "id",
    );
  });

  it("falls back to id when a type has no identity", () => {
    assert.equal(
      primaryKeyColumn(
        undefined,
        shaped("note", [
          {
            name: "body",
            type: "string",
            kind: "primitive",
            base: "string",
            isArray: false,
            isNullable: false,
          },
        ]),
      ),
      "id",
    );
  });

  it("takes primaryKeyColumn from is_id or ids", () => {
    assert.equal(
      primaryKeyColumn(
        undefined,
        shaped(
          "person",
          [
            {
              name: "code",
              type: "integer",
              kind: "primitive",
              base: "integer",
              isArray: false,
              isNullable: false,
              isId: true,
            },
          ],
          { inherits: "set" },
        ),
      ),
      "code",
    );
    assert.equal(
      primaryKeyColumn(
        undefined,
        shaped(
          "link",
          [
            {
              name: "left_id",
              type: "integer",
              kind: "primitive",
              base: "integer",
              isArray: false,
              isNullable: false,
            },
            {
              name: "right_id",
              type: "integer",
              kind: "primitive",
              base: "integer",
              isArray: false,
              isNullable: false,
            },
          ],
          { ids: ["left_id", "right_id"] },
        ),
      ),
      "left_id",
    );
  });

  it("includes authored identity fields in unique lookups", () => {
    const type = shaped(
      "person",
      [
        {
          name: "code",
          type: "integer",
          kind: "primitive",
          base: "integer",
          isArray: false,
          isNullable: false,
          isId: true,
        },
        {
          name: "email",
          type: "string",
          kind: "primitive",
          base: "string",
          isArray: false,
          isNullable: false,
          size: 256,
        },
      ],
      { inherits: "set" },
    );
    assert.deepEqual(
      uniqueLookupFields(type, {
        name: "person",
        fields: [{ name: "email", isUnique: true }],
        indexes: [],
        uniqueIndexFields: [],
      }),
      [
        { field: "code", type: "integer" },
        { field: "email", type: "string", size: 256 },
      ],
    );
  });

  it("collects unique lookup fields from the datasource overlay", () => {
    const type = shaped("user", [
      {
        name: "email",
        type: "string",
        kind: "primitive",
        base: "string",
        isArray: false,
        isNullable: false,
        size: 256,
      },
      {
        name: "code",
        type: "string",
        kind: "primitive",
        base: "string",
        isArray: false,
        isNullable: false,
      },
    ]);
    assert.deepEqual(
      uniqueLookupFields(type, {
        name: "user",
        fields: [{ name: "email", isUnique: true }],
        indexes: [],
        uniqueIndexFields: ["code"],
      }),
      [
        { field: "email", type: "string", size: 256 },
        { field: "code", type: "string" },
      ],
    );
  });

  it("skips a duplicate lookup field and defaults type when the field is missing", () => {
    const type = shaped("user", [
      {
        name: "email",
        type: "string",
        kind: "primitive",
        base: "string",
        isArray: false,
        isNullable: false,
        size: 256,
      },
    ]);
    assert.deepEqual(
      uniqueLookupFields(type, {
        name: "user",
        fields: [
          { name: "email", isUnique: true },
          { name: "missing", isUnique: true },
        ],
        indexes: [],
        uniqueIndexFields: ["email"],
      }),
      [
        { field: "email", type: "string", size: 256 },
        { field: "missing", type: "string" },
      ],
    );
  });

  it("expands a union with no member list", () => {
    const expanded = expandTypes(
      [shaped("combo", [], { kind: "union" })],
    );
    assert.deepEqual(expanded[0]?.fields, []);
  });

  it("expands a union of unknown members to local fields only", () => {
    const expanded = expandTypes(
      [
        shaped("combo", [], {
          kind: "union",
          union: ["ghost"],
          fields: [
            {
              name: "extra",
              type: "string",
              kind: "primitive",
              base: "string",
              isArray: false,
              isNullable: false,
            },
          ],
        }),
      ],
    );
    assert.deepEqual(
      expanded[0]?.fields.map((f) => f.name),
      ["extra"],
    );
  });

  it("expands set inherit, mapping, and remove_fields", () => {
    const expanded = expandTypes(
      [
        shaped(
          "user",
          [
            {
              name: "email",
              type: "string",
              kind: "primitive",
              base: "string",
              isArray: false,
              isNullable: false,
            },
            {
              name: "bio",
              type: "string",
              kind: "primitive",
              base: "string",
              isArray: false,
              isNullable: true,
            },
          ],
          { kind: "inherit", inherits: "set" },
        ),
        shaped(
          "person",
          [
            {
              name: "display_name",
              type: "string",
              kind: "primitive",
              base: "string",
              isArray: false,
              isNullable: false,
            },
          ],
          {
            kind: "inherit",
            inherits: "user",
            tags: ["view_type"],
            removeFields: ["bio"],
          },
        ),
      ],
    );
    assert.deepEqual(
      expanded[0]?.fields.map((f) => f.name),
      ["id", "email", "bio"],
    );
    assert.deepEqual(
      expanded[1]?.fields.map((f) => f.name),
      ["id", "email", "display_name"],
    );
  });

  it("does not inject id when a set authors is_id or ids", () => {
    const expanded = expandTypes(
      [
        shaped(
          "person",
          [
            {
              name: "code",
              type: "integer",
              kind: "primitive",
              base: "integer",
              isArray: false,
              isNullable: false,
              isId: true,
            },
            {
              name: "email",
              type: "string",
              kind: "primitive",
              base: "string",
              isArray: false,
              isNullable: false,
            },
          ],
          { kind: "inherit", inherits: "set" },
        ),
        shaped(
          "link",
          [
            {
              name: "left_id",
              type: "integer",
              kind: "primitive",
              base: "integer",
              isArray: false,
              isNullable: false,
            },
            {
              name: "right_id",
              type: "integer",
              kind: "primitive",
              base: "integer",
              isArray: false,
              isNullable: false,
            },
          ],
          { kind: "inherit", inherits: "set", ids: ["left_id", "right_id"] },
        ),
      ],
    );
    assert.deepEqual(
      expanded[0]?.fields.map((f) => f.name),
      ["code", "email"],
    );
    assert.equal(expanded[0]?.fields[0]?.isId, true);
    assert.deepEqual(
      expanded[1]?.fields.map((f) => f.name),
      ["left_id", "right_id"],
    );
    assert.deepEqual(expanded[1]?.ids, ["left_id", "right_id"]);
  });

  it("does not copy ids from an unknown parent or an is_id parent", () => {
    const expanded = expandTypes(
      [
        shaped(
          "person",
          [
            {
              name: "code",
              type: "integer",
              kind: "primitive",
              base: "integer",
              isArray: false,
              isNullable: false,
              isId: true,
            },
          ],
          { kind: "inherit", inherits: "set" },
        ),
        shaped(
          "alias",
          [],
          { kind: "inherit", inherits: "person" },
        ),
        shaped("orphan", [], { kind: "inherit", inherits: "ghost" }),
      ],
    );
    assert.equal(expanded.find((t) => t.name === "alias")?.ids, undefined);
    assert.equal(expanded.find((t) => t.name === "orphan")?.ids, undefined);
  });

  it("inherits composite ids from the parent type", () => {
    const expanded = expandTypes(
      [
        shaped(
          "link",
          [
            {
              name: "left_id",
              type: "integer",
              kind: "primitive",
              base: "integer",
              isArray: false,
              isNullable: false,
            },
            {
              name: "right_id",
              type: "integer",
              kind: "primitive",
              base: "integer",
              isArray: false,
              isNullable: false,
            },
          ],
          { kind: "inherit", inherits: "set", ids: ["left_id", "right_id"] },
        ),
        shaped(
          "tagged_link",
          [
            {
              name: "tag",
              type: "string",
              kind: "primitive",
              base: "string",
              isArray: false,
              isNullable: false,
            },
          ],
          { kind: "inherit", inherits: "link" },
        ),
      ],
    );
    const tagged = expanded.find((t) => t.name === "tagged_link");
    assert.deepEqual(tagged?.ids, ["left_id", "right_id"]);
    assert.deepEqual(tagged?.fields.map((f) => f.name), [
      "left_id",
      "right_id",
      "tag",
    ]);
  });

  it("drops qualified remove_fields only from that inherit/union source", () => {
    const field = (
      name: string,
      extras: Partial<Type["fields"][number]> = {},
    ): Type["fields"][number] => ({
      name,
      type: "string",
      kind: "primitive",
      base: "string",
      isArray: false,
      isNullable: false,
      ...extras,
    });
    const expanded = expandTypes([
      shaped(
        "contacts_base",
        [
          field("id", { type: "integer", base: "integer", isId: true }),
          field("uuid", { type: "uuid", base: "uuid" }),
          field("email"),
        ],
        { kind: "inherit", inherits: "set" },
      ),
      shaped(
        "contact_source",
        [
          field("id", { type: "integer", base: "integer", isId: true }),
          field("uuid", { type: "uuid", base: "uuid" }),
          field("name"),
        ],
        { kind: "inherit", inherits: "set" },
      ),
      shaped("contact", [], {
        kind: "inherit",
        inherits: "contacts_base",
        union: ["contact_source"],
        mapping: { name: "contact_source_name" },
        removeFields: ["contact_source.id", "contact_source.uuid"],
        tags: ["view_type"],
      }),
    ]);
    assert.deepEqual(
      expanded.find((t) => t.name === "contact")?.fields.map((f) => f.name),
      ["id", "uuid", "email", "contact_source_name"],
    );
  });

  it("extracts and renames qualified fields from a multi-union", () => {
    const field = (
      name: string,
      extras: Partial<Type["fields"][number]> = {},
    ): Type["fields"][number] => ({
      name,
      type: "string",
      kind: "primitive",
      base: "string",
      isArray: false,
      isNullable: false,
      ...extras,
    });
    const expanded = expandTypes([
      shaped("contacts_base", [field("email")], {
        kind: "inherit",
        inherits: "set",
      }),
      shaped("contact_source", [field("name")], {
        kind: "inherit",
        inherits: "set",
      }),
      shaped("contact_type", [field("name")], {
        kind: "inherit",
        inherits: "set",
      }),
      shaped("contact", [], {
        kind: "inherit",
        inherits: "contacts_base",
        union: ["contact_source", "contact_type"],
        extract: ["contact_source.name", "contact_type.name"],
        mapping: {
          "contact_source.name": "contact_source_name",
          "contact_type.name": "contact_type_name",
        },
        tags: ["view_type"],
      }),
    ]);
    assert.deepEqual(
      expanded.find((t) => t.name === "contact")?.fields.map((f) => f.name),
      ["id", "email", "contact_source_name", "contact_type_name"],
    );
  });

  it("ignores bare extract entries and keeps unmentioned sources", () => {
    const field = (
      name: string,
    ): Type["fields"][number] => ({
      name,
      type: "string",
      kind: "primitive",
      base: "string",
      isArray: false,
      isNullable: false,
    });
    const expanded = expandTypes([
      shaped("user", [field("email"), field("bio")], {
        kind: "inherit",
        inherits: "set",
      }),
      shaped("person", [field("display_name")], {
        kind: "inherit",
        inherits: "user",
        extract: ["name", "user.email", "user.id"],
      }),
    ]);
    assert.deepEqual(
      expanded.find((t) => t.name === "person")?.fields.map((f) => f.name),
      ["id", "email", "display_name"],
    );
  });

  it("throws when composed field names collide", () => {
    const field = (
      name: string,
    ): Type["fields"][number] => ({
      name,
      type: "string",
      kind: "primitive",
      base: "string",
      isArray: false,
      isNullable: false,
    });
    assert.throws(
      () =>
        expandTypes([
          shaped("contact_source", [field("name")], {
            kind: "inherit",
            inherits: "set",
          }),
          shaped("contact_type", [field("name")], {
            kind: "inherit",
            inherits: "set",
          }),
          shaped("contact", [], {
            kind: "union",
            union: ["contact_source", "contact_type"],
            tags: ["view_type"],
          }),
        ]),
      /contact_source.id and contact_type.id collide on the composed shape of contact; use mapping or remove_fields and give new names/,
    );
  });

  it("flattens an owned dictionary as authored fields and omits the owner FK when nested", () => {
    const field = (
      name: string,
      extras: Partial<Type["fields"][number]> = {},
    ): Type["fields"][number] => ({
      name,
      type: "string",
      kind: "primitive",
      base: extras.type === "integer" ? "integer" : "string",
      isArray: false,
      isNullable: false,
      ...extras,
    });
    const expanded = expandTypes([
      shaped("file", [field("name")], { kind: "inherit", inherits: "set" }),
      shaped(
        "settings",
        [
          field("setting_id", {
            type: "integer",
            base: "integer",
            references: "file.id",
          }),
          field("key"),
          field("value"),
        ],
        { kind: "inherit", inherits: "dictionary" },
      ),
      shaped("file_view", [], {
        kind: "inherit",
        inherits: "file",
        union: ["settings"],
        tags: ["view_type"],
      }),
    ]);
    assert.deepEqual(
      expanded.find((t) => t.name === "settings")?.fields.map((f) => f.name),
      ["setting_id", "key", "value"],
    );
    assert.deepEqual(
      expanded.find((t) => t.name === "file_view")?.fields.map((f) => f.name),
      ["id", "name", "key", "value"],
    );
  });

  it("omits an owner FK that points at an inherited or composite identity", () => {
    const field = (
      name: string,
      extras: Partial<Type["fields"][number]> = {},
    ): Type["fields"][number] => ({
      name,
      type: extras.type ?? "string",
      kind: "primitive",
      base: extras.base ?? extras.type ?? "string",
      isArray: false,
      isNullable: false,
      ...extras,
    });
    const expanded = expandTypes([
      shaped(
        "keyed",
        [field("code", { type: "integer", base: "integer", isId: true })],
      ),
      shaped("alias", [], { kind: "inherit", inherits: "keyed" }),
      shaped(
        "settings",
        [
          field("owner_id", {
            type: "integer",
            base: "integer",
            references: "alias.code",
          }),
          field("key"),
          field("value"),
        ],
        { kind: "inherit", inherits: "dictionary" },
      ),
      shaped("alias_view", [], {
        kind: "inherit",
        inherits: "alias",
        union: ["settings"],
        tags: ["view_type"],
      }),
      shaped(
        "link",
        [
          field("left_id", { type: "integer", base: "integer" }),
          field("right_id", { type: "integer", base: "integer" }),
        ],
        { ids: ["left_id", "right_id"] },
      ),
      shaped(
        "link_settings",
        [
          field("pair", {
            type: "integer",
            base: "integer",
            references: ["link.left_id", "link.right_id"],
          }),
          field("key"),
          field("value"),
        ],
        { kind: "inherit", inherits: "dictionary" },
      ),
      shaped("link_view", [], {
        kind: "inherit",
        inherits: "link",
        union: ["link_settings"],
        tags: ["view_type"],
      }),
    ]);
    assert.deepEqual(
      expanded.find((t) => t.name === "alias_view")?.fields.map((f) => f.name),
      ["code", "key", "value"],
    );
    assert.deepEqual(
      expanded.find((t) => t.name === "link_view")?.fields.map((f) => f.name),
      ["left_id", "right_id", "key", "value"],
    );
  });

  it("keeps a dictionary FK that is not the owner identity", () => {
    const field = (
      name: string,
      extras: Partial<Type["fields"][number]> = {},
    ): Type["fields"][number] => ({
      name,
      type: extras.type ?? "string",
      kind: "primitive",
      base: extras.base ?? extras.type ?? "string",
      isArray: false,
      isNullable: false,
      ...extras,
    });
    const expanded = expandTypes([
      shaped("note", [field("body")]),
      shaped("orphan", [], { kind: "inherit", inherits: "ghost" }),
      shaped(
        "settings",
        [
          field("note_body", { references: "note.body" }),
          field("bare", { references: "id" }),
          field("self_id", { references: "settings.key" }),
          field("ghost_id", { references: "ghost.id" }),
          field("orphan_id", { references: "orphan.id" }),
          field("mixed", { references: ["note.body", "orphan.id"] }),
          field("key"),
          field("value"),
        ],
        { kind: "inherit", inherits: "dictionary" },
      ),
      shaped("note_view", [], {
        kind: "inherit",
        inherits: "note",
        union: ["settings"],
        tags: ["view_type"],
      }),
    ]);
    assert.deepEqual(
      expanded.find((t) => t.name === "note_view")?.fields.map((f) => f.name),
      [
        "body",
        "note_body",
        "bare",
        "self_id",
        "ghost_id",
        "orphan_id",
        "mixed",
        "key",
        "value",
      ],
    );
  });

});
