import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { DeterministicParser } from "../parser/specification-parser.ts";
import { memoryReader } from "../deterministic-reader.ts";

const CONTACTS_TYPES = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../validator/test/fixtures/contacts.types.yaml",
  ),
  "utf8",
);

const parse = (files: Record<string, string>) =>
  DeterministicParser(memoryReader(files)).parse({});

describe("parse types.yaml", () => {
  it("reads inherit, union, mapping, and remove_fields", async () => {
    const det = await parse({
      "types.yaml": `types:
  - user:
      tags: [datasource_type, view_type]
      inherits: set
      fields:
        - email:
            type: string
            size: 256
        - bio:
            type: string
  - role:
      tags: [datasource_type]
      inherits: set
      fields:
        - name:
            type: string
        - code:
            type: string
  - settings:
      tags: [datasource_type]
      inherits: dictionary
      fields:
        - user_id:
            references: user.id
            type: integer
        - key:
            type: string
        - value:
            type: string
  - person:
      tags: [view_type]
      inherits: user
      remove_fields: [bio]
      fields:
        - display_name:
            type: string
        - role:
            type: role
  - phone_contact:
      tags: [view_type]
      union: [user, role]
      mapping:
        name: role_name
      remove_fields: [id]
      fields:
        - phone:
            type: string
`,
    });
    const user = det.expandedTypes.find((t) => t.name === "user");
    assert.deepEqual(user?.fields.map((f) => f.name), ["id", "email", "bio"]);
    const role = det.expandedTypes.find((t) => t.name === "role");
    assert.deepEqual(role?.fields.map((f) => f.name), ["id", "name", "code"]);
    const settings = det.expandedTypes.find((t) => t.name === "settings");
    assert.deepEqual(settings?.fields.map((f) => f.name), [
      "user_id",
      "key",
      "value",
    ]);
    const person = det.expandedTypes.find((t) => t.name === "person");
    assert.deepEqual(person?.fields.map((f) => f.name), [
      "id",
      "email",
      "display_name",
      "role",
    ]);
    const phone = det.expandedTypes.find((t) => t.name === "phone_contact");
    assert.ok(phone?.fields.some((f) => f.name === "role_name"));
    assert.ok(!phone?.fields.some((f) => f.name === "id"));
  });

  it("reads extract and qualified mapping", async () => {
    const det = await parse({
      "types.yaml": `types:
  - contacts_base:
      tags: [view_type]
      inherits: set
      fields:
        - email:
            type: string
  - contact_source:
      tags: [datasource_type]
      inherits: set
      fields:
        - name:
            type: string
  - contact_type:
      tags: [datasource_type]
      inherits: set
      fields:
        - name:
            type: string
  - contact:
      tags: [view_type]
      inherits: contacts_base
      union: [contact_source, contact_type]
      extract: [contact_source.name, contact_type.name]
      mapping:
        contact_source.name: contact_source_name
        contact_type.name: contact_type_name
`,
    });
    const contact = det.types.find((t) => t.name === "contact");
    assert.deepEqual(contact?.extract, [
      "contact_source.name",
      "contact_type.name",
    ]);
    assert.deepEqual(contact?.mapping, {
      "contact_source.name": "contact_source_name",
      "contact_type.name": "contact_type_name",
    });
    const expanded = det.expandedTypes.find((t) => t.name === "contact");
    assert.deepEqual(expanded?.fields.map((f) => f.name), [
      "id",
      "email",
      "contact_source_name",
      "contact_type_name",
    ]);
  });

  it("keeps union members when inherits is also present", async () => {
    const det = await parse({ "types.yaml": CONTACTS_TYPES });
    const contact = det.types.find((t) => t.name === "contact");
    assert.equal(contact?.kind, "inherit");
    assert.equal(contact?.inherits, "contacts_base");
    assert.deepEqual(contact?.union, ["contact_source"]);
    assert.deepEqual(contact?.mapping, { name: "contact_source_name" });
    assert.deepEqual(contact?.extract, [
      "contact_source.name",
      "contact_source.description",
    ]);
    const expanded = det.expandedTypes.find((t) => t.name === "contact");
    assert.deepEqual(expanded?.fields.map((f) => f.name), [
      "id",
      "uuid",
      "created",
      "updated",
      "version",
      "contact_source_id",
      "first_name",
      "last_name",
      "email",
      "notes",
      "contact_source_name",
      "description",
      "addresses",
      "phones",
      "settings",
      "prefs",
    ]);
    const address = det.expandedTypes.find((t) => t.name === "address");
    assert.deepEqual(address?.fields.map((f) => f.name), [
      "id",
      "uuid",
      "created",
      "updated",
      "version",
      "contact_id",
      "address_type_id",
      "line1",
      "line2",
      "city",
      "region",
      "postal_code",
      "country",
      "address_type_name",
      "description",
    ]);
    const group = det.expandedTypes.find((t) => t.name === "contact_group");
    assert.ok(group?.fields.some((f) => f.name === "members"));
  });

  it("reads is_id and ids and skips injected id", async () => {
    const det = await parse({
      "types.yaml": `types:
  - person:
      tags: [datasource_type]
      inherits: set
      fields:
        - code:
            type: integer
            is_id: true
        - email:
            type: string
  - link:
      tags: [datasource_type]
      inherits: set
      ids: [left_id, right_id]
      fields:
        - left_id:
            type: integer
        - right_id:
            type: integer
  - user:
      tags: [datasource_type]
      inherits: set
      fields:
        - email:
            type: string
`,
    });
    const person = det.expandedTypes.find((t) => t.name === "person");
    assert.deepEqual(person?.fields.map((f) => f.name), ["code", "email"]);
    assert.equal(person?.fields[0]?.isId, true);
    const link = det.expandedTypes.find((t) => t.name === "link");
    assert.deepEqual(link?.ids, ["left_id", "right_id"]);
    assert.deepEqual(link?.fields.map((f) => f.name), ["left_id", "right_id"]);
    const user = det.expandedTypes.find((t) => t.name === "user");
    assert.deepEqual(user?.fields.map((f) => f.name), ["id", "email"]);
  });

  it("parses composite references", async () => {
    const det = await parse({
      "types.yaml": `types:
  - link:
      tags: [datasource_type, many_to_many]
      fields:
        - left_id:
            type: integer
            references: user.id
        - right_id:
            type: integer
            references: role.id
        - pair:
            references: [link.left_id, link.right_id]
`,
    });
    const pair = det.types[0]?.fields.find((f) => f.name === "pair");
    assert.deepEqual(pair?.references, ["link.left_id", "link.right_id"]);
  });
});
