import { parse, stringify } from "yaml";
import { combineDatasourceTypes } from "./datasource-types-combine.ts";
import {
  availableHasAllNames,
  availableNames,
  emptyReport,
  mergeReports,
  pruneDiamondRemoves,
  recordFoldedNames,
} from "./types-combine-core.ts";
import { mergeCustomMigrations } from "./custom-migrations-merge.ts";
import { includeGraph, takeIncludeEdge } from "./include-graph.ts";
import type { RawTypesDoc } from "./deterministic-shapes.ts";

interface CustomMigrationPair {
  order: number;
  name: string;
  up: string;
  down: string;
}

type CombineReport = ReturnType<typeof emptyReport>;
type CustomMigrations = Record<string, CustomMigrationPair[]>;
type DatasourceCombineOptions = NonNullable<
  Parameters<typeof combineDatasourceTypes>[2]
>;

interface ResolveCtx {
  baseDir?: string;
  visited?: Set<string>;
  loaded?: Map<string, unknown>;
  foldedNames?: Set<string>;
  /** Type names already on ancestor accumulators (parent → root). */
  presentNames?: ReadonlySet<string>;
}

interface DatasourceInclude {
  file?: string;
  id?: string | number;
  combine_options?: DatasourceCombineOptions;
}

interface LoadedInclude {
  text: string;
  key: string;
  ctx: ResolveCtx;
  customMigrations?: CustomMigrations;
}

type Load = (
  include: DatasourceInclude,
  ctx: ResolveCtx,
) => Promise<LoadedInclude>;

interface ResolveResult {
  yaml: string;
  report: CombineReport;
  customMigrations: CustomMigrations;
}

function withoutIncludes(doc: RawTypesDoc): RawTypesDoc {
  const rest = { ...doc };
  delete rest.includes;
  return rest;
}

/**
 * Recursively resolve a datasource_types document's `includes:` by folding each
 * included config in as the combine `source` (its types prepended) and the
 * current accumulator as the `destination`. Includes are folded in reverse so
 * that, in the merged output, earlier-listed includes appear before later ones,
 * and the including config's own types come last.
 *
 * `load(include, ctx)` is injected — it returns `{ text, key, ctx, customMigrations }`
 * for the referenced config (file read, HTTP, DB, …). `key` is the include
 * identity: a path already on `ctx.visited` (the ancestor stack) is a cycle;
 * a path already in the graph-wide `ctx.loaded` map is skipped when this
 * edge's `combine_options` deep-equal the first load (missing and `{}` are
 * the same) and throws when they differ. A skipped path stays skipped when
 * this accumulator or an ancestor already holds every name from the file's own
 * body (sibling diamonds such as `base.yaml` under both `user-roles.yaml` and
 * `applications.yaml`). When those names are missing — including after an
 * ancestor's `remove_types` — the skip re-folds the file's own body so a later
 * path can restore them. Names folded anywhere in the graph stay in
 * `foldedNames` so a later sibling's `remove_types` for a diamond-skipped
 * nested type is treated as already satisfied. The returned `ctx` is passed to
 * the nested resolution so relative paths rebase correctly; `customMigrations`
 * (a `{ [dialect]: [pairs] }` map, optional) carries that datasource's
 * hand-authored `custom/` SQL so `skip_migrations` entities keep their DDL
 * across the include. Seed `ctx.visited` to catch cycles back to the root.
 * Pure aside from the injected loader; combine collisions / invalid
 * references throw via `combineDatasourceTypes`.
 */
export async function resolveIncludes(
  rootYaml: string,
  load: Load,
  ctx: ResolveCtx = {},
): Promise<ResolveResult> {
  const doc = (parse(rootYaml) as RawTypesDoc | null) ?? {};
  const includes = (
    Array.isArray(doc.includes) ? doc.includes : []
  ) as DatasourceInclude[];
  if (includes.length === 0) {
    return { yaml: rootYaml, report: emptyReport(), customMigrations: {} };
  }

  const { visited, loaded: loadedKeys } = includeGraph(ctx);
  const foldedNames = ctx.foldedNames ?? new Set<string>();
  const reports: CombineReport[] = [];
  const customMigrations: CustomMigrations = {};
  let accYaml = stringify(withoutIncludes(doc));
  recordFoldedNames(foldedNames, accYaml, "types");

  for (const include of [...includes].reverse()) {
    const loaded = await load(include, ctx);
    if (
      takeIncludeEdge(loaded.key, include.combine_options, {
        visited,
        loaded: loadedKeys,
      }) === "skip"
    ) {
      const ownYaml = stringify(
        withoutIncludes((parse(loaded.text) as RawTypesDoc | null) ?? {}),
      );
      const available = availableNames(accYaml, "types", ctx.presentNames);
      if (
        availableHasAllNames(available, loaded.text, "types") ||
        availableHasAllNames(available, ownYaml, "types")
      ) {
        continue;
      }
      recordFoldedNames(foldedNames, ownYaml, "types");
      const recovered = combineDatasourceTypes(
        ownYaml,
        accYaml,
        pruneDiamondRemoves(
          include.combine_options ?? {},
          ownYaml,
          accYaml,
          foldedNames,
          "types",
        ) ?? {},
      );
      reports.push(recovered.report);
      accYaml = recovered.yaml;
      continue;
    }
    const child = await resolveIncludes(loaded.text, load, {
      ...loaded.ctx,
      visited: new Set(visited).add(loaded.key),
      loaded: loadedKeys,
      foldedNames,
      presentNames: availableNames(accYaml, "types", ctx.presentNames),
    });
    reports.push(child.report);
    mergeCustomMigrations(
      customMigrations,
      loaded.customMigrations,
      loaded.key,
    );
    mergeCustomMigrations(customMigrations, child.customMigrations, loaded.key);
    recordFoldedNames(foldedNames, child.yaml, "types");
    const combined = combineDatasourceTypes(
      child.yaml,
      accYaml,
      pruneDiamondRemoves(
        include.combine_options ?? {},
        child.yaml,
        accYaml,
        foldedNames,
        "types",
      ) ?? {},
    );
    reports.push(combined.report);
    accYaml = combined.yaml;
  }

  return { yaml: accYaml, report: mergeReports(reports), customMigrations };
}
