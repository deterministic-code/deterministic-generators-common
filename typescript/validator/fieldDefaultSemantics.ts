import { asRecord, positionFor } from "./yamlPositions.ts";
import type { ParsedYaml } from "./SpecValidator.ts";
import type { SpecValidationError, SpecValidationResult } from "./types.ts";
import {
  loadFieldTypeCatalog,
  type FieldType,
} from "./fieldTypeCatalog.ts";

function err(
  parsed: ParsedYaml,
  instancePath: string,
  message: string,
): SpecValidationError {
  const { line, col } = positionFor(parsed.doc, parsed.lineCounter, instancePath);
  return { line, col, instancePath, message };
}

function visitFieldDef(
  data: unknown,
  visit: (instancePath: string, def: Record<string, unknown>) => void,
): void {
  const root = asRecord(data);
  const types = root?.types;
  if (Array.isArray(types)) {
    types.forEach((entry, ti) => {
      const rec = asRecord(entry);
      if (!rec) return;
      const table = Object.keys(rec)[0];
      if (!table) return;
      const fields = asRecord(rec[table])?.fields;
      if (!Array.isArray(fields)) return;
      fields.forEach((field, fi) => {
        const fo = asRecord(field);
        if (!fo) return;
        const name = Object.keys(fo)[0];
        if (!name) return;
        const def = asRecord(fo[name]);
        if (def) visit(`/types/${ti}/${table}/fields/${fi}/${name}`, def);
      });
    });
  }

  const includes = root?.includes;
  if (!Array.isArray(includes)) return;
  includes.forEach((inc, ii) => {
    const opts = asRecord(asRecord(inc)?.combine_options);
    if (!opts) return;
    for (const side of ["source", "destination"] as const) {
      const sideOpts = asRecord(opts[side]);
      if (!sideOpts) continue;
      const modify = sideOpts.modify_fields;
      if (Array.isArray(modify)) {
        modify.forEach((op, mi) => {
          const def = asRecord(asRecord(op)?.def);
          if (def) {
            visit(
              `/includes/${ii}/combine_options/${side}/modify_fields/${mi}/def`,
              def,
            );
          }
        });
      }
      const add = sideOpts.add_fields;
      if (!Array.isArray(add)) continue;
      add.forEach((op, ai) => {
        const addField = asRecord(asRecord(op)?.add_field);
        if (!addField) return;
        const name = Object.keys(addField)[0];
        if (!name) return;
        const def = asRecord(addField[name]);
        if (def) {
          visit(
            `/includes/${ii}/combine_options/${side}/add_fields/${ai}/add_field/${name}`,
            def,
          );
        }
      });
    }
  });
}

function tokenError(
  catalog: FieldType,
  value: string,
): string | null {
  if (catalog.defaults.length === 0) return null;
  if (catalog.defaults.some((tok) => new RegExp(tok.regex).test(value))) {
    return null;
  }
  const allowed = catalog.defaults.map((tok) => tok.token).join(", ");
  return `default_value '${value}' is not a valid ${catalog.name} default — allowed forms: ${allowed}`;
}

function rangeError(
  catalog: FieldType,
  value: unknown,
): string | null {
  if (catalog.min_value == null && catalog.max_value == null) return null;
  if (value === undefined || value === null) return null;
  const raw = String(value);
  if (!/^-?\d+$/.test(raw)) return null;
  const n = BigInt(raw);
  const min = catalog.min_value != null ? BigInt(catalog.min_value) : null;
  const max = catalog.max_value != null ? BigInt(catalog.max_value) : null;
  if ((min !== null && n < min) || (max !== null && n > max)) {
    return `default_value '${raw}' is out of range for ${catalog.name} (allowed ${catalog.min_value}..${catalog.max_value})`;
  }
  return null;
}

export function checkFieldDefaults(
  parsed: ParsedYaml,
  catalog: Map<string, FieldType>,
): SpecValidationResult {
  const errors: SpecValidationError[] = [];
  visitFieldDef(parsed.data, (basePath, def) => {
    if (!("default_value" in def)) return;
    const typeName = def.type;
    if (typeof typeName !== "string") return;
    const field = catalog.get(typeName);
    if (!field) return;
    const value = def.default_value;
    const path = `${basePath}/default_value`;
    if (typeof value === "string") {
      const token = tokenError(field, value);
      if (token) errors.push(err(parsed, path, token));
    }
    if (typeName === "character" && typeof value === "string") {
      const size = typeof def.size === "number" ? def.size : 1;
      if (value.length !== size) {
        errors.push(
          err(
            parsed,
            path,
            `character default_value length must equal size (${size})`,
          ),
        );
      }
    }
    const range = rangeError(field, value);
    if (range) errors.push(err(parsed, path, range));
  });
  return errors.length === 0
    ? { valid: true, errors: [] }
    : { valid: false, errors };
}

export async function checkFieldDefaultSemantics(
  parsed: ParsedYaml,
): Promise<SpecValidationResult> {
  return checkFieldDefaults(parsed, await loadFieldTypeCatalog());
}
