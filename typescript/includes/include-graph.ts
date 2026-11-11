import { isDeepStrictEqual } from "node:util";

export interface IncludeGraphCtx {
  visited?: Set<string>;
  loaded?: Map<string, unknown>;
}

export function includeGraph(ctx: IncludeGraphCtx): {
  visited: Set<string>;
  loaded: Map<string, unknown>;
} {
  return {
    visited: ctx.visited ?? new Set(),
    loaded: ctx.loaded ?? new Map(),
  };
}

/**
 * Ancestor-stack cycle, then one load per loader key. Missing combine_options
 * and `{}` compare equal. A later edge with the same options is skipped; a
 * later edge with different options throws.
 */
export function takeIncludeEdge(
  key: string,
  options: unknown,
  graph: { visited: Set<string>; loaded: Map<string, unknown> },
): "skip" | "load" {
  if (graph.visited.has(key)) {
    throw new Error(`include cycle detected at '${key}'`);
  }
  const normalized = options ?? {};
  if (graph.loaded.has(key)) {
    if (isDeepStrictEqual(graph.loaded.get(key), normalized)) return "skip";
    throw new Error(
      `include '${key}' combine_options differ from the first load`,
    );
  }
  graph.loaded.set(key, normalized);
  return "load";
}
