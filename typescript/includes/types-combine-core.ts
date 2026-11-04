import { parse, stringify } from "yaml";

type Entry = Record<string, unknown>;

type NameExtractor = (entry: unknown) => string;

type FieldsOf = (def: unknown) => Entry[] | null;

interface ModifyTypeOp {
  type: string;
  new_type: string;
}

interface ModifyFieldOp {
  field: string;
  def?: unknown;
  new_field?: string;
}

interface AddFieldOp {
  type: string;
  add_field: Entry;
}

interface SideOptions {
  modify_types?: ModifyTypeOp[];
  modify_fields?: ModifyFieldOp[];
  add_fields?: AddFieldOp[];
  remove_fields?: string[];
  remove_types?: string[];
}

interface Config {
  fieldsOf?: FieldsOf;
  onRenameType?: (from: string, to: string) => void;
  onRemoveType?: (name: string) => void;
  side?: string;
}

export interface UnknownTarget {
  side?: string;
  op: string;
  target: string;
  message: string;
}

interface InvalidReference {
  message: string;
}

export interface CombineReport {
  duplicateTypes: string[];
  invalidReferences: InvalidReference[];
  unknownOptionTargets: UnknownTarget[];
}

interface Ctx {
  entries: Entry[];
  fieldsOf: FieldsOf;
  onRenameType: (from: string, to: string) => void;
  onRemoveType: (name: string) => void;
  report: (op: string, target: string, message: string) => void;
}

interface ResolveTarget {
  ref: string;
  op: string;
}

interface ResolvedField {
  fields: Entry[];
  fIdx: number;
  fieldName: string;
}

export interface FlatSideOptions {
  [key: string]: string[] | undefined;
}

interface FlatRemoveConfig {
  nameOf: NameExtractor;
  removeKey: string;
}

interface FlatCtx {
  arrayKey: string;
  removeConfig: FlatRemoveConfig;
}

interface FlatCombineConfig {
  arrayKey: string;
  nameOf: NameExtractor;
  removeKey: string;
  label: string;
}

export interface FlatCombineOptions {
  source?: FlatSideOptions;
  destination?: FlatSideOptions;
}

function nameOf(entry: unknown): string {
  return Object.keys(entry as object)[0];
}

function defOf(entry: Entry): unknown {
  return Object.values(entry)[0];
}

export function findIndexByName(entries: Entry[], name: string): number {
  return entries.findIndex((entry) => nameOf(entry) === name);
}

export function renameKey(entry: Entry, from: string, to: string): void {
  const value = entry[from];
  delete entry[from];
  entry[to] = value;
}

function splitDotted(
  ref: string,
): { typeName: string; fieldName: string } | null {
  const dot = ref.indexOf(".");
  if (dot <= 0 || dot === ref.length - 1) return null;
  return { typeName: ref.slice(0, dot), fieldName: ref.slice(dot + 1) };
}

function resolveTypeIndex(ctx: Ctx, name: string, op: string): number {
  const idx = findIndexByName(ctx.entries, name);
  if (idx === -1) ctx.report(op, name, `type '${name}' not found`);
  return idx;
}

function fieldsOfIndex(
  ctx: Ctx,
  idx: number,
  target: ResolveTarget,
): Entry[] | null {
  const fields = ctx.fieldsOf(defOf(ctx.entries[idx]));
  if (!fields) {
    ctx.report(
      target.op,
      target.ref,
      `type '${nameOf(ctx.entries[idx])}' has no fields`,
    );
    return null;
  }
  return fields;
}

function resolveField(ctx: Ctx, ref: string, op: string): ResolvedField | null {
  const parts = splitDotted(ref);
  if (!parts) {
    ctx.report(op, ref, `expected '<type>.<field>', got '${ref}'`);
    return null;
  }
  const tIdx = findIndexByName(ctx.entries, parts.typeName);
  if (tIdx === -1) {
    ctx.report(op, ref, `type '${parts.typeName}' not found`);
    return null;
  }
  const fields = fieldsOfIndex(ctx, tIdx, { ref, op });
  if (!fields) return null;
  const fIdx = findIndexByName(fields, parts.fieldName);
  if (fIdx === -1) {
    ctx.report(
      op,
      ref,
      `field '${parts.fieldName}' not found on '${parts.typeName}'`,
    );
    return null;
  }
  return { fields, fIdx, fieldName: parts.fieldName };
}

function applyModifyTypes(ctx: Ctx, ops: ModifyTypeOp[]): void {
  for (const op of ops) {
    const idx = resolveTypeIndex(ctx, op.type, "modify_types");
    if (idx === -1) continue;
    renameKey(ctx.entries[idx], op.type, op.new_type);
    ctx.onRenameType(op.type, op.new_type);
  }
}

function applyModifyFields(ctx: Ctx, ops: ModifyFieldOp[]): void {
  for (const op of ops) {
    const found = resolveField(ctx, op.field, "modify_fields");
    if (!found) continue;
    if (op.def !== undefined) {
      found.fields[found.fIdx][found.fieldName] = structuredClone(op.def);
    }
    if (op.new_field !== undefined) {
      renameKey(found.fields[found.fIdx], found.fieldName, op.new_field);
    }
  }
}

function applyAddFields(ctx: Ctx, ops: AddFieldOp[]): void {
  for (const op of ops) {
    const idx = resolveTypeIndex(ctx, op.type, "add_fields");
    if (idx === -1) continue;
    const fields = fieldsOfIndex(ctx, idx, { ref: op.type, op: "add_fields" });
    if (!fields) continue;
    fields.push(structuredClone(op.add_field));
  }
}

function applyRemoveFields(ctx: Ctx, refs: string[]): void {
  for (const ref of refs) {
    const found = resolveField(ctx, ref, "remove_fields");
    if (!found) continue;
    found.fields.splice(found.fIdx, 1);
  }
}

function applyRemoveTypes(ctx: Ctx, names: string[]): void {
  for (const name of names) {
    const idx = resolveTypeIndex(ctx, name, "remove_types");
    if (idx === -1) continue;
    ctx.entries.splice(idx, 1);
    ctx.onRemoveType(name);
  }
}

/**
 * Apply one side's transform buckets to a (pre-cloned) list of `{ name: def }`
 * entries in a fixed order: modify_types → modify_fields → add_fields →
 * remove_fields → remove_types. Mutates `entries` in place and returns
 * `unknownTargets` for any op that named a type/field not present at its step.
 * `config.fieldsOf(def)` yields a def's editable fields array (or null when the
 * shape has none — a union view); `config.onRenameType` / `config.onRemoveType`
 * let a caller keep a sibling collection (e.g. datasource_mappings) in sync;
 * `config.side` labels the origin ("source"/"destination") in `unknownTargets`.
 */
export function applyEntryOptions(
  entries: Entry[],
  sideOptions: SideOptions = {},
  config: Config = {},
): { entries: Entry[]; unknownTargets: UnknownTarget[] } {
  const unknownTargets: UnknownTarget[] = [];
  const ctx: Ctx = {
    entries,
    fieldsOf: config.fieldsOf!,
    onRenameType: config.onRenameType ?? (() => {}),
    onRemoveType: config.onRemoveType ?? (() => {}),
    report: (op, target, message) =>
      unknownTargets.push({ side: config.side, op, target, message }),
  };
  applyModifyTypes(ctx, sideOptions.modify_types ?? []);
  applyModifyFields(ctx, sideOptions.modify_fields ?? []);
  applyAddFields(ctx, sideOptions.add_fields ?? []);
  applyRemoveFields(ctx, sideOptions.remove_fields ?? []);
  applyRemoveTypes(ctx, sideOptions.remove_types ?? []);
  return { entries, unknownTargets };
}

/**
 * Apply one side's `remove` transform to a (pre-cloned) list of FLAT entries —
 * `{ name, ... }` records with no `{ name: def }` wrapper and no editable fields
 * (services, routes). `config.nameOf` extracts an entry's name; `config.removeKey`
 * names the side-option bucket (e.g. `remove_services`). Mutates `entries` in
 * place and returns `unknownTargets` for any name not present. Only removal is
 * supported — flat entries have no fields to add/modify.
 */
function applyFlatEntryOptions(
  entries: unknown[],
  sideOptions: FlatSideOptions,
  config: FlatRemoveConfig & { side?: string },
): { entries: unknown[]; unknownTargets: UnknownTarget[] } {
  const keyOf = config.nameOf;
  const removeKey = config.removeKey;
  const unknownTargets: UnknownTarget[] = [];
  for (const name of sideOptions[removeKey] ?? []) {
    const idx = entries.findIndex((entry) => keyOf(entry) === name);
    if (idx === -1) {
      unknownTargets.push({
        side: config.side,
        op: removeKey,
        target: name,
        message: `'${name}' not found`,
      });
      continue;
    }
    entries.splice(idx, 1);
  }
  return { entries, unknownTargets };
}

/** Names present in both entry lists — a post-transform collision the merge cannot resolve. `keyOf` extracts a name (default: the `{ name: def }` wrapper key). */
export function duplicateNames(
  sourceEntries: readonly unknown[],
  destEntries: readonly unknown[],
  keyOf: NameExtractor = nameOf,
): string[] {
  const dstNames = new Set(destEntries.map(keyOf));
  return sourceEntries.map(keyOf).filter((name) => dstNames.has(name));
}

export function emptyReport(): CombineReport {
  return {
    duplicateTypes: [],
    invalidReferences: [],
    unknownOptionTargets: [],
  };
}

export function mergeReports(reports: CombineReport[]): CombineReport {
  const out = emptyReport();
  for (const r of reports) {
    out.duplicateTypes.push(...r.duplicateTypes);
    out.invalidReferences.push(...r.invalidReferences);
    out.unknownOptionTargets.push(...r.unknownOptionTargets);
  }
  return out;
}

function blockingMessages(report: CombineReport): string[] {
  return [
    ...report.duplicateTypes.map(
      (n) => `duplicate type '${n}' present in both source and destination`,
    ),
    ...report.invalidReferences.map((e) => `invalid reference: ${e.message}`),
    ...report.unknownOptionTargets.map(
      (u) => `unknown ${u.op} target on ${u.side}: ${u.message}`,
    ),
  ];
}

/** Throw a single aggregated error if `report` has any blocking finding; `label` names the artifact (`datasource_types` / `view_types`). */
export function assertCombine(report: CombineReport, label: string): void {
  const blocking = blockingMessages(report);
  if (blocking.length > 0) {
    throw new Error(`cannot combine ${label}:\n  - ${blocking.join("\n  - ")}`);
  }
}

/**
 * Build a combine surface for a FLAT-entry artifact (services, routes) — one
 * whose document is `{ [arrayKey]: entry[] }` and whose only per-side transform
 * is `remove` by name. Returns `{ applySide, report, combine }`:
 * - `applySide(data, sideOptions, side)` → `{ [arrayKey]: entries, unknownTargets }`
 *   (deep-cloned, `remove` applied).
 * - `report(sourceYaml, destYaml, options)` → the merge report without asserting.
 * - `combine(sourceYaml, destYaml, options)` → `{ yaml, report }`, throwing on a
 *   post-transform name collision or an unresolved `remove` target.
 * `nameOf` extracts an entry's name (routes pass a string|object union extractor);
 * `removeKey` is the side-option bucket (`remove_services` / `remove_routes`);
 * `label` names the artifact in thrown errors.
 */
function flatApplySide(
  ctx: FlatCtx,
  input: {
    data: Record<string, unknown>;
    sideOptions?: FlatSideOptions;
    side?: string;
  },
): { [key: string]: unknown[]; unknownTargets: UnknownTarget[] } {
  const { arrayKey, removeConfig } = ctx;
  const { data, sideOptions = {}, side = "source" } = input;
  const entries = structuredClone(
    Array.isArray(data?.[arrayKey]) ? data[arrayKey] : [],
  ) as unknown[];
  const { unknownTargets } = applyFlatEntryOptions(entries, sideOptions, {
    ...removeConfig,
    side,
  });
  return { [arrayKey]: entries, unknownTargets };
}

function flatBuild(
  ctx: FlatCtx,
  input: { sourceYaml: string; destYaml: string; options: FlatCombineOptions },
): { combined: Record<string, unknown[]>; report: CombineReport } {
  const { arrayKey, removeConfig } = ctx;
  const { sourceYaml, destYaml, options } = input;
  const source = flatApplySide(ctx, {
    data: parse(sourceYaml) ?? {},
    sideOptions: options.source,
    side: "source",
  });
  const destination = flatApplySide(ctx, {
    data: parse(destYaml) ?? {},
    sideOptions: options.destination,
    side: "destination",
  });
  const combined = {
    [arrayKey]: [...source[arrayKey], ...destination[arrayKey]],
  };
  const report: CombineReport = {
    duplicateTypes: duplicateNames(
      source[arrayKey],
      destination[arrayKey],
      removeConfig.nameOf,
    ),
    invalidReferences: [],
    unknownOptionTargets: [
      ...source.unknownTargets,
      ...destination.unknownTargets,
    ],
  };
  return { combined, report };
}

export function makeFlatCombine({
  arrayKey,
  nameOf: keyOf,
  removeKey,
  label,
}: FlatCombineConfig) {
  const ctx: FlatCtx = { arrayKey, removeConfig: { removeKey, nameOf: keyOf } };
  const build = (
    sourceYaml: string,
    destYaml: string,
    options: FlatCombineOptions,
  ) => flatBuild(ctx, { sourceYaml, destYaml, options });
  return {
    applySide: (
      data: Record<string, unknown>,
      sideOptions: FlatSideOptions = {},
      side: string = "source",
    ) => flatApplySide(ctx, { data, sideOptions, side }),
    report: (
      sourceYaml: string,
      destYaml: string,
      options: FlatCombineOptions = {},
    ) => build(sourceYaml, destYaml, options).report,
    combine: (
      sourceYaml: string,
      destYaml: string,
      options: FlatCombineOptions = {},
    ) => {
      const { combined, report } = build(sourceYaml, destYaml, options);
      assertCombine(report, label);
      return { yaml: stringify(combined), report };
    },
  };
}
