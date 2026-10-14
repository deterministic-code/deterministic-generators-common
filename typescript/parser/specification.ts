export const TYPES_YAML = "types.yaml";
export const DATASOURCE_YAML = "datasource.yaml";
export const DATASOURCE_SEEDS_YAML = "datasource_seeds.yaml";
export const SERVICES_YAML = "services.yaml";
export const ROUTES_YAML = "routes.yaml";

export type SeedValue = string | number | boolean | null;
export type SeedRow = { id: number; row: Record<string, SeedValue> };
export type FieldKind = "primitive" | "type";

export type TypeField = {
  name: string;
  type: string;
  kind: FieldKind;
  base: string;
  isArray: boolean;
  isMap?: boolean;
  isNullable: boolean;
  isId?: boolean;
  size?: number | [number, number] | "unlimited";
  minSize?: number;
  references?: string | [string, string];
  hasDefault?: boolean;
  defaultValue?: string | number | boolean | null;
};

/** Primary label. `inherit` may also carry `union` — those members compose. */
export type TypeKind = "inherit" | "union" | "shaped";

export type Type = {
  name: string;
  tags: string[];
  kind: TypeKind;
  inherits?: string;
  union?: string[];
  mapping?: Record<string, string>;
  extract?: string[];
  removeFields?: string[];
  ids?: string[];
  fields: TypeField[];
};

export type DatasourceFieldOverlay = {
  name: string;
  isReadonly?: boolean;
  isUnique?: boolean;
  mapping?: string;
  isFixedId?: boolean;
  isOptimisticConcurrency?: boolean;
  useNativeRowVersion?: boolean;
};

export type DatasourceIndex = { name: string; fields: string[]; isUnique: boolean };

export type DatasourceTable = {
  name: string;
  mapping?: string;
  fields: DatasourceFieldOverlay[];
  indexes: DatasourceIndex[];
  uniqueIndexFields: string[];
  useOptimisticConcurrency?: boolean;
};

export type ServiceByField = { field: string; type: string; size?: number };

export type ServiceCandidate = {
  name: string;
  tags: string[];
  inherits?: string;
  byFields: ServiceByField[];
};

export type CustomServiceEntry = { name: string; module?: string; methods: string[] };
export type ParsedServices = { generics: ServiceCandidate[]; customs: CustomServiceEntry[] };
export type RouteByField = { byField: string; methods?: string[]; byFieldUnique: boolean };

export type RouteCandidate = {
  name: string;
  tags: string[];
  inherits?: string;
  byFields: RouteByField[];
  eagerReadPath?: string[];
  eagerUpdatePath?: string[];
  eagerReadMemberOnly?: string[];
};

export type CustomRouteEntry = {
  name: string;
  path?: string;
  method?: string;
  entity: string | null;
  request?: string;
  response?: string;
  module?: string;
  routeClass?: string;
};

type NestedRouteBase = {
  parent: string;
  parentParam: string;
  parentBasePath: string;
  segment: string;
  segmentTail: string;
};

export type DirectFkDescriptor = NestedRouteBase & {
  kind: "direct-fk";
  child: { name: string };
  fkColumn: string;
};

export type M2mDescriptor = NestedRouteBase & {
  kind: "m2m";
  junction: string;
  target: string;
  targetParam: string;
  parentFkField: string;
  childFkField: string;
};

export type NestedRouteDescriptor = DirectFkDescriptor | M2mDescriptor;

export type ParsedRoutes = {
  candidates: RouteCandidate[];
  customs: CustomRouteEntry[];
  nested: NestedRouteDescriptor[];
  childrenOnly: Set<string>;
  datasource: DatasourceTable[];
};

const PRIMITIVES = new Set([
  "string", "character", "number", "integer", "unsignedinteger",
  "biginteger", "unsignedbiginteger", "smallinteger", "unsignedsmallinteger",
  "float", "decimal", "boolean", "datetime", "binary", "uuid", "reference",
]);

const SET_FIELDS: TypeField[] = [{
  name: "id",
  type: "integer",
  kind: "primitive",
  base: "integer",
  isArray: false,
  isMap: false,
  isNullable: false,
}];

export const parseFieldType = (
  raw: string,
): { kind: FieldKind; base: string; isArray: boolean; isMap: boolean } => {
  const isArray = raw.endsWith("[]");
  const isMap = raw.endsWith("{}");
  const base = isArray || isMap ? raw.slice(0, -2) : raw;
  return {
    kind: PRIMITIVES.has(base) ? "primitive" : "type",
    base,
    isArray,
    isMap,
  };
};

type IdentityType = Pick<Type, "inherits" | "fields" | "ids">;

const markedIds = (type: IdentityType): string[] =>
  type.fields.filter((f) => f.isId === true).map((f) => f.name);

export const hasAuthoredIdentity = (type: IdentityType): boolean =>
  (type.ids !== undefined && type.ids.length > 0) || markedIds(type).length > 0;

export const identityColumns = (type?: IdentityType): string[] => {
  if (!type) return ["id"];
  if (type.ids !== undefined && type.ids.length > 0) return [...type.ids];
  const marked = markedIds(type);
  return marked.length > 0 ? marked : type.inherits === "set" ? ["id"] : [];
};

export const primaryKeyColumn = (
  _table: DatasourceTable | undefined,
  type?: Type,
): string => identityColumns(type)[0] ?? "id";

export const uniqueLookupFields = (
  type: Type,
  table?: DatasourceTable,
): ServiceByField[] => {
  const out: ServiceByField[] = [];
  const add = (name: string) => {
    if (out.some((e) => e.field === name)) return;
    const f = type.fields.find((x) => x.name === name);
    out.push({
      field: name,
      type: typeof f?.type === "string" ? f.type : "string",
      ...(typeof f?.size === "number" ? { size: f.size } : {}),
    });
  };
  for (const name of identityColumns(type)) add(name);
  for (const overlay of table?.fields ?? []) if (overlay.isUnique) add(overlay.name);
  for (const name of table?.uniqueIndexFields ?? []) add(name);
  return out;
};

type SourcedField = TypeField & { source?: string; original?: string };

const splitDot = (value: string): [string, string] | undefined => {
  const i = value.indexOf(".");
  return i === -1 ? undefined : [value.slice(0, i), value.slice(i + 1)];
};

const identityFieldNames = (
  type: Type | undefined,
  byName: Map<string, Type>,
  stack: Set<string> = new Set(),
): Set<string> => {
  if (!type) return new Set();
  /* v8 ignore next -- expandTypes already rejects inherit cycles */
  if (stack.has(type.name)) return new Set();
  const local = identityColumns(type);
  if (local.length > 0) return new Set(local);
  if (type.inherits && type.inherits !== "dictionary") {
    stack.add(type.name);
    return identityFieldNames(byName.get(type.inherits), byName, stack);
  }
  return new Set();
};

/** Owner FK is omitted when a dictionary is flattened onto another type. */
const isOwnerIdentityRef = (
  references: TypeField["references"],
  selfName: string,
  byName: Map<string, Type>,
): boolean => {
  if (references === undefined) return false;
  const parts = (Array.isArray(references) ? references : [references]).map(
    (ref) => {
      const split = splitDot(ref);
      return split ? { type: split[0], field: split[1] } : { type: "", field: ref };
    },
  );
  const owner = parts[0]!.type;
  if (!owner || owner === selfName) return false;
  const identity = identityFieldNames(byName.get(owner), byName);
  return parts.every((p) => p.type === owner && identity.has(p.field));
};

/** For each source named in extract, keep only the listed fields. Unmentioned sources stay intact. */
const extractFields = (
  fields: SourcedField[],
  extract?: string[],
): SourcedField[] => {
  if (!extract?.length) return fields;
  const allow = new Map<string, Set<string>>();
  for (const item of extract) {
    const split = splitDot(item);
    if (!split) continue;
    const set = allow.get(split[0]) ?? new Set<string>();
    set.add(split[1]);
    allow.set(split[0], set);
  }
  return fields.filter((f) => {
    const keep = allow.get(f.source!);
    return !keep || keep.has(f.name);
  });
};

const renameFields = (
  fields: SourcedField[],
  mapping?: Record<string, string>,
): SourcedField[] =>
  mapping
    ? fields.map((f) => {
        const name = mapping[`${f.source}.${f.name}`] ?? mapping[f.name];
        return name !== undefined ? { ...f, name } : f;
      })
    : fields;

const assertUniqueFieldNames = (
  fields: SourcedField[],
  typeName: string,
): void => {
  const seen = new Map<string, SourcedField>();
  for (const field of fields) {
    const prev = seen.get(field.name);
    if (prev) {
      throw new Error(
        `${prev.source}.${prev.original} and ${field.source}.${field.original} collide on the composed shape of ${typeName}; use mapping or remove_fields and give new names`,
      );
    }
    seen.set(field.name, field);
  }
};

/** Bare `id` drops every field named `id`. Qualified `contact_source.id` drops `id` only from that source. */
const keepFields = (
  fields: SourcedField[],
  remove?: string[],
): SourcedField[] =>
  remove?.length
    ? fields.filter(
        (f) =>
          !remove.some((item) => {
            const split = splitDot(item);
            return split
              ? f.name === split[1] && f.source === split[0]
              : f.name === item;
          }),
      )
    : fields;

export const expandTypes = (types: Type[]): Type[] => {
  const byName = new Map(types.map((t) => [t.name, t]));
  const cache = new Map<string, TypeField[]>();

  const resolve = (name: string, stack: Set<string>): TypeField[] => {
    const hit = cache.get(name);
    if (hit) return hit;
    if (name === "set") {
      cache.set(name, SET_FIELDS);
      return SET_FIELDS;
    }
    if (stack.has(name)) {
      throw new Error(`circular inherit/union involving "${name}"`);
    }
    const type = byName.get(name);
    if (!type) return [];
    stack.add(name);
    const composeSource = (source: string): SourcedField[] => {
      const fields = resolve(source, stack).map((f) => ({
        ...f,
        source,
        original: f.name,
      }));
      const srcType = byName.get(source);
      return srcType?.inherits === "dictionary"
        ? fields.filter(
            (f) => !isOwnerIdentityRef(f.references, srcType.name, byName),
          )
        : fields;
    };
    const skipSetId = type.inherits === "set" && hasAuthoredIdentity(type);
    const inherited = [
      ...(type.inherits && !skipSetId ? composeSource(type.inherits) : []),
      ...(type.union ?? []).flatMap(composeSource),
    ];
    stack.delete(name);
    const merged = [
      ...keepFields(
        renameFields(extractFields(inherited, type.extract), type.mapping),
        type.removeFields,
      ),
      ...type.fields.map((f) => ({ ...f, source: name, original: f.name })),
    ];
    assertUniqueFieldNames(merged, name);
    const result = merged.map(({ source: _s, original: _o, ...rest }) => rest);
    cache.set(name, result);
    return result;
  };

  const resolveIds = (name: string, stack: Set<string>): string[] | undefined => {
    if (stack.has(name)) return undefined;
    const type = byName.get(name);
    if (!type) return undefined;
    if (type.ids !== undefined && type.ids.length > 0) return type.ids;
    if (type.fields.some((f) => f.isId === true)) return undefined;
    if (type.inherits && type.inherits !== "set" && type.inherits !== "dictionary") {
      stack.add(name);
      const ids = resolveIds(type.inherits, stack);
      stack.delete(name);
      return ids;
    }
    return undefined;
  };

  return types.map((type) => {
    const ids = type.ids ?? resolveIds(type.name, new Set());
    return {
      ...type,
      ...(ids !== undefined && ids.length > 0 ? { ids } : {}),
      fields: resolve(type.name, new Set()),
    };
  });
};

export const typeHasTag = (type: Type, tag: string): boolean =>
  type.tags.includes(tag);
