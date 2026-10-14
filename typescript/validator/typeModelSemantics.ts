import { asRecord } from "./yamlPositions.ts";
import type { SpecValidationResult } from "./types.ts";
import type { ParsedYaml } from "./SpecValidator.ts";
import { pushUnique, singleKey, specErr } from "./semanticsUtil.ts";

/** `set` injects `id`. `dictionary` is known but injects nothing. */
const BUILT_IN: Record<string, readonly string[]> = {
  set: ["id"],
  dictionary: [],
};

const RESERVED_TYPE_NAMES = new Set(["set", "dictionary"]);

/** Primary label. `inherit` may also carry `union` — those members compose. */
type TypeKind = "inherit" | "union" | "shaped";

type TypeInfo = {
  path: string;
  kind: TypeKind;
  tags: string[];
  inherits?: string;
  union?: string[];
  mapping?: Record<string, string>;
  mappingPath?: string;
  extract?: string[];
  extractPath?: string;
  removeFields?: string[];
  removeFieldsPath?: string;
  ids?: string[];
  idFields: string[];
  fields: Map<string, string>;
  fieldTypes: Map<string, string>;
  fieldReferences: Map<string, string | [string, string]>;
};

type SourcedName = { source: string; name: string; original: string };

type FieldRef = { type: string; field: string };

const hasAuthoredIdentity = (info: TypeInfo): boolean =>
  (info.ids !== undefined && info.ids.length > 0) || info.idFields.length > 0;

function typeKind(def: Record<string, unknown>): TypeKind {
  if (typeof def.inherits === "string") return "inherit";
  if (Array.isArray(def.union)) return "union";
  return "shaped";
}

function mappingOf(
  def: Record<string, unknown>,
): Record<string, string> | undefined {
  const rec = asRecord(def.mapping);
  if (!rec) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string");
}

function referencesOf(
  body: Record<string, unknown> | undefined,
): string | [string, string] | undefined {
  const raw = body?.references;
  if (typeof raw === "string") return raw;
  if (
    Array.isArray(raw) &&
    raw.length === 2 &&
    raw.every((v) => typeof v === "string")
  ) {
    return [raw[0] as string, raw[1] as string];
  }
  return undefined;
}

function refParts(raw: string | [string, string]): FieldRef[] {
  return (Array.isArray(raw) ? raw : [raw]).map((item) => {
    const split = splitRemoveField(item);
    return { type: split.source ?? "", field: split.name };
  });
}

function identityNames(
  name: string,
  types: Map<string, TypeInfo>,
  stack: Set<string> = new Set(),
): Set<string> {
  if (stack.has(name)) return new Set();
  const info = types.get(name);
  if (!info) return new Set();
  if (info.ids !== undefined && info.ids.length > 0) return new Set(info.ids);
  if (info.idFields.length > 0) return new Set(info.idFields);
  if (info.inherits === "set") return new Set(["id"]);
  if (info.inherits && info.inherits !== "dictionary") {
    stack.add(name);
    return identityNames(info.inherits, types, stack);
  }
  return new Set();
}

function isOwnerIdentityRef(
  raw: string | [string, string],
  self: string,
  types: Map<string, TypeInfo>,
): boolean {
  const parts = refParts(raw);
  const owner = parts[0]!.type;
  if (!owner || owner === self || !types.has(owner)) return false;
  const identity = identityNames(owner, types);
  return parts.every((p) => p.type === owner && identity.has(p.field));
}

/** Bare `id` or qualified `contact_source.id`. */
function splitRemoveField(entry: string): { source?: string; name: string } {
  const dot = entry.indexOf(".");
  if (dot === -1) return { name: entry };
  return { source: entry.slice(0, dot), name: entry.slice(dot + 1) };
}

function collectTypes(
  parsed: ParsedYaml,
): { types: Map<string, TypeInfo>; errors: SpecValidationResult["errors"] } {
  const errors: SpecValidationResult["errors"] = [];
  const types = new Map<string, TypeInfo>();
  const list = asRecord(parsed.data)?.types;
  if (!Array.isArray(list)) return { types, errors };

  const seen = new Set<string>();
  list.forEach((entry, ti) => {
    const pair = singleKey(entry);
    if (!pair) return;
    const path = `/types/${ti}/${pair.key}`;
    if (!pushUnique(seen, pair.key, errors, parsed, path, `duplicate type '${pair.key}'`)) {
      return;
    }
    if (RESERVED_TYPE_NAMES.has(pair.key)) {
      errors.push(
        specErr(parsed, path, `'${pair.key}' is a reserved type name`),
      );
      return;
    }
    const def = asRecord(pair.body);
    if (!def) return;
    const fields = new Map<string, string>();
    const fieldTypes = new Map<string, string>();
    const fieldReferences = new Map<string, string | [string, string]>();
    const idFields: string[] = [];
    const fieldList = def.fields;
    if (Array.isArray(fieldList)) {
      const seenFields = new Set<string>();
      fieldList.forEach((field, fi) => {
        const fp = singleKey(field);
        if (!fp) return;
        const fieldPath = `${path}/fields/${fi}/${fp.key}`;
        if (
          !pushUnique(
            seenFields,
            fp.key,
            errors,
            parsed,
            fieldPath,
            `duplicate field '${fp.key}' on ${pair.key}`,
          )
        ) {
          return;
        }
        fields.set(fp.key, fieldPath);
        const body = asRecord(fp.body);
        if (typeof body?.type === "string") fieldTypes.set(fp.key, body.type);
        if (body?.is_id === true) idFields.push(fp.key);
        const references = referencesOf(body);
        if (references !== undefined) fieldReferences.set(fp.key, references);
      });
    }
    types.set(pair.key, {
      path,
      kind: typeKind(def),
      tags: stringList(def.tags) ?? [],
      inherits: typeof def.inherits === "string" ? def.inherits : undefined,
      union: stringList(def.union),
      mapping: mappingOf(def),
      mappingPath: def.mapping !== undefined ? `${path}/mapping` : undefined,
      extract: stringList(def.extract),
      extractPath: def.extract !== undefined ? `${path}/extract` : undefined,
      removeFields: stringList(def.remove_fields),
      removeFieldsPath:
        def.remove_fields !== undefined ? `${path}/remove_fields` : undefined,
      ids: stringList(def.ids),
      idFields,
      fields,
      fieldTypes,
      fieldReferences,
    });
  });
  return { types, errors };
}

function applyExtract(
  fields: SourcedName[],
  extract?: string[],
): SourcedName[] {
  if (!extract?.length) return fields;
  const allow = new Map<string, Set<string>>();
  for (const item of extract) {
    const ref = splitRemoveField(item);
    if (ref.source === undefined) continue;
    let set = allow.get(ref.source);
    if (!set) {
      set = new Set();
      allow.set(ref.source, set);
    }
    set.add(ref.name);
  }
  return fields.filter((f) => {
    const keep = allow.get(f.source);
    if (!keep) return true;
    return keep.has(f.name);
  });
}

function applyMapping(
  fields: SourcedName[],
  mapping?: Record<string, string>,
): SourcedName[] {
  if (!mapping) return fields;
  return fields.map((f) => {
    const qualified = mapping[`${f.source}.${f.name}`];
    if (qualified !== undefined) return { ...f, name: qualified };
    const bare = mapping[f.name];
    if (bare !== undefined) return { ...f, name: bare };
    return f;
  });
}

function applyRemove(
  fields: SourcedName[],
  remove?: string[],
): SourcedName[] {
  if (!remove?.length) return fields;
  return fields.filter((f) => {
    for (const item of remove) {
      const ref = splitRemoveField(item);
      if (ref.source === undefined) {
        if (f.name === ref.name) return false;
        continue;
      }
      if (f.source === ref.source && f.name === ref.name) return false;
    }
    return true;
  });
}

function parentFields(
  name: string,
  types: Map<string, TypeInfo>,
  stack: Set<string>,
): SourcedName[] | { cycle: string } {
  const resolved = composeFields(name, types, stack);
  if ("cycle" in resolved) return resolved;
  const info = types.get(name);
  const nested =
    info?.inherits === "dictionary"
      ? resolved.filter((f) => {
          const ref = info.fieldReferences.get(f.original);
          return ref === undefined || !isOwnerIdentityRef(ref, name, types);
        })
      : resolved;
  return nested.map((f) => ({
    source: name,
    name: f.name,
    original: f.name,
  }));
}

function composeFields(
  name: string,
  types: Map<string, TypeInfo>,
  stack: Set<string>,
): SourcedName[] | { cycle: string } {
  if (BUILT_IN[name]) {
    return BUILT_IN[name].map((n) => ({ source: name, name: n, original: n }));
  }
  if (stack.has(name)) return { cycle: name };
  const info = types.get(name);
  /* v8 ignore next -- callers only pass built-ins or collected type names */
  if (!info) return [];
  stack.add(name);
  const fields: SourcedName[] = [];
  if (info.inherits) {
    if (!(info.inherits === "set" && hasAuthoredIdentity(info))) {
      const parent = parentFields(info.inherits, types, stack);
      if ("cycle" in parent) return parent;
      fields.push(...parent);
    }
  }
  for (const member of info.union ?? []) {
    const part = parentFields(member, types, stack);
    if ("cycle" in part) return part;
    fields.push(...part);
  }
  stack.delete(name);
  const kept = applyRemove(
    applyMapping(applyExtract(fields, info.extract), info.mapping),
    info.removeFields,
  );
  const out: SourcedName[] = kept.map((f) => ({
    source: name,
    name: f.name,
    original: f.name,
  }));
  for (const local of info.fields.keys()) {
    out.push({ source: name, name: local, original: local });
  }
  return out;
}

function inheritedNames(
  name: string,
  types: Map<string, TypeInfo>,
  stack: Set<string>,
): Set<string> | { cycle: string } {
  const resolved = composeFields(name, types, stack);
  if ("cycle" in resolved) return resolved;
  return new Set(resolved.map((f) => f.name));
}

function checkComposition(
  parsed: ParsedYaml,
  types: Map<string, TypeInfo>,
): SpecValidationResult["errors"] {
  const errors: SpecValidationResult["errors"] = [];
  for (const [name, info] of types) {
    const sources: string[] = [];
    if (info.inherits) {
      if (!BUILT_IN[info.inherits] && !types.has(info.inherits)) {
        errors.push(
          specErr(
            parsed,
            `${info.path}/inherits`,
            `unknown inherit target '${info.inherits}' on ${name}`,
          ),
        );
      } else {
        sources.push(info.inherits);
      }
    }
    info.union?.forEach((member, i) => {
      if (BUILT_IN[member] || types.has(member)) {
        sources.push(member);
        return;
      }
      errors.push(
        specErr(
          parsed,
          `${info.path}/union/${i}`,
          `unknown type '${member}' in union on ${name}`,
        ),
      );
    });

    const sourced: SourcedName[] = [];
    const available = new Set<string>();
    for (const src of sources) {
      if (src === "set" && hasAuthoredIdentity(info)) continue;
      const part = parentFields(src, types, new Set([name]));
      if ("cycle" in part) {
        errors.push(
          specErr(
            parsed,
            info.path,
            `circular inherit/union involving '${part.cycle}'`,
          ),
        );
        continue;
      }
      sourced.push(...part);
      for (const f of part) available.add(f.name);
    }

    const composeSources = new Set<string>();
    if (info.inherits) composeSources.add(info.inherits);
    for (const member of info.union ?? []) composeSources.add(member);

    const checkQualified = (
      field: string,
      path: string,
      label: string,
    ): boolean => {
      const ref = splitRemoveField(field);
      if (ref.source === undefined) return false;
      if (!BUILT_IN[ref.source] && !types.has(ref.source)) {
        errors.push(
          specErr(
            parsed,
            path,
            `unknown type '${ref.source}' in ${label} on ${name}`,
          ),
        );
        return true;
      }
      if (!composeSources.has(ref.source)) {
        errors.push(
          specErr(
            parsed,
            path,
            `${label} '${field}' is not from an inherit or union source of ${name}`,
          ),
        );
        return true;
      }
      const part = inheritedNames(ref.source, types, new Set([name]));
      if ("cycle" in part) return true;
      if (part.has(ref.name)) return true;
      errors.push(
        specErr(
          parsed,
          path,
          `${label} '${field}' is not a field on ${ref.source}`,
        ),
      );
      return true;
    };

    info.extract?.forEach((field, i) => {
      const path = `${info.extractPath}/${i}`;
      if (checkQualified(field, path, "extract")) return;
      errors.push(
        specErr(
          parsed,
          path,
          `extract '${field}' is not a field on the inherited or unioned shape of ${name}`,
        ),
      );
    });

    if (info.mapping) {
      Object.keys(info.mapping).forEach((from) => {
        const path = `${info.mappingPath}/${from}`;
        if (checkQualified(from, path, "mapping")) return;
        const matches = sourced.filter((f) => f.name === from);
        if (matches.length === 0) {
          errors.push(
            specErr(
              parsed,
              path,
              `mapping '${from}' is not a field on the inherited or unioned shape of ${name}`,
            ),
          );
          return;
        }
        if (matches.length > 1) {
          errors.push(
            specErr(
              parsed,
              path,
              `mapping '${from}' matches more than one source on ${name}; qualify it`,
            ),
          );
        }
      });
    }

    info.removeFields?.forEach((field, i) => {
      const path = `${info.removeFieldsPath}/${i}`;
      const ref = splitRemoveField(field);
      if (ref.source === undefined) {
        if (available.has(ref.name)) return;
        errors.push(
          specErr(
            parsed,
            path,
            `remove_fields '${field}' is not a field on the inherited or unioned shape of ${name}`,
          ),
        );
        return;
      }
      checkQualified(field, path, "remove_fields");
    });

    const composed = applyRemove(
      applyMapping(applyExtract(sourced, info.extract), info.mapping),
      info.removeFields,
    );
    const seenNames = new Map<string, SourcedName>();
    const reportDup = (field: SourcedName, path: string) => {
      const prev = seenNames.get(field.name);
      if (prev) {
        errors.push(
          specErr(
            parsed,
            path,
            `${prev.source}.${prev.original} and ${field.source}.${field.original} collide on the composed shape of ${name}; use mapping or remove_fields and give new names`,
          ),
        );
        return;
      }
      seenNames.set(field.name, field);
    };
    for (const field of composed) reportDup(field, info.path);
    for (const [fieldName, fieldPath] of info.fields) {
      reportDup(
        { source: name, name: fieldName, original: fieldName },
        fieldPath,
      );
    }
  }
  return errors;
}

function fieldNamesOf(
  name: string,
  types: Map<string, TypeInfo>,
): Set<string> {
  if (BUILT_IN[name]) return new Set(BUILT_IN[name]);
  const resolved = inheritedNames(name, types, new Set());
  return "cycle" in resolved ? new Set() : resolved;
}

function checkReferences(
  parsed: ParsedYaml,
  types: Map<string, TypeInfo>,
): SpecValidationResult["errors"] {
  const errors: SpecValidationResult["errors"] = [];
  const list = asRecord(parsed.data)?.types;
  if (!Array.isArray(list)) return errors;

  const checkRef = (ref: string, refPath: string, checkField: boolean) => {
    const [refType, refCol] = ref.split(".");
    if (!refType || !refCol) return;
    if (!types.has(refType) && !BUILT_IN[refType]) {
      errors.push(
        specErr(parsed, refPath, `unknown type '${refType}' in references`),
      );
      return;
    }
    if (
      checkField &&
      refCol !== "id" &&
      !fieldNamesOf(refType, types).has(refCol)
    ) {
      errors.push(
        specErr(
          parsed,
          refPath,
          `unknown field '${refCol}' on ${refType} in references`,
        ),
      );
    }
  };

  const isTypeName = (raw: unknown): boolean => {
    if (typeof raw !== "string") return false;
    const base =
      raw.endsWith("[]") || raw.endsWith("{}") ? raw.slice(0, -2) : raw;
    return types.has(base);
  };

  list.forEach((entry, ti) => {
    const pair = singleKey(entry);
    if (!pair) return;
    const fields = asRecord(pair.body)?.fields;
    if (!Array.isArray(fields)) return;
    fields.forEach((field, fi) => {
      const fp = singleKey(field);
      if (!fp) return;
      const body = asRecord(fp.body);
      const ref = body?.references;
      const refPath = `/types/${ti}/${pair.key}/fields/${fi}/${fp.key}/references`;
      const checkField = !isTypeName(body?.type);
      if (typeof ref === "string") {
        checkRef(ref, refPath, checkField);
        return;
      }
      if (!Array.isArray(ref)) return;
      ref.forEach((item, i) => {
        if (typeof item === "string") checkRef(item, `${refPath}/${i}`, checkField);
      });
    });
  });
  return errors;
}

function checkDecimalSizes(parsed: ParsedYaml): SpecValidationResult["errors"] {
  const errors: SpecValidationResult["errors"] = [];
  const list = asRecord(parsed.data)?.types;
  if (!Array.isArray(list)) return errors;
  list.forEach((entry, ti) => {
    const pair = singleKey(entry);
    if (!pair) return;
    const fields = asRecord(pair.body)?.fields;
    if (!Array.isArray(fields)) return;
    fields.forEach((field, fi) => {
      const fp = singleKey(field);
      if (!fp) return;
      const fdef = asRecord(fp.body);
      if (fdef?.type !== "decimal") return;
      const size = fdef.size;
      if (!Array.isArray(size) || size.length !== 2) return;
      const precision = size[0];
      const scale = size[1];
      if (typeof precision !== "number" || typeof scale !== "number") return;
      const path = `/types/${ti}/${pair.key}/fields/${fi}/${fp.key}/size`;
      if (scale > precision) {
        errors.push(
          specErr(
            parsed,
            path,
            `decimal size scale must be <= precision (${precision})`,
          ),
        );
      }
    });
  });
  return errors;
}

function checkIdentity(
  parsed: ParsedYaml,
  types: Map<string, TypeInfo>,
): SpecValidationResult["errors"] {
  const errors: SpecValidationResult["errors"] = [];
  const list = asRecord(parsed.data)?.types;
  if (!Array.isArray(list)) return errors;

  list.forEach((entry, ti) => {
    const pair = singleKey(entry);
    if (!pair) return;
    const def = asRecord(pair.body);
    if (!def) return;
    const path = `/types/${ti}/${pair.key}`;
    const idFields: string[] = [];
    const fields = def.fields;
    if (Array.isArray(fields)) {
      fields.forEach((field, fi) => {
        const fp = singleKey(field);
        if (!fp) return;
        if (asRecord(fp.body)?.is_id !== true) return;
        const fieldPath = `${path}/fields/${fi}/${fp.key}/is_id`;
        if (idFields.length > 0) {
          errors.push(
            specErr(
              parsed,
              fieldPath,
              `is_id: true may appear on at most one field on ${pair.key}`,
            ),
          );
        }
        idFields.push(fieldPath);
      });
    }
    if (Array.isArray(def.ids) && idFields.length > 0) {
      errors.push(
        specErr(
          parsed,
          `${path}/ids`,
          `ids and is_id are mutually exclusive on ${pair.key}`,
        ),
      );
    }
    if (!Array.isArray(def.ids)) return;
    const known = fieldNamesOf(pair.key, types);
    def.ids.forEach((name, i) => {
      if (typeof name !== "string") return;
      if (known.has(name)) return;
      errors.push(
        specErr(
          parsed,
          `${path}/ids/${i}`,
          `ids '${name}' is not a field on ${pair.key}`,
        ),
      );
    });
  });
  return errors;
}

const PRIMITIVE_FIELD_TYPES = new Set([
  "string",
  "character",
  "number",
  "integer",
  "unsignedinteger",
  "biginteger",
  "unsignedbiginteger",
  "smallinteger",
  "unsignedsmallinteger",
  "float",
  "decimal",
  "boolean",
  "datetime",
  "binary",
  "uuid",
]);

const fieldTypeBase = (raw: string): string =>
  raw.endsWith("[]") || raw.endsWith("{}") ? raw.slice(0, -2) : raw;

const isViewOnlyDictionary = (info: TypeInfo): boolean =>
  info.tags.includes("view_type") && !info.tags.includes("datasource_type");

function checkDictionary(
  parsed: ParsedYaml,
  types: Map<string, TypeInfo>,
): SpecValidationResult["errors"] {
  const errors: SpecValidationResult["errors"] = [];
  for (const [name, info] of types) {
    if (info.inherits !== "dictionary") continue;
    if (!info.fields.has("key")) {
      errors.push(
        specErr(
          parsed,
          `${info.path}/fields`,
          `dictionary type ${name} must include a key field`,
        ),
      );
    }
    if (!info.fields.has("value")) {
      errors.push(
        specErr(
          parsed,
          `${info.path}/fields`,
          `dictionary type ${name} must include a value field`,
        ),
      );
    }
    const isDatasource = info.tags.includes("datasource_type");
    const isView = info.tags.includes("view_type");
    if (isDatasource && isView) {
      errors.push(
        specErr(
          parsed,
          info.path,
          `dictionary type ${name} must not be tagged both datasource_type and view_type`,
        ),
      );
    }
    const ownerCount = [...info.fieldReferences.values()].filter((ref) =>
      isOwnerIdentityRef(ref, name, types),
    ).length;
    if (isViewOnlyDictionary(info)) {
      if (ownerCount > 0) {
        errors.push(
          specErr(
            parsed,
            info.path,
            `view-only dictionary type ${name} must not reference an owner identity`,
          ),
        );
      }
    } else if (ownerCount === 0) {
      errors.push(
        specErr(
          parsed,
          info.path,
          `dictionary type ${name} must have one field that references the owner identity`,
        ),
      );
    }
    const valueType = info.fieldTypes.get("value");
    if (valueType !== undefined) {
      const base = fieldTypeBase(valueType);
      if (!PRIMITIVE_FIELD_TYPES.has(base)) {
        const valueInfo = types.get(base);
        if (valueInfo?.tags.includes("datasource_type")) {
          errors.push(
            specErr(
              parsed,
              `${info.path}/fields`,
              `dictionary type ${name} value must not be a datasource_type`,
            ),
          );
        }
      }
    }
  }
  return errors;
}

function checkMapFields(
  parsed: ParsedYaml,
  types: Map<string, TypeInfo>,
): SpecValidationResult["errors"] {
  const errors: SpecValidationResult["errors"] = [];
  for (const [typeName, info] of types) {
    for (const [fieldName, fieldPath] of info.fields) {
      const rawType = info.fieldTypes.get(fieldName);
      if (rawType === undefined || !rawType.endsWith("{}")) continue;
      const dictName = rawType.slice(0, -2);
      const dict = types.get(dictName);
      if (dict?.inherits !== "dictionary") {
        errors.push(
          specErr(
            parsed,
            `${fieldPath}/type`,
            `${typeName}.${fieldName} type ${rawType} must name a dictionary type`,
          ),
        );
        continue;
      }
      const expected = `${dictName}.key`;
      const ref = info.fieldReferences.get(fieldName);
      if (ref !== expected) {
        errors.push(
          specErr(
            parsed,
            `${fieldPath}/references`,
            `${typeName}.${fieldName} must reference ${expected}`,
          ),
        );
      }
    }
  }
  return errors;
}

export function checkTypeModel(parsed: ParsedYaml): SpecValidationResult {
  const { types, errors } = collectTypes(parsed);
  errors.push(...checkComposition(parsed, types));
  errors.push(...checkDictionary(parsed, types));
  errors.push(...checkMapFields(parsed, types));
  errors.push(...checkReferences(parsed, types));
  errors.push(...checkDecimalSizes(parsed));
  errors.push(...checkIdentity(parsed, types));
  return errors.length === 0
    ? { valid: true, errors: [] }
    : { valid: false, errors };
}

function typeInfoFromEntry(entry: unknown): { name: string; info: TypeInfo } | null {
  const pair = singleKey(entry);
  if (!pair) return null;
  const def = asRecord(pair.body);
  if (!def) return null;
  const fields = new Map<string, string>();
  const fieldTypes = new Map<string, string>();
  const fieldReferences = new Map<string, string | [string, string]>();
  if (Array.isArray(def.fields)) {
    def.fields.forEach((field, fi) => {
      const fp = singleKey(field);
      if (!fp) return;
      fields.set(fp.key, `/types/${fp.key}/fields/${fi}`);
      const body = asRecord(fp.body);
      if (typeof body?.type === "string") fieldTypes.set(fp.key, body.type);
      const references = referencesOf(body);
      if (references !== undefined) fieldReferences.set(fp.key, references);
    });
  }
  return {
    name: pair.key,
    info: {
      path: `/types/${pair.key}`,
      kind: typeKind(def),
      tags: stringList(def.tags) ?? [],
      inherits: typeof def.inherits === "string" ? def.inherits : undefined,
      union: stringList(def.union),
      mapping: mappingOf(def),
      extract: stringList(def.extract),
      removeFields: stringList(def.remove_fields),
      ids: stringList(def.ids),
      idFields: Array.isArray(def.fields)
        ? def.fields.flatMap((field) => {
            const fp = singleKey(field);
            return fp && asRecord(fp.body)?.is_id === true ? [fp.key] : [];
          })
        : [],
      fields,
      fieldTypes,
      fieldReferences,
    },
  };
}

export function indexTypeFields(
  data: unknown,
): Map<string, Map<string, Record<string, unknown>>> {
  const out = new Map<string, Map<string, Record<string, unknown>>>();
  const list = asRecord(data)?.types;
  if (!Array.isArray(list)) return out;
  const infos = new Map<string, TypeInfo>();
  for (const entry of list) {
    const parsed = typeInfoFromEntry(entry);
    if (parsed) infos.set(parsed.name, parsed.info);
  }
  for (const entry of list) {
    const pair = singleKey(entry);
    if (!pair) continue;
    const def = asRecord(pair.body);
    const fields = new Map<string, Record<string, unknown>>();
    for (const name of fieldNamesOf(pair.key, infos)) {
      fields.set(name, {});
    }
    if (Array.isArray(def?.fields)) {
      for (const field of def.fields) {
        const fp = singleKey(field);
        if (!fp) continue;
        fields.set(fp.key, asRecord(fp.body) ?? {});
      }
    }
    out.set(pair.key, fields);
  }
  return out;
}
