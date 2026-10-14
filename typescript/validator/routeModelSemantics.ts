import { asRecord } from "./yamlPositions.ts";
import type { SpecValidationResult } from "./types.ts";
import type { ParsedYaml } from "./SpecValidator.ts";
import { pushUnique, singleKey, specErr } from "./semanticsUtil.ts";

function routeName(entry: unknown): { name: string; path: string } | null {
  if (typeof entry === "string" && entry.length > 0) {
    return { name: entry, path: "" };
  }
  const pair = singleKey(entry);
  if (!pair) return null;
  return { name: pair.key, path: `/${pair.key}` };
}

function dispatchKinds(shape: Record<string, unknown>): string[] {
  const kinds: string[] = [];
  if ("service" in shape) kinds.push("service");
  if ("services" in shape) kinds.push("services");
  if ("routeClass" in shape || "module" in shape) kinds.push("routeClass/module");
  return kinds;
}

export function checkRouteModel(parsed: ParsedYaml): SpecValidationResult {
  const errors: SpecValidationResult["errors"] = [];
  const routes = asRecord(parsed.data)?.routes;
  if (!Array.isArray(routes)) return { valid: true, errors: [] };

  const seen = new Set<string>();
  routes.forEach((entry, i) => {
    const named = routeName(entry);
    if (!named) return;
    const path = `/routes/${i}${named.path}`;
    pushUnique(
      seen,
      named.name,
      errors,
      parsed,
      path,
      `duplicate route '${named.name}'`,
    );

    const pair = singleKey(entry);
    const shape = pair ? asRecord(pair.body) : null;
    if (!shape) return;
    const kinds = dispatchKinds(shape);
    if (kinds.length > 1) {
      errors.push(
        specErr(
          parsed,
          path,
          `custom route cannot combine ${kinds.join(" and ")}`,
        ),
      );
    }
  });
  return errors.length === 0
    ? { valid: true, errors: [] }
    : { valid: false, errors };
}
