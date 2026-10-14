import { asRecord } from "./yamlPositions.ts";
import type { SpecValidationResult } from "./types.ts";
import type { ParsedYaml } from "./SpecValidator.ts";
import { pushUnique } from "./semanticsUtil.ts";

export function checkServiceModel(parsed: ParsedYaml): SpecValidationResult {
  const errors: SpecValidationResult["errors"] = [];
  const services = asRecord(parsed.data)?.services;
  if (!Array.isArray(services)) return { valid: true, errors: [] };

  const seen = new Set<string>();
  services.forEach((entry, i) => {
    const rec = asRecord(entry);
    const name = rec?.name;
    if (typeof name !== "string" || name.length === 0) return;
    pushUnique(
      seen,
      name,
      errors,
      parsed,
      `/services/${i}/name`,
      `duplicate service '${name}'`,
    );
  });
  return errors.length === 0
    ? { valid: true, errors: [] }
    : { valid: false, errors };
}
