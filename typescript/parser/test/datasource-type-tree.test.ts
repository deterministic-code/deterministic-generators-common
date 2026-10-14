import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  compareByDatasourceTypeOrder,
  datasourceTypeAncestry,
  datasourceTypeGraph,
  datasourceTypeGraphJson,
  datasourceTypeGraphXml,
  datasourceTypeGraphYaml,
  datasourceTypeHierarchies,
  datasourceTypeOrder,
  datasourceTypeTree,
  datasourceTypeTreeAll,
  datasourceTypeTreeFirst,
  datasourceTypeTreeJson,
  datasourceTypeTreeXml,
  datasourceTypeTreeYaml,
} from "../datasource-type-tree.ts";
import type { Type } from "../specification.ts";

const ds = (name: string, refs: string[] = []): Type => ({
  name,
  tags: ["datasource_type"],
  kind: "shaped",
  fields: refs.map((references, i) => ({
    name: `fk_${i}`,
    type: "integer",
    kind: "primitive",
    base: "integer",
    isArray: false,
    isNullable: false,
    references,
  })),
});

const contacts = [
  ds("contact_source"),
  ds("contact", ["contact_source.id"]),
  ds("address", ["contact.id"]),
  ds("phone", ["contact.id"]),
  ds("contact_group"),
  ds("contact_group_member", ["contact.id", "contact_group.id"]),
  ds("legacy_contact"),
  ds("contact_change_log"),
];

const firstParentTree = {
  root: {
    contact_source: {
      contact: {
        address: {},
        phone: {},
        contact_group_member: {},
      },
    },
    contact_group: {},
    legacy_contact: {},
    contact_change_log: {},
  },
};

const allParentsTree = {
  root: {
    contact_source: {
      contact: {
        address: {},
        phone: {},
        contact_group_member: {},
      },
    },
    contact_group: {
      contact_group_member: {},
    },
    legacy_contact: {},
    contact_change_log: {},
  },
};

const firstParentYaml = `root:
  contact_source:
    contact:
      address: {}
      phone: {}
      contact_group_member: {}
  contact_group: {}
  legacy_contact: {}
  contact_change_log: {}
`;

const firstParentJson = `{
  "root": {
    "contact_source": {
      "contact": {
        "address": {},
        "phone": {},
        "contact_group_member": {}
      }
    },
    "contact_group": {},
    "legacy_contact": {},
    "contact_change_log": {}
  }
}
`;

const firstParentXml = `<root>
  <contact_source>
    <contact>
      <address/>
      <phone/>
      <contact_group_member/>
    </contact>
  </contact_source>
  <contact_group/>
  <legacy_contact/>
  <contact_change_log/>
</root>
`;

const allParentsYaml = `root:
  contact_source:
    contact:
      address: {}
      phone: {}
      contact_group_member: {}
  contact_group:
    contact_group_member: {}
  legacy_contact: {}
  contact_change_log: {}
`;

const contactsGraph = {
  nodes: [
    "root",
    "contact_source",
    "contact",
    "address",
    "phone",
    "contact_group",
    "contact_group_member",
    "legacy_contact",
    "contact_change_log",
  ],
  edges: [
    { from: "contact_source", to: "root" },
    { from: "contact", to: "contact_source" },
    { from: "address", to: "contact" },
    { from: "phone", to: "contact" },
    { from: "contact_group", to: "root" },
    { from: "contact_group_member", to: "contact" },
    { from: "contact_group_member", to: "contact_group" },
    { from: "legacy_contact", to: "root" },
    { from: "contact_change_log", to: "root" },
  ],
};

const contactsGraphYaml = `nodes:
  - root
  - contact_source
  - contact
  - address
  - phone
  - contact_group
  - contact_group_member
  - legacy_contact
  - contact_change_log
edges:
  - from: contact_source
    to: root
  - from: contact
    to: contact_source
  - from: address
    to: contact
  - from: phone
    to: contact
  - from: contact_group
    to: root
  - from: contact_group_member
    to: contact
  - from: contact_group_member
    to: contact_group
  - from: legacy_contact
    to: root
  - from: contact_change_log
    to: root
`;

const contactsGraphJson = `{
  "nodes": [
    "root",
    "contact_source",
    "contact",
    "address",
    "phone",
    "contact_group",
    "contact_group_member",
    "legacy_contact",
    "contact_change_log"
  ],
  "edges": [
    {
      "from": "contact_source",
      "to": "root"
    },
    {
      "from": "contact",
      "to": "contact_source"
    },
    {
      "from": "address",
      "to": "contact"
    },
    {
      "from": "phone",
      "to": "contact"
    },
    {
      "from": "contact_group",
      "to": "root"
    },
    {
      "from": "contact_group_member",
      "to": "contact"
    },
    {
      "from": "contact_group_member",
      "to": "contact_group"
    },
    {
      "from": "legacy_contact",
      "to": "root"
    },
    {
      "from": "contact_change_log",
      "to": "root"
    }
  ]
}
`;

const contactsGraphXml = `<graph>
  <nodes>
    <node>root</node>
    <node>contact_source</node>
    <node>contact</node>
    <node>address</node>
    <node>phone</node>
    <node>contact_group</node>
    <node>contact_group_member</node>
    <node>legacy_contact</node>
    <node>contact_change_log</node>
  </nodes>
  <edges>
    <edge from="contact_source" to="root"/>
    <edge from="contact" to="contact_source"/>
    <edge from="address" to="contact"/>
    <edge from="phone" to="contact"/>
    <edge from="contact_group" to="root"/>
    <edge from="contact_group_member" to="contact"/>
    <edge from="contact_group_member" to="contact_group"/>
    <edge from="legacy_contact" to="root"/>
    <edge from="contact_change_log" to="root"/>
  </edges>
</graph>
`;

describe("datasourceTypeTree", () => {
  it("nests contacts under first parent by default", () => {
    assert.deepEqual(datasourceTypeTree(contacts), firstParentTree);
  });

  it("duplicates a type under every parent when multiParent is all", () => {
    assert.deepEqual(
      datasourceTypeTree(contacts, { multiParent: "all" }),
      allParentsTree,
    );
  });

  it("serializes the first-parent contacts tree to YAML, JSON, and XML", () => {
    const tree = datasourceTypeTree(contacts);
    assert.equal(datasourceTypeTreeYaml(tree), firstParentYaml);
    assert.equal(datasourceTypeTreeJson(tree), firstParentJson);
    assert.equal(datasourceTypeTreeXml(tree), firstParentXml);
  });

  it("serializes the all-parents contacts tree to YAML", () => {
    assert.equal(
      datasourceTypeTreeYaml(
        datasourceTypeTree(contacts, { multiParent: "all" }),
      ),
      allParentsYaml,
    );
  });

  it("ignores a self-reference and places the type under root", () => {
    assert.deepEqual(datasourceTypeTree([ds("node", ["node.id"])]), {
      root: { node: {} },
    });
  });

  it("points every cycle member without an outside parent at root", () => {
    assert.deepEqual(
      datasourceTypeTree([ds("a", ["b.id"]), ds("b", ["a.id"])]),
      { root: { a: {}, b: {} } },
    );
  });

  it("nests a type under a cycle member that points at root", () => {
    assert.deepEqual(
      datasourceTypeTree([
        ds("a", ["b.id"]),
        ds("b", ["a.id"]),
        ds("c", ["a.id"]),
      ]),
      { root: { a: { c: {} }, b: {} } },
    );
  });

  it("follows a composite references pair", () => {
    const link: Type = {
      name: "link",
      tags: ["datasource_type"],
      kind: "shaped",
      fields: [
        {
          name: "pair",
          type: "integer",
          kind: "primitive",
          base: "integer",
          isArray: false,
          isNullable: false,
          references: ["", "role.id"],
        },
      ],
    };
    const user = ds("user");
    const role = ds("role");
    assert.deepEqual(datasourceTypeTree([user, role, link]), {
      root: { role: { link: {} }, user: {} },
    });
  });

  it("ignores a references target that is not in the input set", () => {
    assert.deepEqual(datasourceTypeTree([ds("child", ["missing.id"])]), {
      root: { child: {} },
    });
  });
});

describe("datasource type hierarchies", () => {
  it("builds first-parent tree, all-parents tree, and graph for contacts", () => {
    const hierarchies = datasourceTypeHierarchies(contacts);
    assert.deepEqual(hierarchies.firstParentTree, firstParentTree);
    assert.deepEqual(hierarchies.allParentsTree, allParentsTree);
    assert.deepEqual(hierarchies.graph, contactsGraph);
    assert.deepEqual(datasourceTypeTreeFirst(contacts), firstParentTree);
    assert.deepEqual(datasourceTypeTreeAll(contacts), allParentsTree);
  });

  it("serializes the contacts graph to YAML, JSON, and XML", () => {
    const graph = datasourceTypeGraph(contacts);
    assert.deepEqual(graph, contactsGraph);
    assert.equal(datasourceTypeGraphYaml(graph), contactsGraphYaml);
    assert.equal(datasourceTypeGraphJson(graph), contactsGraphJson);
    assert.equal(datasourceTypeGraphXml(graph), contactsGraphXml);
  });

  it("walks the first-parent tree parent-before-child", () => {
    assert.deepEqual(datasourceTypeOrder(contacts), [
      "contact_source",
      "contact",
      "address",
      "phone",
      "contact_group_member",
      "contact_group",
      "legacy_contact",
      "contact_change_log",
    ]);
  });

  it("ranks an inheriting view just after its parent type", () => {
    const compare = compareByDatasourceTypeOrder(
      contacts,
      (name) => (name === "contact_card" ? "contact" : undefined),
    );
    const names = [
      "legacy_contact",
      "contact_card",
      "address",
      "contact_source",
    ].sort(compare);
    assert.deepEqual(names, [
      "contact_source",
      "contact_card",
      "address",
      "legacy_contact",
    ]);
  });

  it("lists all-parent ancestry parent-before-child without the subject", () => {
    assert.deepEqual(datasourceTypeAncestry(contacts, "address"), [
      "contact_source",
      "contact",
    ]);
    assert.deepEqual(datasourceTypeAncestry(contacts, "contact_group_member"), [
      "contact_source",
      "contact",
      "contact_group",
    ]);
    assert.deepEqual(datasourceTypeAncestry(contacts, "contact_source"), []);
    assert.deepEqual(datasourceTypeAncestry(contacts, "missing"), []);
  });

  it("skips a cycle when collecting ancestry", () => {
    assert.deepEqual(
      datasourceTypeAncestry([ds("a", ["b.id"]), ds("b", ["a.id"])], "a"),
      ["b"],
    );
  });

  it("keeps cycle edges on the graph and does not force them onto root", () => {
    assert.deepEqual(datasourceTypeGraph([ds("a", ["b.id"]), ds("b", ["a.id"])]), {
      nodes: ["root", "a", "b"],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    });
  });

  it("uses the default inheritOf and ties unknown names by locale", () => {
    const compare = compareByDatasourceTypeOrder(contacts);
    assert.ok(compare("contact", "address") < 0);
    assert.ok(compare("zeta", "alpha") > 0);
    assert.equal(compare("orphan", "orphan"), 0);
  });

  it("skips a cyclic child edge when a cycle SCC has an outside parent", () => {
    const tree = datasourceTypeTreeAll([
      ds("rootish"),
      ds("a", ["b.id", "rootish.id"]),
      ds("b", ["a.id", "rootish.id"]),
    ]);
    assert.deepEqual(tree, {
      root: {
        rootish: {
          a: { b: {} },
          b: { a: {} },
        },
      },
    });
  });

  it("orders an empty type list and serializes a leaf-only tree", () => {
    assert.deepEqual(datasourceTypeOrder([]), []);
    assert.equal(datasourceTypeTreeXml({ solo: {} }), "<solo/>\n");
    assert.deepEqual(datasourceTypeGraph([]), { nodes: ["root"], edges: [] });
    assert.deepEqual(datasourceTypeAncestry([], "x"), []);
  });
});
