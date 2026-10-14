import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { asRecord, positionFor } from "./yamlPositions.ts";
import type {
  SpecValidationError,
  SpecValidationResult,
  ValidateOptions,
} from "./types.ts";
import type { ParsedYaml } from "./SpecValidator.ts";
import { indexTypeFields } from "./typeModelSemantics.ts";
import { matchTypesFilter } from "./includeFilter.ts";

const AUTO_COLUMNS = new Set(["id", "created", "updated"]);

type FieldDef = Record<string, unknown>;
type TableIndex = Map<string, Map<string, FieldDef>>;

const STRING_TYPES = new Set([
  "string",
  "character",
  "datetime",
  "uuid",
  "binary",
]);
const NUMBER_TYPES = new Set([
  "number",
  "integer",
  "unsignedinteger",
  "smallinteger",
  "unsignedsmallinteger",
  "float",
]);
const STRING_OR_NUMBER_TYPES = new Set([
  "biginteger",
  "unsignedbiginteger",
  "decimal",
]);
const INTEGER_TYPES = new Set([
  "integer",
  "unsignedinteger",
  "smallinteger",
  "unsignedsmallinteger",
]);
const UNSIGNED_TYPES = new Set([
  "unsignedinteger",
  "unsignedbiginteger",
  "unsignedsmallinteger",
]);

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function withSiblingCompanions(
  seedsPath: string,
  options?: ValidateOptions,
): Promise<ValidateOptions> {
  const dir = dirname(seedsPath);
  const types =
    options?.types ??
    (options?.typesPath
      ? await readFile(options.typesPath, "utf8")
      : await readIfPresent(join(dir, "types.yaml")));
  const datasource =
    options?.datasource ??
    (options?.datasourcePath
      ? await readFile(options.datasourcePath, "utf8")
      : await readIfPresent(join(dir, "datasource.yaml")));
  return { ...options, types, datasource };
}

function err(
  parsed: ParsedYaml,
  instancePath: string,
  message: string,
): SpecValidationError {
  const { line, col } = positionFor(parsed.doc, parsed.lineCounter, instancePath);
  return { line, col, instancePath, message };
}

function tableNames(data: unknown): Set<string> {
  const out = new Set<string>();
  const types = asRecord(data)?.types;
  if (!Array.isArray(types)) return out;
  for (const entry of types) {
    const obj = asRecord(entry);
    if (!obj) continue;
    const name = Object.keys(obj)[0];
    if (name) out.add(name);
  }
  return out;
}

function typesFilter(data: unknown): string | undefined {
  const includes = asRecord(data)?.includes;
  if (!Array.isArray(includes)) return undefined;
  for (const entry of includes) {
    const filter = asRecord(asRecord(entry)?.types)?.filter;
    if (typeof filter === "string") return filter;
  }
  return undefined;
}

function typeCandidates(
  data: unknown,
): Array<{ name: string; tags: string[]; inherits?: string }> {
  const out: Array<{ name: string; tags: string[]; inherits?: string }> = [];
  const types = asRecord(data)?.types;
  if (!Array.isArray(types)) return out;
  for (const entry of types) {
    const obj = asRecord(entry);
    if (!obj) continue;
    const name = Object.keys(obj)[0];
    if (!name) continue;
    const def = asRecord(obj[name]) ?? {};
    const tags = Array.isArray(def.tags)
      ? def.tags.filter((t): t is string => typeof t === "string")
      : [];
    out.push({
      name,
      tags,
      inherits: typeof def.inherits === "string" ? def.inherits : undefined,
    });
  }
  return out;
}

function allowedTables(
  typesData: unknown,
  datasourceData?: unknown,
): Set<string> | undefined {
  if (datasourceData === undefined) return undefined;
  const filter = typesFilter(datasourceData);
  if (!filter) return tableNames(datasourceData);
  return new Set(
    typeCandidates(typesData)
      .filter((c) => matchTypesFilter(filter, c))
      .map((c) => c.name),
  );
}

function isOmittable(def: FieldDef): boolean {
  return def.is_nullable === true || "default_value" in def;
}

function fieldType(def: FieldDef, tables: TableIndex): string | undefined {
  if (typeof def.type === "string") return def.type;
  if (typeof def.references === "string") {
    const [table, column] = def.references.split(".");
    if (!table || !column) return undefined;
    if (column === "id") return "number";
    const parent = tables.get(table)?.get(column);
    if (parent && typeof parent.type === "string") return parent.type;
    return "number";
  }
  return undefined;
}

function typeMessage(fieldTypeName: string): string {
  if (STRING_TYPES.has(fieldTypeName)) return "string";
  if (fieldTypeName === "boolean") return "boolean";
  if (STRING_OR_NUMBER_TYPES.has(fieldTypeName)) return "string or number";
  if (INTEGER_TYPES.has(fieldTypeName)) return "integer";
  return "number";
}

function valueMatchesType(value: unknown, fieldTypeName: string): boolean {
  if (STRING_TYPES.has(fieldTypeName)) return typeof value === "string";
  if (fieldTypeName === "boolean") return typeof value === "boolean";
  if (STRING_OR_NUMBER_TYPES.has(fieldTypeName)) {
    if (typeof value === "string") return true;
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    if (UNSIGNED_TYPES.has(fieldTypeName) && value < 0) return false;
    return true;
  }
  if (!NUMBER_TYPES.has(fieldTypeName)) return true;
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (INTEGER_TYPES.has(fieldTypeName) && !Number.isInteger(value)) return false;
  if (UNSIGNED_TYPES.has(fieldTypeName) && value < 0) return false;
  return true;
}

function seedsAreEmpty(data: unknown): boolean {
  const seeds = asRecord(data)?.seeds;
  return !Array.isArray(seeds) || seeds.length === 0;
}

export function checkSeedSemantics(
  parsed: ParsedYaml,
  typesData: unknown,
  datasourceData?: unknown,
): SpecValidationResult {
  const tables = indexTypeFields(typesData);
  const allowed = allowedTables(typesData, datasourceData);
  const seeds = asRecord(parsed.data)?.seeds;
  if (!Array.isArray(seeds)) return { valid: true, errors: [] };

  const errors: SpecValidationError[] = [];
  const seenTables = new Set<string>();

  seeds.forEach((entry, tableIndex) => {
    const obj = asRecord(entry);
    if (!obj) return;
    const tableName = Object.keys(obj)[0];
    if (!tableName) return;
    const tablePath = `/seeds/${tableIndex}/${tableName}`;
    if (seenTables.has(tableName)) {
      errors.push(
        err(parsed, tablePath, `duplicate seed table '${tableName}'`),
      );
      return;
    }
    seenTables.add(tableName);

    if (allowed && !allowed.has(tableName)) {
      errors.push(
        err(
          parsed,
          tablePath,
          `unknown type '${tableName}' (not in datasource.yaml)`,
        ),
      );
      return;
    }

    const fields = tables.get(tableName);
    if (!fields) {
      errors.push(
        err(
          parsed,
          tablePath,
          `unknown type '${tableName}' (not in types.yaml)`,
        ),
      );
      return;
    }

    const rows = obj[tableName];
    if (!Array.isArray(rows)) return;
    const seenIds = new Set<string>();
    rows.forEach((rowWrap, rowIndex) => {
      const rowObj = asRecord(rowWrap);
      if (!rowObj) return;
      const rowId = Object.keys(rowObj)[0];
      if (!rowId) return;
      const rowPath = `${tablePath}/${rowIndex}/${rowId}`;
      if (seenIds.has(rowId)) {
        errors.push(err(parsed, rowPath, `duplicate seed id '${rowId}'`));
        return;
      }
      seenIds.add(rowId);

      const row = asRecord(rowObj[rowId]) ?? {};
      for (const key of Object.keys(row)) {
        const fieldPath = `${rowPath}/${key}`;
        if (AUTO_COLUMNS.has(key)) {
          errors.push(
            err(
              parsed,
              fieldPath,
              `'${key}' is auto-injected and is not seeded here`,
            ),
          );
          continue;
        }
        const def = fields.get(key);
        if (!def) {
          errors.push(
            err(parsed, fieldPath, `unknown field '${key}' on ${tableName}`),
          );
          continue;
        }
        const value = row[key];
        if (value === null) {
          if (def.is_nullable !== true) {
            errors.push(err(parsed, fieldPath, `'${key}' is not nullable`));
          }
          continue;
        }
        const declared = fieldType(def, tables);
        if (declared && !valueMatchesType(value, declared)) {
          errors.push(
            err(
              parsed,
              fieldPath,
              `'${key}' must be ${typeMessage(declared)}`,
            ),
          );
        }
      }

      for (const [name, def] of fields) {
        if (AUTO_COLUMNS.has(name)) continue;
        if (name in row || isOmittable(def) || Object.keys(def).length === 0) {
          continue;
        }
        errors.push(
          err(
            parsed,
            rowPath,
            `missing required field '${name}' on ${tableName} (not nullable and has no default)`,
          ),
        );
      }
    });
  });

  return { valid: errors.length === 0, errors };
}

export function seedsNeedCompanions(data: unknown): boolean {
  return !seedsAreEmpty(data);
}

export function companionError(
  parsed: ParsedYaml,
  message: string,
): SpecValidationResult {
  return {
    valid: false,
    errors: [err(parsed, "/seeds", message)],
  };
}
