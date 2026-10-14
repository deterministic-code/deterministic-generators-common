import { asRecord, positionFor } from "./yamlPositions.ts";
import type { SpecValidationError } from "./types.ts";
import type { ParsedYaml } from "./SpecValidator.ts";

export function specErr(
  parsed: ParsedYaml,
  instancePath: string,
  message: string,
): SpecValidationError {
  const { line, col } = positionFor(parsed.doc, parsed.lineCounter, instancePath);
  return { line, col, instancePath, message };
}

export function singleKey(
  value: unknown,
): { key: string; body: unknown } | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const key = Object.keys(rec)[0];
  if (!key) return null;
  return { key, body: rec[key] };
}

export function pushUnique(
  seen: Set<string>,
  name: string,
  errors: SpecValidationError[],
  parsed: ParsedYaml,
  instancePath: string,
  message: string,
): boolean {
  if (seen.has(name)) {
    errors.push(specErr(parsed, instancePath, message));
    return false;
  }
  seen.add(name);
  return true;
}
