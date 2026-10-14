import { parseDocument } from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import { resolveAjvCtor } from "../SpecValidator.ts";

export type Schema = Record<string, unknown>;

function asSchema(value: unknown): Schema | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Schema)
    : null;
}

function newAjv() {
  return new (resolveAjvCtor(Ajv2020))({ allErrors: true, strict: false });
}

export function loadSchema(text: string): Schema {
  return parseDocument(text).toJS() as Schema;
}

function pointerJoin(base: string, ...parts: string[]): string {
  let out = base;
  for (const part of parts) {
    out += `/${String(part).replace(/~/g, "~0").replace(/\//g, "~1")}`;
  }
  return out;
}

function resolveRef(root: Schema, ref: string): { schema: Schema; path: string } {
  if (!ref.startsWith("#/")) {
    throw new Error(`unsupported $ref: ${ref}`);
  }
  const path = ref.slice(1);
  const parts = path.split("/").slice(1).map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let node: unknown = root;
  for (const part of parts) {
    const obj = asSchema(node);
    if (!obj || !(part in obj)) throw new Error(`unresolved $ref: ${ref}`);
    node = obj[part];
  }
  const schema = asSchema(node);
  if (!schema) throw new Error(`$ref did not resolve to an object: ${ref}`);
  return { schema, path: ref };
}

function deref(
  root: Schema,
  schema: Schema,
  path: string,
  seen: Set<string>,
): { schema: Schema; path: string } | null {
  const ref = schema.$ref;
  if (typeof ref !== "string") return { schema, path };
  if (seen.has(ref)) return null;
  seen.add(ref);
  return resolveRef(root, ref);
}

const matchCache = new Map<string, (data: unknown) => boolean>();

function matches(
  root: Schema,
  schema: Schema,
  data: unknown,
  path: string,
): boolean {
  let fn = matchCache.get(path);
  if (!fn) {
    fn = newAjv().compile({ $defs: root.$defs, ...schema });
    matchCache.set(path, fn);
  }
  return Boolean(fn(data));
}

/** Positive coverage: properties, enum/const values, oneOf/anyOf branches, patterns. */
export function collectValidPoints(root: Schema): Set<string> {
  const points = new Set<string>();
  walkSchema(root, root, "#", new Set(), (schema, path) => {
    if (typeof schema.pattern === "string") points.add(`pattern:${path}`);
    if (schema.const !== undefined) points.add(`const:${path}:${JSON.stringify(schema.const)}`);
    if (Array.isArray(schema.enum)) {
      for (const value of schema.enum) {
        points.add(`enum:${path}:${JSON.stringify(value)}`);
      }
    }
    if (Array.isArray(schema.oneOf)) {
      schema.oneOf.forEach((_, i) => points.add(`oneOf:${path}:${i}`));
    }
    if (Array.isArray(schema.anyOf)) {
      schema.anyOf.forEach((_, i) => points.add(`anyOf:${path}:${i}`));
    }
    const properties = asSchema(schema.properties);
    if (properties) {
      for (const key of Object.keys(properties)) {
        points.add(`property:${path}/properties/${key}`);
      }
    }
  });
  return points;
}

/**
 * Negative coverage: every schema keyword that can reject a document.
 * `type` is included only on leaf schemas that declare a single JSON type
 * (not alongside oneOf/anyOf, which already encode the type split).
 */
export function collectErrorPoints(root: Schema): Set<string> {
  const points = new Set<string>();
  walkSchema(root, root, "#", new Set(), (schema, path) => {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (path.includes("/anyOf/") || path.includes("/oneOf/") || path.includes("/not")) {
          continue;
        }
        const defName = path.split("/").pop() ?? "";
        if (key === "type" && /Field$/.test(defName)) continue;
        points.add(`required:${path}:${key}`);
      }
    }
    if (schema.additionalProperties === false) {
      points.add(`additionalProperties:${path}`);
    }
    if (typeof schema.pattern === "string") points.add(`pattern:${path}`);
    if (typeof schema.minLength === "number" && schema.minLength > 0) {
      points.add(`minLength:${path}`);
    }
    if (typeof schema.minimum === "number") points.add(`minimum:${path}`);
    if (typeof schema.maximum === "number") points.add(`maximum:${path}`);
    if (typeof schema.minItems === "number" && schema.minItems > 0) {
      points.add(`minItems:${path}`);
    }
    if (typeof schema.maxItems === "number") points.add(`maxItems:${path}`);
    if (typeof schema.minProperties === "number" && schema.minProperties > 0) {
      points.add(`minProperties:${path}`);
    }
    if (typeof schema.maxProperties === "number") {
      points.add(`maxProperties:${path}`);
    }
    if (schema.uniqueItems === true) points.add(`uniqueItems:${path}`);
    if (schema.const !== undefined && !path.endsWith("/properties/type")) {
      points.add(`const:${path}`);
    }
    if (Array.isArray(schema.enum) && !path.includes("/anyOf/") && !path.includes("/oneOf/")) {
      points.add(`enum:${path}`);
    }
    if (Array.isArray(schema.oneOf)) points.add(`oneOf:${path}`);
    if (Array.isArray(schema.anyOf)) points.add(`anyOf:${path}`);
    if (schema.not !== undefined) points.add(`not:${path}`);
    if (
      (schema.type === "object" || schema.type === "array") &&
      !Array.isArray(schema.oneOf) &&
      !Array.isArray(schema.anyOf)
    ) {
      points.add(`type:${path}`);
    }
  });
  return points;
}

function walkSchema(
  root: Schema,
  schema: Schema,
  path: string,
  seen: Set<string>,
  visit: (schema: Schema, path: string) => void,
): void {
  const resolved = deref(root, schema, path, seen);
  if (!resolved) return;
  schema = resolved.schema;
  path = resolved.path;
  if (seen.has(`walk:${path}`)) return;
  seen.add(`walk:${path}`);
  visit(schema, path);

  const properties = asSchema(schema.properties);
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      const child = asSchema(value);
      if (child) walkSchema(root, child, pointerJoin(path, "properties", key), seen, visit);
    }
  }
  const additional = schema.additionalProperties;
  if (asSchema(additional)) {
    walkSchema(
      root,
      asSchema(additional)!,
      pointerJoin(path, "additionalProperties"),
      seen,
      visit,
    );
  }
  const items = schema.items;
  if (asSchema(items)) {
    walkSchema(root, asSchema(items)!, pointerJoin(path, "items"), seen, visit);
  }
  const propertyNames = asSchema(schema.propertyNames);
  if (propertyNames) {
    walkSchema(root, propertyNames, pointerJoin(path, "propertyNames"), seen, visit);
  }
  const notSchema = asSchema(schema.not);
  if (notSchema) walkSchema(root, notSchema, pointerJoin(path, "not"), seen, visit);
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const list = schema[key];
    if (!Array.isArray(list)) continue;
    list.forEach((entry, i) => {
      const child = asSchema(entry);
      if (child) walkSchema(root, child, pointerJoin(path, key, String(i)), seen, visit);
    });
  }
}

export function coverValidInstance(
  root: Schema,
  data: unknown,
  points = new Set<string>(),
): Set<string> {
  matchCache.clear();
  cover(root, root, "#", data, points, new Set());
  return points;
}

function cover(
  root: Schema,
  schema: Schema,
  path: string,
  data: unknown,
  points: Set<string>,
  seen: Set<string>,
): void {
  const resolved = deref(root, schema, path, new Set());
  if (!resolved) return;
  schema = resolved.schema;
  path = resolved.path;
  const cycleKey = `${path}::${JSON.stringify(data)}`;
  if (seen.has(cycleKey)) return;
  seen.add(cycleKey);

  if (typeof schema.pattern === "string" && typeof data === "string") {
    if (new RegExp(schema.pattern).test(data)) points.add(`pattern:${path}`);
  }
  if (schema.const !== undefined && data === schema.const) {
    points.add(`const:${path}:${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && schema.enum.some((v) => v === data)) {
    points.add(`enum:${path}:${JSON.stringify(data)}`);
  }

  if (data && typeof data === "object" && !Array.isArray(data)) {
    const rec = data as Record<string, unknown>;
    const properties = asSchema(schema.properties);
    for (const [key, value] of Object.entries(rec)) {
      if (properties && key in properties) {
        points.add(`property:${path}/properties/${key}`);
        const child = asSchema(properties[key]);
        if (child) {
          cover(
            root,
            child,
            pointerJoin(path, "properties", key),
            value,
            points,
            seen,
          );
        }
      } else {
        const additionalSchema = asSchema(schema.additionalProperties);
        if (additionalSchema) {
          cover(
            root,
            additionalSchema,
            pointerJoin(path, "additionalProperties"),
            value,
            points,
            seen,
          );
        }
      }
    }
    const names = asSchema(schema.propertyNames);
    if (names) {
      for (const key of Object.keys(rec)) {
        cover(root, names, pointerJoin(path, "propertyNames"), key, points, seen);
      }
    }
  }

  if (Array.isArray(data)) {
    const items = asSchema(schema.items);
    if (items) {
      for (const item of data) {
        cover(root, items, pointerJoin(path, "items"), item, points, seen);
      }
    }
  }

  for (const key of ["oneOf", "anyOf"] as const) {
    const list = schema[key];
    if (!Array.isArray(list)) continue;
    list.forEach((entry, i) => {
      const child = asSchema(entry);
      if (!child) return;
      if (!matches(root, child, data, pointerJoin(path, key, String(i)))) return;
      points.add(`${key}:${path}:${i}`);
      cover(root, child, pointerJoin(path, key, String(i)), data, points, seen);
    });
  }

  const allOf = schema.allOf;
  if (Array.isArray(allOf)) {
    allOf.forEach((entry, i) => {
      const child = asSchema(entry);
      if (child) {
        cover(root, child, pointerJoin(path, "allOf", String(i)), data, points, seen);
      }
    });
  }
}

export type InvalidMeta = {
  covers: string[];
  includes?: string[];
  types?: string;
  datasource?: string;
};

export function parseInvalidSample(text: string): { meta: InvalidMeta; yaml: string } {
  const parts = text.split(/^---\s*$/m).map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length < 2) {
    throw new Error("invalid sample must be YAML multi-doc: expect mapping, then ---, then document");
  }
  const metaDoc = parseDocument(parts[0]).toJS() as { expect?: unknown };
  const expect = metaDoc.expect;
  if (!expect || typeof expect !== "object") {
    throw new Error("invalid sample first document must have an expect mapping");
  }
  const rec = expect as Record<string, unknown>;
  const coversRaw = rec.covers;
  const covers = Array.isArray(coversRaw)
    ? coversRaw.map(String)
    : coversRaw != null
      ? [String(coversRaw)]
      : [];
  const includesRaw = rec.includes;
  const includes = Array.isArray(includesRaw)
    ? includesRaw.map(String)
    : includesRaw != null
      ? [String(includesRaw)]
      : undefined;
  const types = typeof rec.types === "string" ? rec.types : undefined;
  const datasource = typeof rec.datasource === "string" ? rec.datasource : undefined;
  if (covers.length === 0 && (includes?.length ?? 0) === 0) {
    throw new Error("expect.covers or expect.includes is required");
  }
  return { meta: { covers, includes, types, datasource }, yaml: parts.slice(1).join("\n---\n") };
}
