import pluralize from "pluralize";
import type { IDeterministicReader } from "../deterministic-reader.ts";
import { ensureHealth } from "../ensure-health.ts";
import { compileTypesFilter } from "./compile-filter.ts";
import { Deterministic, type IDeterministic } from "../deterministic.ts";
import {
  DATASOURCE_SEEDS_YAML,
  DATASOURCE_YAML,
  expandTypes,
  parseFieldType,
  primaryKeyColumn,
  ROUTES_YAML,
  SERVICES_YAML,
  TYPES_YAML,
  uniqueLookupFields,
  type CustomRouteEntry,
  type CustomServiceEntry,
  type DatasourceFieldOverlay,
  type DatasourceIndex,
  type DatasourceTable,
  type DirectFkDescriptor,
  type M2mDescriptor,
  type NestedRouteDescriptor,
  type ParsedRoutes,
  type ParsedServices,
  type RouteByField,
  type RouteCandidate,
  type SeedRow,
  type SeedValue,
  type ServiceCandidate,
  type Type,
  type TypeField,
  type TypeKind,
} from "../specification.ts";
import { compareByDatasourceTypeOrder } from "../datasource-type-tree.ts";
import { YamlNode } from "../yaml-node.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type { IDeterministic } from "../deterministic.ts";

type CombinedChildDef = { via?: string; target?: string; route?: string };
type CombinedRouteDef = {
  route?: string;
  combines?: Array<string | Record<string, CombinedChildDef>>;
};
type ByFieldParsed = {
  entity: string;
  byField: string;
  methods: string[] | null;
};
type NormalizedChild = {
  name: string;
  via: string | null;
  target: string | null;
  route: string | null;
};
type JunctionMatch = { name: string; parentFk: string; childFk: string };

const SHORTHAND_VERB_RE = /^(get|put|delete)_/i;
const VERB_TO_METHODS: Record<string, string[]> = {
  get: ["GET"],
  put: ["PUT"],
  delete: ["DELETE"],
};

const specName = (raw: string): string => raw.replace(/-/g, "_");

const shorthandField = (raw: string): string =>
  specName(raw)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();

const specPlural = (name: string): string => {
  const parts = specName(name).split("_");
  parts[parts.length - 1] = pluralize.plural(parts[parts.length - 1]!);
  return parts.join("_");
};

/** Walk `inherits`, skip set/dictionary, stop on missing or cycle. */
export const inheritsChain = (
  name: string,
  typeByName: Map<string, Type>,
): string[] => {
  const chain: string[] = [];
  const seen = new Set<string>([name]);
  let current = typeByName.get(name)?.inherits;
  while (current !== undefined) {
    if (current === "set" || current === "dictionary") break;
    if (seen.has(current)) break;
    seen.add(current);
    chain.push(current);
    current = typeByName.get(current)?.inherits;
  }
  return chain;
};

const parseSeedKey = (rowKey: string): number => {
  const m = /^id(\d+)$/.exec(rowKey);
  if (!m) {
    throw new Error(
      `Invalid seed row key "${rowKey}": expected pattern /^id\\d+$/`,
    );
  }
  return Number(m[1]);
};

const seedCells = (node: YamlNode): Record<string, SeedValue> => {
  const rec = node.record;
  if (rec === undefined) return {};
  const out: Record<string, SeedValue> = {};
  for (const key of Object.keys(rec)) {
    const value = node.literal(key);
    if (value !== undefined) out[key] = value;
  }
  return out;
};

const typeKind = (node: YamlNode): TypeKind => {
  if (node.str("inherits") !== undefined) return "inherit";
  if (Array.isArray(node.child("union").value)) return "union";
  return "shaped";
};

const mappingOf = (node: YamlNode): Record<string, string> | undefined => {
  const rec = node.child("mapping").record;
  if (!rec) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

const referencesOf = (
  node: YamlNode,
): string | [string, string] | undefined => {
  const raw = node.child("references").value;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && raw.length === 2 && raw.every((v) => typeof v === "string")) {
    return [raw[0] as string, raw[1] as string];
  }
  return undefined;
};

const sizeOf = (
  node: YamlNode,
): number | [number, number] | "unlimited" | undefined => {
  const raw = node.child("size").value;
  if (raw === "unlimited") return "unlimited";
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (
    Array.isArray(raw) &&
    raw.length === 2 &&
    raw.every((v) => typeof v === "number")
  ) {
    return [raw[0] as number, raw[1] as number];
  }
  return undefined;
};

export const DeterministicParser = (reader: IDeterministicReader) => {
  const parser = new Parser(reader);
  return {
    parse: (
      settings: Record<string, string>,
      opts?: { serviceClassName?: (entity: string) => string },
    ): Promise<IDeterministic> => parser.parse(settings, opts),
  };
};

class Parser {
  readonly #reader: IDeterministicReader;

  constructor(reader: IDeterministicReader) {
    this.#reader = reader;
  }

  async parse(
    settings: Record<string, string>,
    opts?: { serviceClassName?: (entity: string) => string },
  ): Promise<IDeterministic> {
    const reader = this.#reader;
    const serviceClassName = opts?.serviceClassName ?? ((entity) => entity);
    const [hasTypes, hasDs, hasSeeds, hasServices, hasRoutes] =
      await Promise.all([
        reader.exists(TYPES_YAML),
        reader.exists(DATASOURCE_YAML),
        reader.exists(DATASOURCE_SEEDS_YAML),
        reader.exists(SERVICES_YAML),
        reader.exists(ROUTES_YAML),
      ]);
    const [typesYaml, datasourceYaml, seedsYaml, servicesYaml, routesYaml] =
      await Promise.all([
        hasTypes ? reader.read(TYPES_YAML) : Promise.resolve(undefined),
        hasDs ? reader.read(DATASOURCE_YAML) : Promise.resolve(undefined),
        hasSeeds
          ? reader.read(DATASOURCE_SEEDS_YAML)
          : Promise.resolve(undefined),
        hasServices ? reader.read(SERVICES_YAML) : Promise.resolve(undefined),
        hasRoutes ? reader.read(ROUTES_YAML) : Promise.resolve(undefined),
      ]);

    const types =
      typesYaml !== undefined ? this.#parseTypes(typesYaml) : [];
    const expandedTypes = expandTypes(types);
    const datasource =
      datasourceYaml !== undefined
        ? this.#parseDatasource(datasourceYaml, expandedTypes)
        : [];
    const seeds =
      seedsYaml !== undefined
        ? this.#parseDatasourceSeeds(seedsYaml)
        : new Map();
    const services =
      servicesYaml !== undefined
        ? this.#parseServices({
            servicesYaml,
            types: expandedTypes,
            datasource,
            routesYaml,
            serviceClassName,
          })
        : { generics: [], customs: [] };
    const routes =
      routesYaml !== undefined
        ? this.#parseRoutes({
            routesYaml,
            types: expandedTypes,
            datasource,
          })
        : {
            candidates: [],
            customs: [],
            nested: [],
            childrenOnly: new Set<string>(),
            datasource,
          };

    return ensureHealth(
      new Deterministic({
        types,
        expandedTypes,
        datasource,
        datasourceSeeds: seeds,
        services,
        routes,
      }),
    );
  }

  #parseTypes(yaml: string): Type[] {
    return YamlNode.fromYaml(yaml).namedList("types").map(({ name, node }) => {
      const kind = typeKind(node);
      const mapping = mappingOf(node);
      const extract = node.strings("extract");
      const removeFields = node.strings("remove_fields");
      const ids = node.strings("ids");
      return {
        name,
        tags: node.strings("tags"),
        kind,
        ...(node.str("inherits") !== undefined
          ? { inherits: node.str("inherits") }
          : {}),
        ...(Array.isArray(node.child("union").value)
          ? { union: node.strings("union") }
          : {}),
        ...(mapping ? { mapping } : {}),
        ...(extract.length > 0 ? { extract } : {}),
        ...(removeFields.length > 0 ? { removeFields } : {}),
        ...(ids.length > 0 ? { ids } : {}),
        fields: node.namedList("fields").map(({ name: fname, node: fnode }) =>
          this.#readField(fname, fnode),
        ),
      };
    });
  }

  #readField(name: string, node: YamlNode): TypeField {
    const rawType = node.str("type") ?? "string";
    const parsed = parseFieldType(rawType);
    const references = referencesOf(node);
    const size = sizeOf(node);
    const minSize = node.finiteInt("min_size");
    return {
      name,
      type: rawType,
      kind: parsed.kind,
      base: parsed.base,
      isArray: parsed.isArray,
      isMap: parsed.isMap,
      isNullable: node.bool("is_nullable"),
      ...(node.bool("is_id") ? { isId: true } : {}),
      ...(size !== undefined ? { size } : {}),
      ...(minSize !== undefined ? { minSize } : {}),
      ...(references !== undefined ? { references } : {}),
      ...(node.has("default_value")
        ? { hasDefault: true, defaultValue: node.literal("default_value") }
        : {}),
    };
  }

  #parseDatasource(yaml: string, types: Type[]): DatasourceTable[] {
    const root = YamlNode.fromYaml(yaml);
    const tables = root.namedList("types").map(({ name, node }) => {
      const uniqueIndexFields: string[] = [];
      const indexes: DatasourceIndex[] = [];
      for (const { name: indexName, node: indexBody } of node.namedList(
        "indexes",
      )) {
        const rawFields = indexBody.child("fields").value;
        const fields = Array.isArray(rawFields)
          ? rawFields.filter((f): f is string => typeof f === "string")
          : [];
        indexes.push({
          name: indexName,
          fields,
          isUnique: indexBody.bool("is_unique"),
        });
        if (indexBody.bool("is_unique") && fields.length === 1 && fields[0]) {
          uniqueIndexFields.push(fields[0]);
        }
      }
      const fields: DatasourceFieldOverlay[] = node
        .namedList("fields")
        .map(({ name: fname, node: fnode }) => ({
          name: fname,
          ...(fnode.has("is_readonly")
            ? { isReadonly: fnode.bool("is_readonly") }
            : {}),
          ...(fnode.has("is_unique") ? { isUnique: fnode.bool("is_unique") } : {}),
          ...(fnode.str("mapping") ? { mapping: fnode.str("mapping") } : {}),
          ...(fnode.has("is_fixed_id")
            ? { isFixedId: fnode.bool("is_fixed_id") }
            : {}),
          ...(fnode.has("is_optimistic_concurrency")
            ? {
                isOptimisticConcurrency: fnode.bool(
                  "is_optimistic_concurrency",
                ),
              }
            : {}),
          ...(fnode.has("use_native_row_version")
            ? { useNativeRowVersion: fnode.bool("use_native_row_version") }
            : {}),
        }));
      return {
        name,
        ...(node.str("mapping") ? { mapping: node.str("mapping") } : {}),
        fields,
        indexes,
        uniqueIndexFields,
        ...(node.has("use_optimistic_concurrency")
          ? {
              useOptimisticConcurrency: node.bool(
                "use_optimistic_concurrency",
              ),
            }
          : {}),
      };
    });

    const filter = this.#typesFilter(root);
    if (!filter) return tables;
    const selected = new Set(
      types.filter((t) => filter(t)).map((t) => t.name),
    );
    const overlayNames = new Set(tables.map((t) => t.name));
    const extras = types
      .filter((t) => selected.has(t.name) && !overlayNames.has(t.name))
      .map(
        (t): DatasourceTable => ({
          name: t.name,
          fields: [],
          indexes: [],
          uniqueIndexFields: [],
        }),
      );
    return [...tables.filter((t) => selected.has(t.name)), ...extras];
  }

  #parseDatasourceSeeds(yaml: string): Map<string, SeedRow[]> {
    const byTable = new Map<string, SeedRow[]>();
    for (const { name, node } of YamlNode.fromYaml(yaml).namedList("seeds")) {
      byTable.set(
        name,
        node.namedItems().map(({ name: rowKey, node: row }) => ({
          id: parseSeedKey(rowKey),
          row: seedCells(row),
        })),
      );
    }
    return byTable;
  }

  #typesFilter(root: YamlNode) {
    const block = this.#includeBlock(root, "types");
    if (block === undefined) return undefined;
    return compileTypesFilter(block.str("filter"));
  }

  #parseServices(args: {
    servicesYaml: string;
    types: Type[];
    datasource: DatasourceTable[];
    routesYaml?: string;
    serviceClassName: (entity: string) => string;
  }): ParsedServices {
    const root = YamlNode.fromYaml(args.servicesYaml);
    const rawServices = root.child("services").items().flatMap((entry) => {
      const name = entry.str("name");
      if (name === undefined) return [];
      return [{ name, module: entry.str("module") }];
    });
    const customEntries = rawServices.filter(
      (s) =>
        !(
          typeof s.module === "string" &&
          s.module.startsWith("./services/generated/")
        ),
    );
    const explicitCustomNames = new Set(customEntries.map((s) => s.name));
    const methodsByService = this.#collectRouteServiceMethods(args.routesYaml);
    const dsByName = new Map(args.datasource.map((d) => [d.name, d]));

    const predicate = this.#typesFilter(root);
    let generics: ServiceCandidate[] = [];
    if (predicate !== undefined) {
      const compare = compareByDatasourceTypeOrder(
        args.types,
        (name) => args.types.find((t) => t.name === name)?.inherits,
      );
      generics = args.types
        .filter((t) => predicate(t))
        .filter((t) => !explicitCustomNames.has(args.serviceClassName(t.name)))
        .sort((a, b) => compare(a.name, b.name))
        .map((t) => ({
          name: t.name,
          tags: t.tags,
          inherits: t.inherits,
          byFields: uniqueLookupFields(t, dsByName.get(t.name)),
        }));
    }

    const customs: CustomServiceEntry[] = customEntries.map((entry) => ({
      name: entry.name,
      module: entry.module,
      methods: [...(methodsByService.get(entry.name) ?? [])].sort(),
    }));

    return { generics, customs };
  }

  #parseRoutes(args: {
    routesYaml: string;
    types: Type[];
    datasource: DatasourceTable[];
  }): ParsedRoutes {
    const root = YamlNode.fromYaml(args.routesYaml);
    const dsByName = new Map(args.datasource.map((d) => [d.name, d]));
    const typeByName = new Map(args.types.map((t) => [t.name, t]));
    const overlays = this.#entityOverlays(root);
    const allCandidates = args.types.map((t) => {
      const overlay = overlays.get(t.name);
      return {
        name: t.name,
        tags: t.tags,
        inherits: t.inherits,
        byFields: [] as RouteByField[],
        ...(overlay?.eagerReadPath ? { eagerReadPath: overlay.eagerReadPath } : {}),
        ...(overlay?.eagerUpdatePath
          ? { eagerUpdatePath: overlay.eagerUpdatePath }
          : {}),
        ...(overlay?.eagerReadMemberOnly
          ? { eagerReadMemberOnly: overlay.eagerReadMemberOnly }
          : {}),
      };
    });
    const childrenOnly = this.#collectCombinedChildNames(root, typeByName);
    this.#attachByFields(allCandidates, root, dsByName, typeByName);
    const customs = this.#extractCustomRoutes(root, dsByName, typeByName);
    const nested = this.#collectNestedDescriptors(root, typeByName);

    const predicate = this.#typesFilter(root);
    let candidates: RouteCandidate[] = [];
    if (predicate !== undefined) {
      const compare = compareByDatasourceTypeOrder(
        args.types,
        (name) => typeByName.get(name)?.inherits,
      );
      candidates = allCandidates
        .filter((c) => predicate({
          name: c.name,
          tags: c.tags,
          inherits: c.inherits,
        }))
        .filter((c) => !childrenOnly.has(c.name))
        .sort((a, b) => compare(a.name, b.name));
    }

    return {
      candidates,
      customs,
      nested,
      childrenOnly,
      datasource: args.datasource,
    };
  }

  #entityOverlays(root: YamlNode): Map<
    string,
    {
      eagerReadPath?: string[];
      eagerUpdatePath?: string[];
      eagerReadMemberOnly?: string[];
    }
  > {
    const out = new Map<
      string,
      {
        eagerReadPath?: string[];
        eagerUpdatePath?: string[];
        eagerReadMemberOnly?: string[];
      }
    >();
    for (const { name, node } of root.namedList("routes")) {
      const read = node.strings("eager_read_path");
      const update = node.strings("eager_update_path");
      const member = node.strings("eager_read_member_only");
      if (read.length + update.length + member.length === 0) continue;
      out.set(name, {
        ...(read.length > 0 ? { eagerReadPath: read } : {}),
        ...(update.length > 0 ? { eagerUpdatePath: update } : {}),
        ...(member.length > 0 ? { eagerReadMemberOnly: member } : {}),
      });
    }
    return out;
  }

  #includeBlock(root: YamlNode, key: string): YamlNode | undefined {
    for (const entry of root.child("includes").items()) {
      if (entry.child(key).record !== undefined) return entry.child(key);
    }
    return undefined;
  }

  #collectRouteServiceMethods(
    routesYaml: string | undefined,
  ): Map<string, Set<string>> {
    const byService = new Map<string, Set<string>>();
    if (routesYaml === undefined) return byService;
    const root = YamlNode.fromYaml(routesYaml);
    const visit = (node: YamlNode): void => {
      if (Array.isArray(node.value)) {
        for (const item of node.items()) visit(item);
        return;
      }
      if (node.record === undefined) return;
      const service = node.str("service");
      const fn = node.str("function");
      if (service !== undefined && fn !== undefined) {
        const set = byService.get(service) ?? new Set<string>();
        set.add(fn);
        byService.set(service, set);
      }
      for (const key of Object.keys(node.record)) visit(node.child(key));
    };
    visit(root.child("routes"));
    visit(root.child("combined_routes"));
    return byService;
  }

  #defaultParentBasePath(parentName: string): string {
    return `/api/${specPlural(parentName)}/{id}`;
  }

  #segmentTailOf(segment: string): string {
    return segment.split("/").filter(Boolean).pop() ?? "";
  }

  #defaultChildSegment(name: string): string {
    return `/${specPlural(name)}`;
  }

  #columnIsUnique(
    table: DatasourceTable | undefined,
    type: Type | undefined,
    columnName: string,
  ): boolean {
    if (columnName === primaryKeyColumn(table, type)) return true;
    if (table?.fields.some((f) => f.name === columnName && f.isUnique)) {
      return true;
    }
    return table?.uniqueIndexFields.includes(columnName) ?? false;
  }

  #singularizeLastToken(snakePlural: string): string {
    const parts = snakePlural.split("_");
    parts[parts.length - 1] = pluralize.singular(parts[parts.length - 1]!);
    return parts.join("_");
  }

  #entityHasField(type: Type, fieldName: string): boolean {
    if (fieldName === "id") return true;
    return type.fields.some((f) => f.name === fieldName);
  }

  #parseVerb(token: string): { methods: string[] | null; body: string } {
    const verbMatch = SHORTHAND_VERB_RE.exec(token);
    if (!verbMatch) return { methods: null, body: token };
    return {
      methods: VERB_TO_METHODS[verbMatch[1]!.toLowerCase()]!,
      body: token.slice(verbMatch[0].length),
    };
  }

  #splitEntityField(
    token: string,
    body: string,
  ): { entity: string; byField: string } {
    const splitIdx = body.lastIndexOf("_by_");
    if (splitIdx < 0) {
      throw new Error(
        `parseByFieldEntry: route key \`${token}\` is missing \`_by_\` separator`,
      );
    }
    const pluralSnake = body.slice(0, splitIdx);
    const fieldToken = body.slice(splitIdx + "_by_".length);
    if (!pluralSnake || !fieldToken) {
      throw new Error(
        `parseByFieldEntry: route key \`${token}\` has empty entity or field around \`_by_\``,
      );
    }
    return {
      entity: this.#singularizeLastToken(pluralSnake),
      byField: shorthandField(fieldToken),
    };
  }

  #parseShorthandByField(
    token: string,
    typeByName: Map<string, Type>,
  ): ByFieldParsed {
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("parseByFieldEntry: expected non-empty string token");
    }
    const { methods, body } = this.#parseVerb(token);
    const { entity, byField } = this.#splitEntityField(token, body);
    const type = typeByName.get(entity);
    if (type === undefined) {
      throw new Error(
        `parseByFieldEntry: unknown entity \`${entity}\` in route \`${token}\``,
      );
    }
    if (!this.#entityHasField(type, byField)) {
      throw new Error(
        `parseByFieldEntry: field \`${byField}\` not found on entity \`${entity}\` in route \`${token}\``,
      );
    }
    return { entity, byField, methods };
  }

  #parseVerboseByField(
    key: string,
    def: Record<string, unknown>,
  ): ByFieldParsed {
    if (typeof def.entity !== "string" || typeof def.byField !== "string") {
      throw new Error(
        `parseByFieldEntry: route \`${key}\` has non-string entity/byField`,
      );
    }
    return {
      entity: def.entity,
      byField: def.byField,
      methods: Array.isArray(def.methods) ? def.methods : null,
    };
  }

  #parseByFieldEntry(
    entry: unknown,
    typeByName: Map<string, Type>,
  ): ByFieldParsed | null {
    if (entry == null) return null;
    if (typeof entry === "string") {
      return this.#parseShorthandByField(entry, typeByName);
    }
    if (!isRecord(entry)) return null;
    const pairs = Object.entries(entry);
    if (pairs.length === 0) return null;
    const [key, def] = pairs[0]!;
    if (def == null) {
      return this.#parseShorthandByField(key, typeByName);
    }
    if (!isRecord(def)) return null;
    if ("entity" in def && "byField" in def) {
      return this.#parseVerboseByField(key, def);
    }
    return null;
  }

  #refParent(references: string | [string, string] | undefined): string | null {
    if (typeof references !== "string") return null;
    return references.split(".")[0]!;
  }

  #inheritsChain(name: string, typeByName: Map<string, Type>): string[] {
    return inheritsChain(name, typeByName);
  }

  #refMatchesParent(
    target: string,
    parent: string,
    typeByName: Map<string, Type>,
  ): boolean {
    return (
      parent === target ||
      this.#inheritsChain(parent, typeByName).includes(target)
    );
  }

  #fkFields(type: Type, typeByName: Map<string, Type>): TypeField[] {
    const fields = [...type.fields];
    for (const ancestor of this.#inheritsChain(type.name, typeByName)) {
      fields.push(...(typeByName.get(ancestor)?.fields ?? []));
    }
    return fields;
  }

  #findForeignKeyTo(
    child: Type,
    parentName: string,
    typeByName: Map<string, Type>,
  ): string | null {
    for (const field of this.#fkFields(child, typeByName)) {
      const target = this.#refParent(field.references);
      if (
        target !== null &&
        this.#refMatchesParent(target, parentName, typeByName)
      ) {
        return field.name;
      }
    }
    return null;
  }

  #collectCombinedChildNames(
    root: YamlNode,
    typeByName: Map<string, Type>,
  ): Set<string> {
    const childrenOnly = new Set<string>();
    const parents = new Set(
      root.namedList("combined_routes").map((e) => e.name),
    );
    for (const { name: parentName, node } of root.namedList("combined_routes")) {
      const def = node.record as CombinedRouteDef | undefined;
      for (const child of def?.combines ?? []) {
        let childName: string;
        if (typeof child === "string") {
          childName = specName(child);
        } else {
          const [rawName, childDef] = Object.entries(child)[0]!;
          if (childDef && (childDef.via || childDef.target)) continue;
          childName = specName(rawName);
        }
        if (parents.has(childName)) continue;
        const childType = typeByName.get(childName);
        if (
          childType !== undefined &&
          this.#findForeignKeyTo(childType, parentName, typeByName) !== null
        ) {
          childrenOnly.add(childName);
        }
      }
    }
    return childrenOnly;
  }

  #upsertByField(
    list: RouteByField[],
    parsed: ByFieldParsed,
    dsByName: Map<string, DatasourceTable>,
    typeByName: Map<string, Type>,
  ): void {
    const existing = list.find((e) => e.byField === parsed.byField);
    if (existing) {
      if (existing.methods === undefined || parsed.methods === null) {
        existing.methods = undefined;
      } else if (Array.isArray(parsed.methods)) {
        const union = [...existing.methods];
        for (const m of parsed.methods) {
          if (!union.includes(m)) union.push(m);
        }
        existing.methods = union;
      }
      return;
    }
    list.push({
      byField: parsed.byField,
      methods: Array.isArray(parsed.methods) ? parsed.methods : undefined,
      byFieldUnique: this.#columnIsUnique(
        dsByName.get(parsed.entity),
        typeByName.get(parsed.entity),
        parsed.byField,
      ),
    });
  }

  #attachByFields(
    candidates: RouteCandidate[],
    root: YamlNode,
    dsByName: Map<string, DatasourceTable>,
    typeByName: Map<string, Type>,
  ): void {
    const byFieldByEntity = new Map<string, RouteByField[]>();
    for (const entry of root.child("routes").items()) {
      const parsed = this.#parseByFieldEntry(entry.value, typeByName);
      if (parsed === null) continue;
      if (!byFieldByEntity.has(parsed.entity)) {
        byFieldByEntity.set(parsed.entity, []);
      }
      this.#upsertByField(
        byFieldByEntity.get(parsed.entity)!,
        parsed,
        dsByName,
        typeByName,
      );
    }
    for (const candidate of candidates) {
      const list = byFieldByEntity.get(candidate.name);
      if (list !== undefined && list.length > 0) {
        candidate.byFields = list;
      }
    }
  }

  #extractCustomRoutes(
    root: YamlNode,
    dsByName: Map<string, DatasourceTable>,
    typeByName: Map<string, Type>,
  ): CustomRouteEntry[] {
    const customs: CustomRouteEntry[] = [];
    for (const entry of root.child("routes").items()) {
      if (entry.record === undefined) continue;
      if (this.#parseByFieldEntry(entry.value, typeByName) !== null) continue;
      const [name] = Object.keys(entry.record);
      if (name === undefined) continue;
      const node = entry.child(name);
      if (
        node.has("eager_read_path") ||
        node.has("eager_update_path") ||
        node.has("eager_read_member_only")
      ) {
        continue;
      }
      if (node.str("path") === undefined) continue;
      customs.push({
        name,
        path: node.str("path"),
        method: node.str("method"),
        entity: node.str("entity") ?? null,
        request: node.str("request"),
        response: node.str("response"),
        module: node.str("module"),
        routeClass: node.str("routeClass"),
      });
    }
    return customs;
  }

  #normalizeCombinedChild(
    child: string | Record<string, CombinedChildDef>,
  ): NormalizedChild {
    if (typeof child === "string") {
      return {
        name: specName(child),
        via: null,
        target: null,
        route: null,
      };
    }
    const [rawName, def] = Object.entries(child)[0]!;
    return {
      name: specName(rawName),
      via: def && typeof def.via === "string" ? def.via : null,
      target: def && typeof def.target === "string" ? def.target : null,
      route: def && typeof def.route === "string" ? def.route : null,
    };
  }

  #detectJunction(
    parentName: string,
    childName: string,
    typeByName: Map<string, Type>,
  ): JunctionMatch | null {
    const matches: JunctionMatch[] = [];
    for (const [name, def] of typeByName) {
      if (name === parentName || name === childName) continue;
      if (!def.tags.includes("many_to_many")) continue;
      const parentFk = this.#findForeignKeyTo(def, parentName, typeByName);
      const childFk = this.#findForeignKeyTo(def, childName, typeByName);
      if (parentFk !== null && childFk !== null) {
        matches.push({ name, parentFk, childFk });
      }
    }
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      const candidates = matches.map((m) => m.name).join(", ");
      throw new Error(
        `combined_routes: ambiguous junction between "${parentName}" and "${childName}" — candidates: ${candidates}. Add via: to disambiguate.`,
      );
    }
    return matches[0]!;
  }

  #m2mDescriptor(
    parentName: string,
    parentBasePath: string,
    args: {
      junction: string;
      target: string;
      parentFkField: string;
      childFkField: string;
      route: string | null;
    },
  ): M2mDescriptor {
    const segment = args.route ?? this.#defaultChildSegment(args.target);
    return {
      kind: "m2m",
      parent: parentName,
      parentBasePath,
      parentParam: parentName,
      junction: args.junction,
      target: args.target,
      targetParam: args.target,
      parentFkField: args.parentFkField,
      childFkField: args.childFkField,
      segment,
      segmentTail: this.#segmentTailOf(segment),
    };
  }

  #directFkDescriptor(
    parentName: string,
    parentBasePath: string,
    args: { childName: string; fkColumn: string; route: string | null },
  ): DirectFkDescriptor {
    const segment = args.route ?? this.#defaultChildSegment(args.childName);
    return {
      kind: "direct-fk",
      parent: parentName,
      parentBasePath,
      parentParam: parentName,
      child: { name: args.childName },
      fkColumn: args.fkColumn,
      segment,
      segmentTail: this.#segmentTailOf(segment),
    };
  }

  #collectNestedDescriptors(
    root: YamlNode,
    typeByName: Map<string, Type>,
  ): NestedRouteDescriptor[] {
    const nested: NestedRouteDescriptor[] = [];
    for (const { name: parentName, node } of root.namedList("combined_routes")) {
      const def = (node.record ?? {}) as CombinedRouteDef;
      const parentBasePath =
        typeof def.route === "string" && def.route.length > 0
          ? def.route
          : this.#defaultParentBasePath(parentName);
      for (const rawChild of def.combines ?? []) {
        const child = this.#normalizeCombinedChild(rawChild);
        if (child.via || child.target) {
          const junctionName = child.via;
          const targetName = child.target;
          if (!junctionName || !targetName) {
            throw new Error(
              `combined_routes: M2M child must declare both via: and target: (parent=${parentName}, child=${child.name})`,
            );
          }
          const junctionDef = typeByName.get(junctionName);
          if (junctionDef === undefined) {
            throw new Error(
              `combined_routes: junction "${junctionName}" not found in types.yaml`,
            );
          }
          const parentFkField = this.#findForeignKeyTo(
            junctionDef,
            parentName,
            typeByName,
          );
          const childFkField = this.#findForeignKeyTo(
            junctionDef,
            targetName,
            typeByName,
          );
          if (parentFkField === null || childFkField === null) {
            throw new Error(
              `combined_routes: junction "${junctionName}" missing FK to ${parentName}/${targetName}`,
            );
          }
          nested.push(
            this.#m2mDescriptor(parentName, parentBasePath, {
              junction: junctionName,
              target: targetName,
              parentFkField,
              childFkField,
              route: child.route,
            }),
          );
          continue;
        }
        const childDef = typeByName.get(child.name);
        if (childDef === undefined) {
          throw new Error(
            `combined_routes: child "${child.name}" not found in types.yaml`,
          );
        }
        const fkColumn = this.#findForeignKeyTo(
          childDef,
          parentName,
          typeByName,
        );
        if (fkColumn !== null) {
          nested.push(
            this.#directFkDescriptor(parentName, parentBasePath, {
              childName: child.name,
              fkColumn,
              route: child.route,
            }),
          );
          continue;
        }
        const junction = this.#detectJunction(parentName, child.name, typeByName);
        if (junction !== null) {
          nested.push(
            this.#m2mDescriptor(parentName, parentBasePath, {
              junction: junction.name,
              target: child.name,
              parentFkField: junction.parentFk,
              childFkField: junction.childFk,
              route: child.route,
            }),
          );
          continue;
        }
        throw new Error(
          `combined_routes: child "${child.name}" has no FK to parent "${parentName}" and no detectable junction table in types.yaml`,
        );
      }
    }
    return nested;
  }
}
