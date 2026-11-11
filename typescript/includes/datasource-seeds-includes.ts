import { parse, stringify } from "yaml";
import { combineDatasourceSeeds } from "./datasource-seeds-combine.ts";
import { emptyReport, mergeReports } from "./types-combine-core.ts";
import type { FlatCombineOptions } from "./types-combine-core.ts";
import { includeGraph, takeIncludeEdge } from "./include-graph.ts";

type CombineReport = ReturnType<typeof emptyReport>;

interface ResolveCtx {
  baseDir?: string;
  visited?: Set<string>;
  loaded?: Map<string, unknown>;
}

interface SeedInclude {
  file?: string;
  id?: string | number;
  uuid?: string;
  user_id?: number;
  name?: string;
  combine_options?: FlatCombineOptions;
}

interface LoadedInclude {
  text: string;
  key: string;
  ctx: ResolveCtx;
}

type Load = (include: SeedInclude, ctx: ResolveCtx) => Promise<LoadedInclude>;

interface ResolveResult {
  yaml: string;
  report: CombineReport;
}

interface SeedDoc {
  includes?: SeedInclude[];
  [key: string]: unknown;
}

function withoutIncludes(doc: SeedDoc): SeedDoc {
  const rest = { ...doc };
  delete rest.includes;
  return rest;
}

/**
 * Recursively resolve a datasource_seeds document's `includes:` by folding each
 * included config in as the combine `source` (its seed blocks prepended) and
 * the current accumulator as the `destination`. Includes are folded in reverse
 * so earlier-listed includes appear before later ones, and this document's own
 * seeds come last.
 *
 * `load(include, ctx)` is injected — it returns `{ text, key, ctx }` for the
 * referenced config (file read, HTTP, DB, …). `key` is the include identity:
 * a path already on `ctx.visited` (the ancestor stack) is a cycle; a path
 * already in the graph-wide `ctx.loaded` map is skipped when this edge's
 * `combine_options` deep-equal the first load (missing and `{}` are the same)
 * and throws when they differ. The returned `ctx` is passed to the nested
 * resolution so relative paths rebase correctly. Seed `ctx.visited` to catch
 * cycles back to the root. Pure aside from the injected loader; collisions
 * and unknown `remove_types` targets throw via `combineDatasourceSeeds`.
 */
export async function resolveSeedIncludes(
  rootYaml: string,
  load: Load,
  ctx: ResolveCtx = {},
): Promise<ResolveResult> {
  const doc = (parse(rootYaml) as SeedDoc | null) ?? {};
  const includes = Array.isArray(doc.includes) ? doc.includes : [];
  if (includes.length === 0) {
    return { yaml: rootYaml, report: emptyReport() };
  }

  const { visited, loaded: loadedKeys } = includeGraph(ctx);
  const reports: CombineReport[] = [];
  let accYaml = stringify(withoutIncludes(doc));

  for (const include of [...includes].reverse()) {
    const loaded = await load(include, ctx);
    if (
      takeIncludeEdge(loaded.key, include.combine_options, {
        visited,
        loaded: loadedKeys,
      }) === "skip"
    ) {
      continue;
    }
    const child = await resolveSeedIncludes(loaded.text, load, {
      ...loaded.ctx,
      visited: new Set(visited).add(loaded.key),
      loaded: loadedKeys,
    });
    reports.push(child.report);
    const combined = combineDatasourceSeeds(
      child.yaml,
      accYaml,
      include.combine_options ?? {},
    );
    reports.push(combined.report);
    accYaml = combined.yaml;
  }

  return { yaml: accYaml, report: mergeReports(reports) };
}

export { combineDatasourceSeeds } from "./datasource-seeds-combine.ts";
