import { parse, stringify } from "yaml";
import {
  applyEntryOptions,
  assertCombine,
  dropSatisfiedRemoves,
  duplicateNames,
  findIndexByName,
  renameKey,
} from "./types-combine-core.ts";
import type {
  RawTypeEntry,
  RawFieldEntry,
} from "./deterministic-shapes.ts";

type SideOptions = NonNullable<Parameters<typeof applyEntryOptions>[1]>;

interface DatasourceMappingBody {
  source?: string;
  field_mappings?: Array<Record<string, { source?: string }>>;
}

type MappingEntry = Record<string, DatasourceMappingBody>;

interface DatasourceTypesDoc {
  version?: string;
  types?: RawTypeEntry[];
  datasource_mappings?: MappingEntry[];
}

interface AppliedDoc {
  version?: string;
  types: RawTypeEntry[];
  datasource_mappings?: MappingEntry[];
}

interface CombineOptions {
  source?: SideOptions;
  destination?: SideOptions;
}

/**
 * Apply a side's transform options to a parsed datasource_types document,
 * returning a new document plus any option targets that didn't resolve. Pure:
 * the input is deep-cloned, never mutated. Type renames/removals are mirrored
 * into `datasource_mappings` so a mapping never dangles.
 */
export function applySideOptions(
  data: DatasourceTypesDoc,
  sideOptions: SideOptions = {},
  side: string = "source",
) {
  const types = structuredClone(data?.types ?? []);
  const mappings = structuredClone(data?.datasource_mappings ?? []);
  const { unknownTargets } = applyEntryOptions(types, sideOptions, {
    side,
    fieldsOf: (def) => (def as { fields: RawFieldEntry[] }).fields,
    onRenameType: (from, to) => {
      const mIdx = findIndexByName(mappings, from);
      if (mIdx !== -1) renameKey(mappings[mIdx], from, to);
    },
    onRemoveType: (name) => {
      const mIdx = findIndexByName(mappings, name);
      if (mIdx !== -1) mappings.splice(mIdx, 1);
    },
  });

  const out: AppliedDoc = { types };
  if (mappings.length > 0) out.datasource_mappings = mappings;
  return { data: out, unknownTargets };
}

function buildCombined(
  sourceYaml: string,
  destYaml: string,
  options: CombineOptions,
) {
  const sourceDoc: DatasourceTypesDoc = parse(sourceYaml) ?? {};
  const destDoc: DatasourceTypesDoc = parse(destYaml) ?? {};
  const source = applySideOptions(sourceDoc, options.source, "source");
  const destination = applySideOptions(
    destDoc,
    options.destination,
    "destination",
  );

  const version = destDoc.version ?? sourceDoc.version;
  const combined: AppliedDoc = {
    ...(version !== undefined ? { version } : {}),
    types: [...source.data.types, ...destination.data.types],
  };
  const mappings = [
    ...(source.data.datasource_mappings ?? []),
    ...(destination.data.datasource_mappings ?? []),
  ];
  if (mappings.length > 0) combined.datasource_mappings = mappings;

  const report = {
    duplicateTypes: duplicateNames(source.data.types, destination.data.types),
    invalidReferences: [] as { instancePath: string; message: string }[],
    unknownOptionTargets: dropSatisfiedRemoves(
      [...source.unknownTargets, ...destination.unknownTargets],
      source.data.types,
      destination.data.types,
    ),
  };
  return { combined, report };
}

/**
 * Merge two datasource_types documents WITHOUT asserting, returning the combined
 * model (`combined`, a parsed object) and its `report`. Callers that need the
 * merged datasource for downstream validation (e.g. view `inherits`) use this;
 * throws only on unparseable YAML.
 */
export function mergeDatasourceTypes(
  sourceYaml: string,
  destYaml: string,
  options: CombineOptions = {},
) {
  return buildCombined(sourceYaml, destYaml, options);
}

/**
 * Compute the merge report (duplicate type names, invalid references,
 * unresolved option targets) WITHOUT asserting. Throws only on
 * unparseable YAML.
 */
export function reportCombineDatasourceTypes(
  sourceYaml: string,
  destYaml: string,
  options: CombineOptions = {},
) {
  return buildCombined(sourceYaml, destYaml, options).report;
}

/**
 * Combine two datasource_types.yaml documents into one. Applies each side's
 * transform options, concatenates source-then-destination types, and asserts:
 * throws if any type name still overlaps, a reference is invalid, or an option
 * target didn't resolve. Returns the combined YAML string and the report.
 */
export function combineDatasourceTypes(
  sourceYaml: string,
  destYaml: string,
  options: CombineOptions = {},
) {
  const { combined, report } = buildCombined(sourceYaml, destYaml, options);
  assertCombine(report, "datasource_types");
  return { yaml: stringify(combined), report };
}
