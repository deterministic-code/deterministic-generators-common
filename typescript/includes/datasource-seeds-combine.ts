import { parse, stringify } from "yaml";
import {
  makeFlatCombine,
  type FlatCombineOptions,
} from "./types-combine-core.ts";

const seeds = makeFlatCombine({
  arrayKey: "seeds",
  nameOf: (entry) => Object.keys(entry as object)[0] ?? "",
  removeKey: "remove_types",
  label: "datasource_seeds",
});

/**
 * Combine two datasource_seeds documents. Applies each side's `remove_types`,
 * concatenates source-then-destination seed blocks, and throws when a type
 * name still overlaps or a remove target is missing. `version` is taken from
 * the destination, then the source. Includes are not copied.
 */
export function combineDatasourceSeeds(
  sourceYaml: string,
  destYaml: string,
  options: FlatCombineOptions = {},
) {
  const { yaml, report } = seeds.combine(sourceYaml, destYaml, options);
  const source = (parse(sourceYaml) ?? {}) as { version?: string };
  const dest = (parse(destYaml) ?? {}) as { version?: string };
  const version = dest.version ?? source.version;
  const body = (parse(yaml) ?? {}) as Record<string, unknown>;
  const combined = version !== undefined ? { version, ...body } : body;
  return { yaml: stringify(combined), report };
}

export function reportCombineDatasourceSeeds(
  sourceYaml: string,
  destYaml: string,
  options: FlatCombineOptions = {},
) {
  return seeds.report(sourceYaml, destYaml, options);
}
