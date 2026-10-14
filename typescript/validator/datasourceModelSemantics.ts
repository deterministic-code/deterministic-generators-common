import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { asRecord } from "./yamlPositions.ts";
import type { SpecValidationResult, ValidateOptions } from "./types.ts";
import type { ParsedYaml } from "./SpecValidator.ts";
import { pushUnique, singleKey, specErr } from "./semanticsUtil.ts";
import { indexTypeFields } from "./typeModelSemantics.ts";
import { withIncludeFilePath } from "./includeSemantics.ts";

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function withSiblingTypes(
  path: string,
  options?: ValidateOptions,
): Promise<ValidateOptions> {
  const withInclude = withIncludeFilePath(path, options);
  const types =
    withInclude.types ??
    (withInclude.typesPath
      ? await readFile(withInclude.typesPath, "utf8")
      : await readIfPresent(join(dirname(path), "types.yaml")));
  return { ...withInclude, types };
}

type TableInfo = {
  path: string;
  fields: Map<string, string>;
};

function collectTables(
  parsed: ParsedYaml,
): { tables: Map<string, TableInfo>; errors: SpecValidationResult["errors"] } {
  const errors: SpecValidationResult["errors"] = [];
  const tables = new Map<string, TableInfo>();
  const types = asRecord(parsed.data)?.types;
  if (!Array.isArray(types)) return { tables, errors };

  const seen = new Set<string>();
  types.forEach((entry, ti) => {
    const pair = singleKey(entry);
    if (!pair) return;
    const tablePath = `/types/${ti}/${pair.key}`;
    if (
      !pushUnique(
        seen,
        pair.key,
        errors,
        parsed,
        tablePath,
        `duplicate type '${pair.key}'`,
      )
    ) {
      return;
    }
    const def = asRecord(pair.body) ?? {};
    const fields = new Map<string, string>();
    const fieldList = def.fields;
    let occCount = 0;
    if (Array.isArray(fieldList)) {
      const seenFields = new Set<string>();
      fieldList.forEach((field, fi) => {
        const fp = singleKey(field);
        if (!fp) return;
        const fieldPath = `${tablePath}/fields/${fi}/${fp.key}`;
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
        const fdef = asRecord(fp.body) ?? {};
        if (fdef.is_fixed_id === true && fdef.is_readonly !== true) {
          errors.push(
            specErr(
              parsed,
              `${fieldPath}/is_fixed_id`,
              `is_fixed_id on '${fp.key}' requires is_readonly: true`,
            ),
          );
        }
        if (
          fdef.use_native_row_version === true &&
          fdef.is_optimistic_concurrency !== true
        ) {
          errors.push(
            specErr(
              parsed,
              `${fieldPath}/use_native_row_version`,
              `use_native_row_version on '${fp.key}' requires is_optimistic_concurrency: true`,
            ),
          );
        }
        if (fdef.is_optimistic_concurrency === true) occCount += 1;
        fields.set(fp.key, fieldPath);
      });
    }
    if (occCount > 1) {
      errors.push(
        specErr(
          parsed,
          tablePath,
          `at most one is_optimistic_concurrency field on ${pair.key}`,
        ),
      );
    }
    tables.set(pair.key, { path: tablePath, fields });
  });
  return { tables, errors };
}

function checkIndexes(
  parsed: ParsedYaml,
  tables: Map<string, TableInfo>,
  companionFields?: Map<string, Map<string, Record<string, unknown>>>,
): SpecValidationResult["errors"] {
  const errors: SpecValidationResult["errors"] = [];
  const types = asRecord(parsed.data)?.types;
  if (!Array.isArray(types)) return errors;

  types.forEach((entry, ti) => {
    const pair = singleKey(entry);
    if (!pair) return;
    const def = asRecord(pair.body);
    const indexes = def?.indexes;
    if (!Array.isArray(indexes)) return;
    const tablePath = `/types/${ti}/${pair.key}`;
    const known = new Set<string>([
      ...tables.get(pair.key)!.fields.keys(),
    ]);
    const companion = companionFields?.get(pair.key);
    if (companion) {
      for (const name of companion.keys()) known.add(name);
    }
    const seenIndexes = new Set<string>();
    indexes.forEach((index, ii) => {
      const ip = singleKey(index);
      if (!ip) return;
      const indexPath = `${tablePath}/indexes/${ii}/${ip.key}`;
      if (
        !pushUnique(
          seenIndexes,
          ip.key,
          errors,
          parsed,
          indexPath,
          `duplicate index '${ip.key}' on ${pair.key}`,
        )
      ) {
        return;
      }
      const cols = asRecord(ip.body)?.fields;
      if (!Array.isArray(cols)) return;
      cols.forEach((col, ci) => {
        if (typeof col !== "string") return;
        if (known.has(col)) return;
        errors.push(
          specErr(
            parsed,
            `${indexPath}/fields/${ci}`,
            `unknown field '${col}' on ${pair.key} in index '${ip.key}'`,
          ),
        );
      });
    });
  });
  return errors;
}

function checkCompanionTypes(
  parsed: ParsedYaml,
  companion: unknown,
): SpecValidationResult["errors"] {
  const errors: SpecValidationResult["errors"] = [];
  const typeFields = indexTypeFields(companion);
  const types = asRecord(parsed.data)?.types;
  if (!Array.isArray(types)) return errors;
  types.forEach((entry, ti) => {
    const pair = singleKey(entry);
    if (!pair) return;
    const tablePath = `/types/${ti}/${pair.key}`;
    if (!typeFields.has(pair.key)) {
      errors.push(
        specErr(
          parsed,
          tablePath,
          `unknown type '${pair.key}' (not in types.yaml)`,
        ),
      );
      return;
    }
    const known = typeFields.get(pair.key)!;
    const fields = asRecord(pair.body)?.fields;
    if (!Array.isArray(fields)) return;
    fields.forEach((field, fi) => {
      const fp = singleKey(field);
      if (!fp) return;
      if (known.has(fp.key)) return;
      errors.push(
        specErr(
          parsed,
          `${tablePath}/fields/${fi}/${fp.key}`,
          `unknown field '${fp.key}' on ${pair.key} (not in types.yaml)`,
        ),
      );
    });
  });
  return errors;
}

const OCC_FIELD_TYPES = new Set(["integer", "number", "datetime", "binary"]);

function inheritByType(companion: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const list = asRecord(companion)?.types;
  if (!Array.isArray(list)) return out;
  for (const entry of list) {
    const pair = singleKey(entry);
    if (!pair) continue;
    const inherits = asRecord(pair.body)?.inherits;
    if (typeof inherits === "string") out.set(pair.key, inherits);
  }
  return out;
}

function companionFieldType(
  companionFields: Map<string, Map<string, Record<string, unknown>>>,
  inherits: Map<string, string>,
  typeName: string,
  fieldName: string,
): string | undefined {
  let current: string | undefined = typeName;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const rec = companionFields.get(current)?.get(fieldName);
    if (typeof rec?.type === "string") return rec.type;
    current = inherits.get(current);
  }
}

function checkOccCompanion(
  parsed: ParsedYaml,
  companionTypes: unknown,
): SpecValidationResult["errors"] {
  const errors: SpecValidationResult["errors"] = [];
  const companionFields = indexTypeFields(companionTypes);
  const inherits = inheritByType(companionTypes);
  const types = asRecord(parsed.data)?.types;
  if (!Array.isArray(types)) return errors;
  types.forEach((entry, ti) => {
    const pair = singleKey(entry);
    if (!pair) return;
    const tablePath = `/types/${ti}/${pair.key}`;
    const fields = asRecord(pair.body)?.fields;
    if (!Array.isArray(fields)) return;
    const known = companionFields.get(pair.key);
    fields.forEach((field, fi) => {
      const fp = singleKey(field);
      if (!fp) return;
      const fdef = asRecord(fp.body) ?? {};
      if (fdef.is_optimistic_concurrency !== true) return;
      const fieldPath = `${tablePath}/fields/${fi}/${fp.key}`;
      if (!known?.has(fp.key)) {
        errors.push(
          specErr(
            parsed,
            fieldPath,
            `unknown field '${fp.key}' on ${pair.key} (not in types.yaml)`,
          ),
        );
        return;
      }
      const fieldType = companionFieldType(
        companionFields,
        inherits,
        pair.key,
        fp.key,
      );
      if (fieldType !== undefined && !OCC_FIELD_TYPES.has(fieldType)) {
        errors.push(
          specErr(
            parsed,
            fieldPath,
            `is_optimistic_concurrency field '${fp.key}' on ${pair.key} must be integer, number, datetime, or binary`,
          ),
        );
      }
      if (fdef.use_native_row_version === true && fieldType !== "binary") {
        errors.push(
          specErr(
            parsed,
            `${fieldPath}/use_native_row_version`,
            `use_native_row_version on '${fp.key}' requires a binary field`,
          ),
        );
      }
    });
  });
  return errors;
}

export function checkDatasourceModel(
  parsed: ParsedYaml,
  companionTypes?: unknown,
): SpecValidationResult {
  const { tables, errors } = collectTables(parsed);
  const companionFields =
    companionTypes !== undefined ? indexTypeFields(companionTypes) : undefined;
  errors.push(...checkIndexes(parsed, tables, companionFields));
  if (companionTypes !== undefined) {
    errors.push(...checkCompanionTypes(parsed, companionTypes));
    errors.push(...checkOccCompanion(parsed, companionTypes));
  }
  return errors.length === 0
    ? { valid: true, errors: [] }
    : { valid: false, errors };
}
