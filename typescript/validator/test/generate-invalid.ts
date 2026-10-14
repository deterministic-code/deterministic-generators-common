/**
 * Writes samples/invalid/** from the live specs. Run from validator/:
 *   node --experimental-strip-types test/generate-invalid.ts
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import {
  collectErrorPoints,
  loadSchema,
  type Schema,
} from "./schemaCoverage.ts";
import { findAncestorPath, resolveSpecPath } from "../resolveSpecPath.ts";
import { readFile } from "node:fs/promises";

type Host = Record<string, unknown>;

const SPECS = [
  {
    dir: "types",
    subdir: "backend",
    name: "types.spec.yaml",
  },
  {
    dir: "datasource",
    subdir: "backend",
    name: "datasource.spec.yaml",
  },
  {
    dir: "datasource_seeds",
    subdir: "backend",
    name: "datasource-seeds.spec.yaml",
  },
  { dir: "routes", subdir: "backend", name: "routes.spec.yaml" },
  { dir: "services", subdir: "backend", name: "services.spec.yaml" },
  { dir: "backend_app", subdir: "backend", name: "app.spec.yaml" },
  {
    dir: "frontend_bindings",
    subdir: "frontend",
    name: "bindings.spec.yaml",
  },
] as const;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function get(obj: unknown, path: Array<string | number>): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key as string];
  }
  return cur;
}

function set(obj: Host, path: Array<string | number>, value: unknown): Host {
  const out = clone(obj);
  let cur: Record<string, unknown> = out;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    const next = path[i + 1];
    if (cur[key as string] == null) {
      cur[key as string] = typeof next === "number" ? [] : {};
    }
    cur = cur[key as string] as Record<string, unknown>;
  }
  cur[path[path.length - 1]! as string] = value as never;
  return out;
}

function del(obj: Host, path: Array<string | number>): Host {
  const out = clone(obj);
  let cur: Record<string, unknown> = out;
  for (let i = 0; i < path.length - 1; i++) {
    cur = cur[path[i]! as string] as Record<string, unknown>;
  }
  delete cur[path[path.length - 1]! as string];
  return out;
}

const DS_INT: Host = {
  version: "1.0.0",
  types: [{ user: { fields: [{ n: { type: "integer" } }] } }],
};

function dsField(field: Host): Host {
  return { version: "1.0.0", types: [{ user: { fields: [{ n: field }] } }] };
}

function dsInclude(include: Host): Host {
  return { version: "1.0.0", types: [], includes: [include] };
}

function dsSide(side: Host): Host {
  return dsInclude({
    file: "other.yaml",
    combine_options: { source: side },
  });
}

const VIEW_MIN: Host = { version: "1.0.0", types: [] };
const SEEDS_MIN: Host = { version: "1.0.0", seeds: [] };
const ROUTES_MIN: Host = { version: "1.0.0", routes: [] };
const SERVICES_MIN: Host = { version: "1.0.0", services: [] };
const APP_MIN: Host = { version: "1.0.0" };
const BIND_MIN: Host = { version: "1.0.0", datasources: [] };

type Mut = { loc: Array<string | number>; host: Host };

function locFor(spec: string, path: string): Mut | null {
  if (spec === "types") return typesLoc(path);
  if (spec === "datasource") return datasourceLoc(path);
  if (spec === "datasource_seeds") return seedsLoc(path);
  if (spec === "routes") return routesLoc(path);
  if (spec === "services") return servicesLoc(path);
  if (spec === "backend_app") return appLoc(path);
  if (spec === "frontend_bindings") return bindLoc(path);
  return null;
}

function typesLoc(path: string): Mut | null {
  return dsLoc(path) ?? viewLoc(path);
}

function datasourceLoc(path: string): Mut | null {
  return dsLoc(path);
}

function dsLoc(path: string): Mut | null {
  if (path === "#") return { host: DS_INT, loc: [] };
  if (path === "#/properties/types") return { host: DS_INT, loc: ["types"] };
  if (path === "#/properties/includes")
    return { host: dsInclude({ file: "x.yaml" }), loc: ["includes"] };
  if (path === "#/properties/datasource_mappings")
    return {
      host: { ...DS_INT, datasource_mappings: [{ user: { source: "users" } }] },
      loc: ["datasource_mappings"],
    };
  if (path === "#/$defs/tableEntry") return { host: DS_INT, loc: ["types", 0] };
  if (path === "#/$defs/tableDef")
    return { host: DS_INT, loc: ["types", 0, "user"] };
  if (path.startsWith("#/$defs/tableDef/properties/fields"))
    return { host: DS_INT, loc: ["types", 0, "user", "fields"] };
  if (path.startsWith("#/$defs/tableDef/properties/indexes"))
    return {
      host: set(DS_INT, ["types", 0, "user", "indexes"], [
        { idx: { fields: ["n"], is_unique: false } },
      ]),
      loc: ["types", 0, "user", "indexes"],
    };
  if (path.startsWith("#/$defs/tableDef/properties/datasource_type"))
    return { host: DS_INT, loc: ["types", 0, "user", "datasource_type"] };
  if (path.startsWith("#/$defs/tableDef/properties/target"))
    return { host: DS_INT, loc: ["types", 0, "user", "target"] };
  if (path === "#/$defs/fieldEntry")
    return { host: DS_INT, loc: ["types", 0, "user", "fields", 0] };
  if (path === "#/$defs/identifier" || path === "#/$defs/tableColumnRef")
    return { host: DS_INT, loc: ["types", 0] };
  if (path.startsWith("#/$defs/indexEntry")) {
    const host = set(DS_INT, ["types", 0, "user", "indexes"], [
      { idx: { fields: ["n"], is_unique: false } },
    ]);
    if (path === "#/$defs/indexEntry") return { host, loc: ["types", 0, "user", "indexes", 0] };
    if (path === "#/$defs/indexEntry/propertyNames")
      return { host, loc: ["types", 0, "user", "indexes", 0] };
    if (path.includes("additionalProperties/properties/fields"))
      return { host, loc: ["types", 0, "user", "indexes", 0, "idx", "fields"] };
    return { host, loc: ["types", 0, "user", "indexes", 0, "idx"] };
  }
  if (path.includes("datetimeDefault"))
    return {
      host: dsField({ type: "datetime", default_value: "Now" }),
      loc: ["types", 0, "user", "fields", 0, "n", "default_value"],
    };
  if (path.includes("uuidDefault"))
    return {
      host: dsField({ type: "uuid", default_value: "NewId" }),
      loc: ["types", 0, "user", "fields", 0, "n", "default_value"],
    };
  if (path.includes("hexDefault"))
    return {
      host: dsField({ type: "binary", size: 4, default_value: "Hex('')" }),
      loc: ["types", 0, "user", "fields", 0, "n", "default_value"],
    };
  if (path.includes("signedIntegerString"))
    return {
      host: dsField({ type: "biginteger", default_value: "0" }),
      loc: ["types", 0, "user", "fields", 0, "n", "default_value"],
    };
  if (path.includes("unsignedIntegerString"))
    return {
      host: dsField({ type: "unsignedbiginteger", default_value: "0" }),
      loc: ["types", 0, "user", "fields", 0, "n", "default_value"],
    };
  if (path.includes("decimalString"))
    return {
      host: dsField({ type: "decimal", size: [10, 2], default_value: "0.00" }),
      loc: ["types", 0, "user", "fields", 0, "n", "default_value"],
    };
  const fieldHosts: Record<string, Host> = {
    stringField: { type: "string", size: 8 },
    characterField: { type: "character", size: 1, default_value: "X" },
    numberField: { type: "number", default_value: 0 },
    integerField: { type: "integer", default_value: 0 },
    unsignedIntegerField: { type: "unsignedinteger", default_value: 0 },
    bigIntegerField: { type: "biginteger", default_value: "0" },
    unsignedBigIntegerField: { type: "unsignedbiginteger", default_value: "0" },
    smallIntegerField: { type: "smallinteger", default_value: 0 },
    unsignedSmallIntegerField: { type: "unsignedsmallinteger", default_value: 0 },
    floatField: { type: "float" },
    decimalField: { type: "decimal", size: [10, 2], default_value: "0.00" },
    booleanField: { type: "boolean" },
    binaryField: { type: "binary", size: 4, default_value: "Hex('')" },
    datetimeField: { type: "datetime", default_value: "Now" },
    uuidField: { type: "uuid", default_value: "NewId" },
    referenceField: { references: "user.id" },
  };
  for (const [def, field] of Object.entries(fieldHosts)) {
    if (path.includes(`/$defs/${def}`)) {
      const host = dsField(field);
      if (path.endsWith(`/$defs/${def}`))
        return { host, loc: ["types", 0, "user", "fields", 0, "n"] };
      if (path.includes("/properties/size"))
        return { host, loc: ["types", 0, "user", "fields", 0, "n", "size"] };
      if (path.includes("/properties/min_size"))
        return {
          host: dsField({ ...field, min_size: 0 }),
          loc: ["types", 0, "user", "fields", 0, "n", "min_size"],
        };
      if (path.includes("/properties/default_value"))
        return {
          host: dsField({ ...field, default_value: field.default_value ?? 0 }),
          loc: ["types", 0, "user", "fields", 0, "n", "default_value"],
        };
      if (path.includes("/properties/validation"))
        return {
          host: dsField({ type: "string", validation: ["x"] }),
          loc: ["types", 0, "user", "fields", 0, "n", "validation"],
        };
      return { host, loc: ["types", 0, "user", "fields", 0, "n"] };
    }
  }
  if (path.includes("sizeValue"))
    return {
      host: dsField({ type: "string", size: 8 }),
      loc: ["types", 0, "user", "fields", 0, "n", "size"],
    };
  if (path.includes("fieldDef"))
    return { host: DS_INT, loc: ["types", 0, "user", "fields", 0, "n"] };
  if (path.includes("includeEntry") || path.includes("/properties/includes")) {
    if (path.includes("/properties/file"))
      return { host: dsInclude({ file: "x.yaml" }), loc: ["includes", 0, "file"] };
    if (path.includes("/properties/uuid"))
      return { host: dsInclude({ uuid: "abc" }), loc: ["includes", 0, "uuid"] };
    if (path.includes("/properties/name"))
      return {
        host: dsInclude({ user_id: 1, name: "app" }),
        loc: ["includes", 0, "name"],
      };
    if (path.includes("/properties/user_id"))
      return {
        host: dsInclude({ user_id: 1, name: "app" }),
        loc: ["includes", 0, "user_id"],
      };
    if (path.includes("/properties/id"))
      return { host: dsInclude({ id: "saved" }), loc: ["includes", 0, "id"] };
    return { host: dsInclude({ file: "x.yaml" }), loc: ["includes", 0] };
  }
  if (path.includes("addFieldOp"))
    return {
      host: dsSide({
        add_fields: [{ type: "user", add_field: { extra: { type: "integer" } } }],
      }),
      loc: ["includes", 0, "combine_options", "source", "add_fields", 0],
    };
  if (path.includes("modifyTypeOp"))
    return {
      host: dsSide({
        modify_types: [{ type: "user", new_type: "person" }],
      }),
      loc: ["includes", 0, "combine_options", "source", "modify_types", 0],
    };
  if (path.includes("modifyFieldOp"))
    return {
      host: dsSide({
        modify_fields: [{ field: "user.n", new_field: "m" }],
      }),
      loc: ["includes", 0, "combine_options", "source", "modify_fields", 0],
    };
  if (path.includes("sideOptions/properties/remove_types"))
    return {
      host: dsSide({ remove_types: ["user"] }),
      loc: ["includes", 0, "combine_options", "source", "remove_types"],
    };
  if (path.includes("sideOptions/properties/remove_fields"))
    return {
      host: dsSide({ remove_fields: ["user.n"] }),
      loc: ["includes", 0, "combine_options", "source", "remove_fields"],
    };
  if (path.includes("sideOptions/properties/modify_types"))
    return {
      host: dsSide({ modify_types: [{ type: "user", new_type: "person" }] }),
      loc: ["includes", 0, "combine_options", "source", "modify_types"],
    };
  if (path.includes("sideOptions/properties/modify_fields"))
    return {
      host: dsSide({ modify_fields: [{ field: "user.n", new_field: "m" }] }),
      loc: ["includes", 0, "combine_options", "source", "modify_fields"],
    };
  if (path.includes("sideOptions/properties/add_fields"))
    return {
      host: dsSide({
        add_fields: [{ type: "user", add_field: { extra: { type: "integer" } } }],
      }),
      loc: ["includes", 0, "combine_options", "source", "add_fields"],
    };
  if (path.includes("sideOptions") || path.includes("combineOptions"))
    return {
      host: dsInclude({
        file: "x.yaml",
        combine_options: { source: { remove_types: ["user"] } },
      }),
      loc: path.includes("combineOptions")
        ? ["includes", 0, "combine_options"]
        : ["includes", 0, "combine_options", "source"],
    };
  if (path.includes("fieldMapping")) {
    const host: Host = {
      ...DS_INT,
      datasource_mappings: [
        { user: { source: "users", field_mappings: [{ n: { source: "n" } }] } },
      ],
    };
    if (path.includes("fieldMappingEntry"))
      return {
        host,
        loc: ["datasource_mappings", 0, "user", "field_mappings", 0],
      };
    if (path.includes("properties/source"))
      return {
        host,
        loc: ["datasource_mappings", 0, "user", "field_mappings", 0, "n", "source"],
      };
    if (path.includes("properties/type_converter"))
      return {
        host: set(host, ["datasource_mappings", 0, "user", "field_mappings", 0, "n"], {
          type_converter: "x",
        }),
        loc: [
          "datasource_mappings",
          0,
          "user",
          "field_mappings",
          0,
          "n",
          "type_converter",
        ],
      };
    return {
      host,
      loc: ["datasource_mappings", 0, "user", "field_mappings", 0, "n"],
    };
  }
  if (path.includes("datasourceMapping")) {
    const host: Host = {
      ...DS_INT,
      datasource_mappings: [
        { user: { source: "users", field_mappings: [{ n: { source: "n" } }] } },
      ],
    };
    if (path.includes("fieldMappingEntry"))
      return {
        host,
        loc: ["datasource_mappings", 0, "user", "field_mappings", 0],
      };
    if (path.includes("fieldMappingDef/properties/source"))
      return {
        host,
        loc: ["datasource_mappings", 0, "user", "field_mappings", 0, "n", "source"],
      };
    if (path.includes("fieldMappingDef/properties/type_converter"))
      return {
        host: set(host, ["datasource_mappings", 0, "user", "field_mappings", 0, "n"], {
          type_converter: "x",
        }),
        loc: [
          "datasource_mappings",
          0,
          "user",
          "field_mappings",
          0,
          "n",
          "type_converter",
        ],
      };
    if (path.includes("fieldMappingDef"))
      return {
        host,
        loc: ["datasource_mappings", 0, "user", "field_mappings", 0, "n"],
      };
    if (path.includes("properties/source"))
      return { host, loc: ["datasource_mappings", 0, "user", "source"] };
    if (path.includes("properties/field_mappings"))
      return { host, loc: ["datasource_mappings", 0, "user", "field_mappings"] };
    if (path.includes("datasourceMappingEntry"))
      return { host, loc: ["datasource_mappings", 0] };
    return { host, loc: ["datasource_mappings", 0, "user"] };
  }
  if (path.startsWith("#/properties/version"))
    return { host: DS_INT, loc: ["version"] };
  return null;
}

const SEEDS_ONE: Host = {
  version: "1.0.0",
  seeds: [{ user: [{ id1: { n: 1 } }] }],
};

function seedsLoc(path: string): Mut | null {
  if (path === "#") return { host: SEEDS_MIN, loc: [] };
  if (path === "#/properties/seeds") return { host: SEEDS_ONE, loc: ["seeds"] };
  if (path === "#/$defs/tableSeedsEntry")
    return { host: SEEDS_ONE, loc: ["seeds", 0] };
  if (path === "#/$defs/identifier")
    return { host: SEEDS_ONE, loc: ["seeds", 0] };
  if (path.startsWith("#/$defs/tableSeedsEntry")) {
    if (path.includes("propertyNames") || path.endsWith("tableSeedsEntry"))
      return { host: SEEDS_ONE, loc: ["seeds", 0] };
    return { host: SEEDS_ONE, loc: ["seeds", 0, "user"] };
  }
  if (path.startsWith("#/$defs/seedEntry")) {
    if (path === "#/$defs/seedEntry" || path.includes("propertyNames"))
      return { host: SEEDS_ONE, loc: ["seeds", 0, "user", 0] };
    if (path.includes("additionalProperties/additionalProperties"))
      return { host: SEEDS_ONE, loc: ["seeds", 0, "user", 0, "id1", "n"] };
    return { host: SEEDS_ONE, loc: ["seeds", 0, "user", 0, "id1"] };
  }
  if (path.startsWith("#/properties/version"))
    return { host: SEEDS_MIN, loc: ["version"] };
  return null;
}

function viewLoc(path: string): Mut | null {
  const shaped: Host = {
    version: "1.0.0",
    types: [{ person: { fields: [{ name: { type: "string" } }] } }],
  };
  const inherit: Host = {
    version: "1.0.0",
    types: [
      {
        person: {
          inherits: "set",
          union: ["source"],
          extract: ["source.name"],
          mapping: { id: "person_id" },
          remove_fields: ["bio"],
          fields: [],
        },
      },
    ],
  };
  if (path === "#") return { host: VIEW_MIN, loc: [] };
  if (path === "#/properties/includes")
    return {
      host: { ...VIEW_MIN, includes: [{ file: "x.yaml" }] },
      loc: ["includes"],
    };
  if (path === "#/properties/types") return { host: shaped, loc: ["types"] };
  if (path.includes("typeEntry")) return { host: shaped, loc: ["types", 0] };
  if (path.includes("dictionaryFields")) {
    const dictionary: Host = {
      version: "1.0.0",
      types: [
        {
          settings: {
            inherits: "dictionary",
            fields: [
              { owner_id: { type: "integer", references: "user.id" } },
              { key: { type: "string" } },
              { value: { type: "string" } },
            ],
          },
        },
      ],
    };
    if (path.includes("properties/fields") || path.includes("required"))
      return { host: dictionary, loc: ["types", 0, "settings", "fields"] };
    return { host: dictionary, loc: ["types", 0, "settings"] };
  }
  if (path.includes("typeDef")) {
    if (path.includes("properties/union"))
      return { host: inherit, loc: ["types", 0, "person", "union"] };
    if (path.includes("properties/inherits"))
      return { host: inherit, loc: ["types", 0, "person", "inherits"] };
    if (path.includes("properties/extract"))
      return { host: inherit, loc: ["types", 0, "person", "extract"] };
    if (path.includes("properties/mapping"))
      return { host: inherit, loc: ["types", 0, "person", "mapping"] };
    if (path.includes("properties/remove_fields"))
      return { host: inherit, loc: ["types", 0, "person", "remove_fields"] };
    if (path.includes("properties/fields") || path.includes("properties/ids") || path.includes("properties/tags"))
      return { host: shaped, loc: ["types", 0, "person"] };
    return { host: inherit, loc: ["types", 0, "person"] };
  }
  if (path.includes("extractProp"))
    return { host: inherit, loc: ["types", 0, "person", "extract"] };
  if (path.includes("mappingProp"))
    return { host: inherit, loc: ["types", 0, "person", "mapping"] };
  if (path.includes("removeFieldsProp"))
    return { host: inherit, loc: ["types", 0, "person", "remove_fields"] };
  if (path.includes("fieldEntry/propertyNames") || path.includes("fieldEntry"))
    return { host: shaped, loc: ["types", 0, "person", "fields", 0] };
  if (path.includes("fieldDef/properties/type"))
    return { host: shaped, loc: ["types", 0, "person", "fields", 0, "name", "type"] };
  if (path.includes("fieldDef/properties/size"))
    return {
      host: {
        version: "1.0.0",
        types: [{ person: { fields: [{ name: { type: "string", size: 8 } }] } }],
      },
      loc: ["types", 0, "person", "fields", 0, "name", "size"],
    };
  if (path.includes("fieldDef/properties/min_size"))
    return {
      host: {
        version: "1.0.0",
        types: [{ person: { fields: [{ name: { type: "string", min_size: 0 } }] } }],
      },
      loc: ["types", 0, "person", "fields", 0, "name", "min_size"],
    };
  if (path.includes("fieldDef/properties/default_value"))
    return {
      host: {
        version: "1.0.0",
        types: [
          { person: { fields: [{ name: { type: "string", default_value: "" } }] } },
        ],
      },
      loc: ["types", 0, "person", "fields", 0, "name", "default_value"],
    };
  if (path.includes("fieldDef/properties/references"))
    return {
      host: {
        version: "1.0.0",
        types: [
          {
            person: {
              fields: [
                {
                  role: {
                    type: "role",
                    references: "role.id",
                  },
                },
              ],
            },
          },
        ],
      },
      loc: ["types", 0, "person", "fields", 0, "role", "references"],
    };
  if (path.includes("fieldDef"))
    return { host: shaped, loc: ["types", 0, "person", "fields", 0, "name"] };
  if (path.includes("includeEntry") || path.includes("fileInclude"))
    return {
      host: { ...VIEW_MIN, includes: [{ file: "x.yaml" }] },
      loc: ["includes", 0],
    };
  if (path.includes("typesDirectiveInclude"))
    return {
      host: {
        ...VIEW_MIN,
        includes: [{ types: { filter: 'tag == "datasource_type"' } }],
      },
      loc: path.includes("types/properties")
        ? ["includes", 0, "types", "filter"]
        : path.includes("properties/types")
          ? ["includes", 0, "types"]
          : ["includes", 0],
    };
  if (path.includes("idInclude/properties/id"))
    return {
      host: { ...VIEW_MIN, includes: [{ id: "saved" }] },
      loc: ["includes", 0, "id"],
    };
  if (path.includes("/idInclude"))
    return { host: { ...VIEW_MIN, includes: [{ id: "saved" }] }, loc: ["includes", 0] };
  if (path.includes("uuidInclude"))
    return {
      host: { ...VIEW_MIN, includes: [{ uuid: "abc" }] },
      loc: path.includes("properties/uuid")
        ? ["includes", 0, "uuid"]
        : ["includes", 0],
    };
  if (path.includes("userNameInclude"))
    return {
      host: { ...VIEW_MIN, includes: [{ user_id: 1, name: "app" }] },
      loc: path.includes("properties/name")
        ? ["includes", 0, "name"]
        : path.includes("properties/user_id")
          ? ["includes", 0, "user_id"]
          : ["includes", 0],
    };
  if (path.includes("fileInclude/properties/file") || path.includes("fileInclude"))
    return {
      host: { ...VIEW_MIN, includes: [{ file: "x.yaml" }] },
      loc: path.includes("properties/file")
        ? ["includes", 0, "file"]
        : ["includes", 0],
    };
  if (path.includes("addFieldOp") || path.includes("modifyTypeOp") || path.includes("modifyFieldOp") || path.includes("sideOptions") || path.includes("combineOptions") || path.includes("identifier") || path.includes("viewFieldRef") || path.includes("modifyFieldOp/properties/new_field")) {
    const host: Host = {
      ...VIEW_MIN,
      includes: [
        {
          file: "x.yaml",
          combine_options: {
            source: {
              remove_types: ["old"],
              remove_fields: ["old.name"],
              modify_types: [{ type: "old", new_type: "person" }],
              modify_fields: [{ field: "old.name", new_field: "display" }],
              add_fields: [{ type: "old", add_field: { extra: { type: "string" } } }],
            },
          },
        },
      ],
    };
    if (path.includes("addFieldOp"))
      return { host, loc: ["includes", 0, "combine_options", "source", "add_fields", 0] };
    if (path.includes("modifyTypeOp"))
      return { host, loc: ["includes", 0, "combine_options", "source", "modify_types", 0] };
    if (path.includes("new_field"))
      return {
        host,
        loc: ["includes", 0, "combine_options", "source", "modify_fields", 0, "new_field"],
      };
    if (path.includes("modifyFieldOp"))
      return { host, loc: ["includes", 0, "combine_options", "source", "modify_fields", 0] };
    if (path.includes("remove_types"))
      return { host, loc: ["includes", 0, "combine_options", "source", "remove_types"] };
    if (path.includes("remove_fields") || path.includes("viewFieldRef"))
      return { host, loc: ["includes", 0, "combine_options", "source", "remove_fields"] };
    if (path.includes("modify_types"))
      return { host, loc: ["includes", 0, "combine_options", "source", "modify_types"] };
    if (path.includes("modify_fields"))
      return { host, loc: ["includes", 0, "combine_options", "source", "modify_fields"] };
    if (path.includes("add_fields"))
      return { host, loc: ["includes", 0, "combine_options", "source", "add_fields"] };
    if (path.includes("identifier"))
      return { host, loc: ["includes", 0, "combine_options", "source", "remove_types", 0] };
    if (path.includes("combineOptions"))
      return { host, loc: ["includes", 0, "combine_options"] };
    return { host, loc: ["includes", 0, "combine_options", "source"] };
  }
  if (path.startsWith("#/properties/version"))
    return { host: VIEW_MIN, loc: ["version"] };
  return null;
}

function routesLoc(path: string): Mut | null {
  const custom: Host = {
    version: "1.0.0",
    routes: [{ ping: { path: "/ping", method: "GET" } }],
  };
  const byField: Host = {
    version: "1.0.0",
    routes: [{ by_email: { entity: "user", byField: "email" } }],
  };
  if (path === "#") return { host: ROUTES_MIN, loc: [] };
  if (path === "#/properties/routes") return { host: custom, loc: ["routes"] };
  if (path === "#/properties/includes")
    return { host: { ...ROUTES_MIN, includes: [{ file: "x.yaml" }] }, loc: ["includes"] };
  if (path === "#/properties/combined_routes")
    return {
      host: {
        ...ROUTES_MIN,
        combined_routes: [{ people: { route: "/api/people", combines: ["Person"] } }],
      },
      loc: ["combined_routes"],
    };
  if (path.includes("customRouteShape/properties/aliases"))
    return {
      host: {
        version: "1.0.0",
        routes: [{ ping: { path: "/ping", method: "GET", aliases: ["/x"] } }],
      },
      loc: ["routes", 0, "ping", "aliases"],
    };
  if (path.includes("customRouteShape/properties/args"))
    return {
      host: {
        version: "1.0.0",
        routes: [
          {
            ping: {
              path: "/ping",
              method: "GET",
              args: [{ kind: "undefined" }],
            },
          },
        ],
      },
      loc: ["routes", 0, "ping", "args"],
    };
  if (path.includes("customRouteShape/properties/errors"))
    return {
      host: {
        version: "1.0.0",
        routes: [{ ping: { path: "/ping", method: "GET", errors: [400] } }],
      },
      loc: ["routes", 0, "ping", "errors"],
    };
  if (path.includes("customRouteShape/properties/scopes"))
    return {
      host: {
        version: "1.0.0",
        routes: [{ ping: { path: "/ping", method: "GET", scopes: ["a"] } }],
      },
      loc: ["routes", 0, "ping", "scopes"],
    };
  if (path.includes("customRouteShape/properties/services"))
    return {
      host: {
        version: "1.0.0",
        routes: [{ ping: { path: "/ping", method: "GET", services: ["Svc"] } }],
      },
      loc: ["routes", 0, "ping", "services"],
    };
  if (path.includes("customRouteShape/properties/")) {
    const key = path.split("/properties/")[1]!.split("/")[0]!;
    const dispatch =
      key === "routeClass" || key === "module"
        ? { routeClass: "PingRoute", module: "./x" }
        : key === "services"
          ? { services: ["PersonService"] }
          : { service: "PersonService", function: "run" };
    const host: Host = {
      version: "1.0.0",
      routes: [
        {
          ping: {
            path: "/ping",
            method: "GET",
            description: "x",
            request: "person",
            response: "person",
            authentication: "none",
            "x-implementation": "stub",
            ...dispatch,
          },
        },
      ],
    };
    return { host, loc: ["routes", 0, "ping", key] };
  }
  if (path.includes("customRouteShape"))
    return { host: custom, loc: ["routes", 0, "ping"] };
  if (path.includes("byFieldRouteShape/properties/methods"))
    return {
      host: {
        version: "1.0.0",
        routes: [
          { by_email: { entity: "user", byField: "email", methods: ["GET"] } },
        ],
      },
      loc: ["routes", 0, "by_email", "methods"],
    };
  if (path.includes("byFieldRouteShape"))
    return { host: byField, loc: ["routes", 0, "by_email"] };
  if (path.includes("routeEntry/oneOf/0"))
    return { host: { version: "1.0.0", routes: ["get_users_by_email"] }, loc: ["routes", 0] };
  if (path.includes("routeEntry"))
    return { host: custom, loc: ["routes", 0] };
  if (path.includes("routeArgSpec")) {
    const host: Host = {
      version: "1.0.0",
      routes: [
        {
          ping: {
            path: "/ping",
            method: "GET",
            args: [
              { kind: "repo", name: "person" },
              { kind: "service", name: "Svc" },
              { kind: "config", key: "a.b" },
              { kind: "undefined" },
              { kind: "literal", value: 1 },
            ],
          },
        },
      ],
    };
    const idx = path.includes("oneOf/0")
      ? 0
      : path.includes("oneOf/1")
        ? 1
        : path.includes("oneOf/2")
          ? 2
          : path.includes("oneOf/3")
            ? 3
            : 4;
    if (path.includes("properties/name") || path.includes("properties/key") || path.includes("properties/kind") || path.includes("properties/value")) {
      const prop = path.includes("name")
        ? "name"
        : path.includes("key")
          ? "key"
          : path.includes("value")
            ? "value"
            : "kind";
      return { host, loc: ["routes", 0, "ping", "args", idx, prop] };
    }
    return { host, loc: ["routes", 0, "ping", "args", idx] };
  }
  if (path.includes("combinedTypeItem") || path.includes("combinedRouteEntry")) {
    const host: Host = {
      ...ROUTES_MIN,
      combined_routes: [
        {
          people: {
            route: "/api/people",
            combines: [
              "Person",
              { reports: { via: "manager", target: "person", route: "/r" } },
            ],
          },
        },
      ],
    };
    if (path.includes("combinedTypeItem/oneOf/0"))
      return { host, loc: ["combined_routes", 0, "people", "combines", 0] };
    if (path.includes("properties/via"))
      return {
        host,
        loc: ["combined_routes", 0, "people", "combines", 1, "reports", "via"],
      };
    if (path.includes("properties/target"))
      return {
        host,
        loc: ["combined_routes", 0, "people", "combines", 1, "reports", "target"],
      };
    if (path.includes("properties/route") && path.includes("combinedTypeItem"))
      return {
        host,
        loc: ["combined_routes", 0, "people", "combines", 1, "reports", "route"],
      };
    if (path.includes("combinedTypeItem/oneOf/1/additionalProperties"))
      return {
        host,
        loc: ["combined_routes", 0, "people", "combines", 1, "reports"],
      };
    if (path.includes("combinedTypeItem/oneOf/1"))
      return { host, loc: ["combined_routes", 0, "people", "combines", 1] };
    if (path.includes("properties/combines"))
      return { host, loc: ["combined_routes", 0, "people", "combines"] };
    if (path.includes("properties/route"))
      return { host, loc: ["combined_routes", 0, "people", "route"] };
    if (path.includes("combinedRouteEntry/additionalProperties"))
      return { host, loc: ["combined_routes", 0, "people"] };
    return { host, loc: ["combined_routes", 0] };
  }
  if (path.includes("viewTypeRoutesDirective")) {
    const host: Host = {
      ...ROUTES_MIN,
      includes: [
        {
          types: {
            filter: 'type == "person"',
          },
        },
      ],
    };
    if (path.includes("eager_read_member_only"))
      return { host, loc: ["includes", 0, "types", "filter"] };
    if (path.includes("typesDirectiveInclude"))
      return { host, loc: ["includes", 0] };
    return { host, loc: ["includes", 0, "types"] };
  }
  if (path.includes("fileInclude") || path.includes("/idInclude") || path.includes("uuidInclude") || path.includes("userNameInclude") || path.includes("includeEntry")) {
    const host: Host = { ...ROUTES_MIN, includes: [{ file: "x.yaml" }] };
    if (path.includes("/idInclude"))
      return {
        host: { ...ROUTES_MIN, includes: [{ id: "saved" }] },
        loc: path.includes("properties/id") ? ["includes", 0, "id"] : ["includes", 0],
      };
    if (path.includes("uuidInclude"))
      return {
        host: { ...ROUTES_MIN, includes: [{ uuid: "abc" }] },
        loc: path.includes("properties/uuid") ? ["includes", 0, "uuid"] : ["includes", 0],
      };
    if (path.includes("userNameInclude"))
      return {
        host: { ...ROUTES_MIN, includes: [{ user_id: 1, name: "app" }] },
        loc: path.includes("properties/name")
          ? ["includes", 0, "name"]
          : path.includes("properties/user_id")
            ? ["includes", 0, "user_id"]
            : ["includes", 0],
      };
    return {
      host,
      loc: path.includes("properties/file") ? ["includes", 0, "file"] : ["includes", 0],
    };
  }
  if (path.includes("sideOptions") || path.includes("combineOptions") || path.includes("routeName")) {
    const host: Host = {
      ...ROUTES_MIN,
      includes: [
        {
          file: "x.yaml",
          combine_options: { source: { remove_routes: ["OldRoute"] } },
        },
      ],
    };
    if (path.includes("remove_routes") || path.includes("routeName"))
      return { host, loc: ["includes", 0, "combine_options", "source", "remove_routes"] };
    if (path.includes("combineOptions"))
      return { host, loc: ["includes", 0, "combine_options"] };
    return { host, loc: ["includes", 0, "combine_options", "source"] };
  }
  if (path.startsWith("#/properties/version"))
    return { host: ROUTES_MIN, loc: ["version"] };
  return null;
}

function servicesLoc(path: string): Mut | null {
  const svc: Host = {
    version: "1.0.0",
    services: [{ name: "PersonService", description: "x" }],
  };
  if (path === "#") return { host: SERVICES_MIN, loc: [] };
  if (path === "#/properties/services") return { host: svc, loc: ["services"] };
  if (path === "#/properties/includes")
    return {
      host: { ...SERVICES_MIN, includes: [{ file: "x.yaml" }] },
      loc: ["includes"],
    };
  if (path.includes("serviceEntry/properties/args") || path.includes("argSpec")) {
    const host: Host = {
      version: "1.0.0",
      services: [
        {
          name: "PersonService",
          description: "x",
          args: [
            { kind: "repo", name: "person" },
            { kind: "service", name: "Audit" },
            { kind: "config", key: "a.b" },
            { kind: "undefined" },
            { kind: "literal", value: 1 },
          ],
        },
      ],
    };
    if (path.includes("properties/args") && !path.includes("argSpec"))
      return { host, loc: ["services", 0, "args"] };
    const idx = path.includes("oneOf/0")
      ? 0
      : path.includes("oneOf/1")
        ? 1
        : path.includes("oneOf/2")
          ? 2
          : path.includes("oneOf/3")
            ? 3
            : 4;
    if (path.includes("properties/name") || path.includes("properties/key") || path.includes("properties/kind") || path.includes("properties/value")) {
      const prop = path.includes("name")
        ? "name"
        : path.includes("key")
          ? "key"
          : path.includes("value")
            ? "value"
            : "kind";
      return { host, loc: ["services", 0, "args", idx, prop] };
    }
    return { host, loc: ["services", 0, "args", idx] };
  }
  if (path.includes("serviceEntry"))
    return {
      host: {
        version: "1.0.0",
        services: [{ name: "PersonService", description: "x", module: "./x" }],
      },
      loc: path.includes("properties/description")
        ? ["services", 0, "description"]
        : path.includes("properties/module")
          ? ["services", 0, "module"]
          : path.includes("properties/name") || path.includes("serviceName") || path.includes("pattern")
            ? ["services", 0, "name"]
            : ["services", 0],
    };
  if (path.includes("viewTypeServicesDirectiveInclude")) {
    const host: Host = {
      ...SERVICES_MIN,
      includes: [{ types: { filter: 'tag == "datasource_type"' } }],
    };
    if (path.includes("properties/filter"))
      return { host, loc: ["includes", 0, "types", "filter"] };
    if (path.includes("types") && !path.endsWith("Include"))
      return { host, loc: ["includes", 0, "types"] };
    return { host, loc: ["includes", 0] };
  }
  if (path.includes("fileInclude") || path.includes("/idInclude") || path.includes("uuidInclude") || path.includes("userNameInclude") || path.includes("includeEntry")) {
    if (path.includes("/idInclude"))
      return {
        host: { ...SERVICES_MIN, includes: [{ id: "saved" }] },
        loc: path.includes("properties/id") ? ["includes", 0, "id"] : ["includes", 0],
      };
    if (path.includes("uuidInclude"))
      return {
        host: { ...SERVICES_MIN, includes: [{ uuid: "abc" }] },
        loc: path.includes("properties/uuid") ? ["includes", 0, "uuid"] : ["includes", 0],
      };
    if (path.includes("userNameInclude"))
      return {
        host: { ...SERVICES_MIN, includes: [{ user_id: 1, name: "app" }] },
        loc: path.includes("properties/name")
          ? ["includes", 0, "name"]
          : path.includes("properties/user_id")
            ? ["includes", 0, "user_id"]
            : ["includes", 0],
      };
    return {
      host: { ...SERVICES_MIN, includes: [{ file: "x.yaml" }] },
      loc: path.includes("properties/file") ? ["includes", 0, "file"] : ["includes", 0],
    };
  }
  if (path.includes("sideOptions") || path.includes("combineOptions") || path.includes("serviceName")) {
    const host: Host = {
      ...SERVICES_MIN,
      includes: [
        {
          file: "x.yaml",
          combine_options: { source: { remove_services: ["OldService"] } },
        },
      ],
    };
    if (path.includes("remove_services") || path.includes("serviceName"))
      return { host, loc: ["includes", 0, "combine_options", "source", "remove_services"] };
    if (path.includes("combineOptions"))
      return { host, loc: ["includes", 0, "combine_options"] };
    return { host, loc: ["includes", 0, "combine_options", "source"] };
  }
  if (path.startsWith("#/properties/version"))
    return { host: SERVICES_MIN, loc: ["version"] };
  return null;
}

function appLoc(path: string): Mut | null {
  if (path === "#") return { host: APP_MIN, loc: [] };
  if (path === "#/properties/name") return { host: { ...APP_MIN, name: "app" }, loc: ["name"] };
  if (path === "#/properties/middleware" || path.includes("middlewareItem"))
    return {
      host: { ...APP_MIN, middleware: ["cors"] },
      loc: path.includes("oneOf/0") || path.includes("minLength:#/$defs/middlewareItem")
        ? ["middleware", 0]
        : ["middleware"],
    };
  if (path.includes("middlewareOptions/properties/apply_routes"))
    return {
      host: { ...APP_MIN, middleware: [{ auth: { apply_routes: ["/api"] } }] },
      loc: ["middleware", 0, "auth", "apply_routes"],
    };
  if (path.includes("middlewareOptions/properties/deny_routes"))
    return {
      host: { ...APP_MIN, middleware: [{ auth: { deny_routes: ["/api"] } }] },
      loc: ["middleware", 0, "auth", "deny_routes"],
    };
  if (path.includes("middlewareOptions/properties/type") || path.includes("middlewareOptions"))
    return {
      host: { ...APP_MIN, middleware: [{ cors: { type: "app" } }] },
      loc: path.includes("properties/type")
        ? ["middleware", 0, "cors", "type"]
        : ["middleware", 0, "cors"],
    };
  if (path.includes("middlewareItem/oneOf/1"))
    return {
      host: { ...APP_MIN, middleware: [{ cors: { enabled: true } }] },
      loc: ["middleware", 0],
    };
  if (path === "#/properties/handlers" || path.includes("handlerItem"))
    return {
      host: { ...APP_MIN, handlers: ["NotFoundMiddlewareService"] },
      loc: path.includes("oneOf/0") || path.includes("handlerItem/oneOf/0")
        ? ["handlers", 0]
        : path.includes("oneOf/1")
          ? ["handlers"]
          : ["handlers"],
    };
  if (path.includes("handlerOptions"))
    return {
      host: {
        ...APP_MIN,
        handlers: [{ ErrorHandlerMiddlewareService: { enabled: true } }],
      },
      loc: ["handlers", 0, "ErrorHandlerMiddlewareService"],
    };
  if (path.includes("handlerItem/oneOf/1"))
    return {
      host: {
        ...APP_MIN,
        handlers: [{ ErrorHandlerMiddlewareService: { enabled: true } }],
      },
      loc: ["handlers", 0],
    };
  if (path === "#/properties/statics" || path.includes("staticMountEntry"))
    return {
      host: { ...APP_MIN, statics: [{ path: "/public", dir: "./public" }] },
      loc: path.includes("properties/path")
        ? ["statics", 0, "path"]
        : path.includes("properties/dir")
          ? ["statics", 0, "dir"]
          : path.includes("staticMountEntry") && path !== "#/properties/statics"
            ? ["statics", 0]
            : ["statics"],
    };
  if (path.startsWith("#/properties/version"))
    return { host: APP_MIN, loc: ["version"] };
  return null;
}

function bindLoc(path: string): Mut | null {
  const ds: Host = {
    version: "1.0.0",
    datasources: [
      {
        core: {
          type: "REST",
          schema_type: "OpenAPI",
          schema: "https://example.com/o.json",
          clients: ["fetch"],
        },
      },
    ],
  };
  if (path === "#") return { host: BIND_MIN, loc: [] };
  if (path === "#/properties/datasources") return { host: ds, loc: ["datasources"] };
  if (path.includes("datasourceEntry")) return { host: ds, loc: ["datasources", 0] };
  if (path.includes("properties/clients"))
    return { host: ds, loc: ["datasources", 0, "core", "clients"] };
  if (path.includes("properties/schema_type"))
    return { host: ds, loc: ["datasources", 0, "core", "schema_type"] };
  if (path.includes("properties/schema"))
    return { host: ds, loc: ["datasources", 0, "core", "schema"] };
  if (path.includes("properties/type") && path.includes("datasourceDef"))
    return { host: ds, loc: ["datasources", 0, "core", "type"] };
  if (path.includes("datasourceDef"))
    return { host: ds, loc: ["datasources", 0, "core"] };
  if (path.startsWith("#/properties/version"))
    return { host: BIND_MIN, loc: ["version"] };
  return null;
}

function mutate(
  point: string,
  spec: string,
): { data: unknown; includes: string } | null {
  const [keyword, rest] = splitPoint(point);
  const path = keyword === "required" ? rest.split(":").slice(0, -1).join(":") : rest;
  const requiredKey = keyword === "required" ? rest.split(":").pop()! : "";
  const found = locFor(spec, path);
  if (!found) return null;
  const { host, loc } = found;

  if (keyword === "additionalProperties") {
    if (loc.length === 0) return { data: { ...host, extra: true }, includes: "property: extra" };
    return { data: set(host, loc, { ...(get(host, loc) as Host), extra: true }), includes: "property: extra" };
  }
  if (keyword === "required") {
    if (loc.length === 0) return { data: del(host, [requiredKey]), includes: `missing: ${requiredKey}` };
    const obj = get(host, loc);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const next = { ...(obj as Host) };
      delete next[requiredKey];
      return { data: set(host, loc, next), includes: `missing: ${requiredKey}` };
    }
    return { data: del(host, [...loc, requiredKey]), includes: `missing: ${requiredKey}` };
  }
  if (keyword === "type") {
    const current = loc.length === 0 ? host : get(host, loc);
    const replacement = Array.isArray(current) ? {} : [];
    if (loc.length === 0) return { data: replacement, includes: "must be" };
    return { data: set(host, loc, replacement), includes: "must be" };
  }
  if (keyword === "pattern") {
    const current = loc.length === 0 ? host : get(host, loc);
    if (Array.isArray(current)) {
      return { data: set(host, loc, ["NOT VALID"]), includes: "pattern" };
    }
    if (path.includes("characterField") && path.includes("default_value")) {
      return { data: set(host, loc, ""), includes: "pattern" };
    }
    return { data: loc.length === 0 ? host : set(host, loc, "NOT VALID"), includes: "pattern" };
  }
  if (keyword === "minLength") {
    const current = loc.length === 0 ? host : get(host, loc);
    if (Array.isArray(current)) return { data: set(host, loc, [""]), includes: "fewer than" };
    return { data: set(host, loc, ""), includes: "fewer than" };
  }
  if (keyword === "minimum") {
    const current = get(host, loc);
    if (Array.isArray(current)) return { data: set(host, loc, [-9999999999999]), includes: ">=" };
    return { data: set(host, loc, -9999999999999), includes: ">=" };
  }
  if (keyword === "maximum") {
    return { data: set(host, loc, 9999999999999), includes: "<=" };
  }
  if (keyword === "minItems") {
    return { data: set(host, loc, []), includes: "fewer than" };
  }
  if (keyword === "maxItems") {
    return { data: set(host, loc, [1, 2, 3]), includes: "more than" };
  }
  if (keyword === "minProperties") {
    return { data: set(host, loc, {}), includes: "fewer than" };
  }
  if (keyword === "maxProperties") {
    return { data: set(host, loc, { a: {}, b: {} }), includes: "more than" };
  }
  if (keyword === "uniqueItems") {
    const current = get(host, loc);
    const item = Array.isArray(current) && current[0] !== undefined ? current[0] : "x";
    return { data: set(host, loc, [item, item]), includes: "duplicate" };
  }
  if (keyword === "enum") {
    const current = get(host, loc);
    if (Array.isArray(current)) return { data: set(host, loc, ["nope"]), includes: "allowed" };
    return { data: set(host, loc, "nope"), includes: "allowed" };
  }
  if (keyword === "const") {
    if (path.includes("customRouteShape/properties/response")) {
      return { data: set(host, loc, 1), includes: "equal to" };
    }
    return { data: set(host, loc, "nope"), includes: "equal to" };
  }
  if (keyword === "oneOf" || keyword === "anyOf") {
    if (path.includes("mappingProp/propertyNames")) {
      return { data: set(host, loc, { "NOT-VALID": "x" }), includes: "must match" };
    }
    const current = get(host, loc);
    const replacement =
      current && typeof current === "object" && !Array.isArray(current)
        ? { nope: true }
        : { nope: true };
    return { data: set(host, loc, replacement), includes: "must match" };
  }
  if (keyword === "not") {
    return {
      data: set(host, loc, { apply_routes: ["/a"], deny_routes: ["/b"] }),
      includes: "must NOT",
    };
  }
  return null;
}

function splitPoint(point: string): [string, string] {
  const idx = point.indexOf(":");
  return [point.slice(0, idx), point.slice(idx + 1)];
}

function fileName(point: string): string {
  return (
    point
      .replaceAll("#/$defs/", "defs-")
      .replaceAll("#/properties/", "prop-")
      .replaceAll("#", "root")
      .replaceAll("/", "_")
      .replaceAll(":", "-")
      .replaceAll("$", "") + ".yaml"
  );
}

const missing: string[] = [];

const samplesRoot = dirname((await findAncestorPath("samples/valid"))!);

for (const spec of SPECS) {
  const schema = loadSchema(
    await readFile(await resolveSpecPath(spec.subdir, spec.name), "utf8"),
  ) as Schema;
  const points = [...collectErrorPoints(schema)].sort();
  const outDir = join(samplesRoot, "invalid", spec.dir);
  await rm(outDir, { force: true, recursive: true });
  await mkdir(outDir, { recursive: true });
  for (const point of points) {
    const result = mutate(point, spec.dir);
    if (!result) {
      missing.push(`${spec.dir}: ${point}`);
      continue;
    }
    const expectDoc = stringify({
      expect: { covers: point },
    });
    const body =
      result.data === undefined || typeof result.data !== "object"
        ? stringify(result.data)
        : stringify(result.data);
    await writeFile(join(outDir, fileName(point)), `${expectDoc}---\n${body}`);
  }
}

if (missing.length) {
  console.error(`no host for ${missing.length} points:`);
  for (const line of missing) console.error(" ", line);
  process.exit(1);
}
console.log("wrote invalid samples");
