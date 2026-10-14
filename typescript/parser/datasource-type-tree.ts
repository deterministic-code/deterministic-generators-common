import { stringify } from "yaml";
import type { Type } from "./specification.ts";

export type DatasourceTypeTree = { [name: string]: DatasourceTypeTree };

export type DatasourceTypeGraphEdge = {
  from: string;
  to: string;
};

export type DatasourceTypeGraph = {
  nodes: string[];
  edges: DatasourceTypeGraphEdge[];
};

export type DatasourceTypeHierarchies = {
  firstParentTree: DatasourceTypeTree;
  allParentsTree: DatasourceTypeTree;
  graph: DatasourceTypeGraph;
};

const ROOT = "root";

const refTargets = (references: string | [string, string]): string[] =>
  (Array.isArray(references) ? references : [references]).map(
    (ref) => ref.split(".")[0] || "",
  );

const referencedParents = (
  type: Type,
  typeNames: ReadonlySet<string>,
): string[] => {
  const parents: string[] = [];
  const seen = new Set<string>();
  for (const field of type.fields) {
    if (field.references === undefined) continue;
    for (const parent of refTargets(field.references)) {
      if (
        parent.length === 0 ||
        parent === type.name ||
        !typeNames.has(parent) ||
        seen.has(parent)
      ) {
        continue;
      }
      seen.add(parent);
      parents.push(parent);
    }
  }
  return parents;
};

const addChild = (
  children: Map<string, string[]>,
  parent: string,
  child: string,
): void => {
  const list = children.get(parent);
  if (list === undefined) {
    children.set(parent, [child]);
    return;
  }
  if (!list.includes(child)) list.push(child);
};

/** Child → parent edges. Each SCC id maps to its members. */
const stronglyConnected = (
  names: readonly string[],
  parentsOf: (name: string) => readonly string[],
): Map<string, number> => {
  let index = 0;
  let sccCount = 0;
  const indices = new Map<string, number>();
  const lows = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const sccId = new Map<string, number>();

  const connect = (v: string): void => {
    indices.set(v, index);
    lows.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of parentsOf(v)) {
      if (!indices.has(w)) {
        connect(w);
        const vLow = lows.get(v);
        const wLow = lows.get(w);
        if (vLow !== undefined && wLow !== undefined) {
          lows.set(v, Math.min(vLow, wLow));
        }
      } else if (onStack.has(w)) {
        const vLow = lows.get(v);
        const wIndex = indices.get(w);
        if (vLow !== undefined && wIndex !== undefined) {
          lows.set(v, Math.min(vLow, wIndex));
        }
      }
    }
    if (lows.get(v) === indices.get(v)) {
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        sccId.set(w, sccCount);
      } while (w !== v);
      sccCount += 1;
    }
  };

  for (const name of names) {
    if (!indices.has(name)) connect(name);
  }
  return sccId;
};

/** SCCs with no parent outside the component are top-level; those types point at root. */
const sccsWithExternalParent = (
  parentLists: ReadonlyMap<string, readonly string[]>,
  sccId: ReadonlyMap<string, number>,
): Set<number> => {
  const hasExternal = new Set<number>();
  for (const [name, parents] of parentLists) {
    const from = sccId.get(name)!;
    for (const parent of parents) {
      const to = sccId.get(parent);
      if (to !== undefined && to !== from) hasExternal.add(from);
    }
  }
  return hasExternal;
};

const buildNode = (
  children: Map<string, string[]>,
  name: string,
  path: ReadonlySet<string>,
): DatasourceTypeTree => {
  const node: DatasourceTypeTree = {};
  for (const child of children.get(name) ?? []) {
    if (path.has(child)) continue;
    node[child] = buildNode(children, child, new Set([...path, child]));
  }
  return node;
};

const chosenParents = (
  types: readonly Type[],
  multiParent: "first" | "all",
): Map<string, readonly string[]> => {
  const typeNames = new Set(types.map((type) => type.name));
  const parentLists = new Map<string, readonly string[]>();
  for (const type of types) {
    const parents = referencedParents(type, typeNames);
    parentLists.set(
      type.name,
      multiParent === "all" ? parents : parents.slice(0, 1),
    );
  }
  return parentLists;
};

const buildTree = (
  types: readonly Type[],
  parentLists: ReadonlyMap<string, readonly string[]>,
): DatasourceTypeTree => {
  const names = types.map((type) => type.name);
  const sccId = stronglyConnected(names, (name) => parentLists.get(name)!);
  const hasExternalParent = sccsWithExternalParent(parentLists, sccId);
  const children = new Map<string, string[]>();
  for (const type of types) {
    const scc = sccId.get(type.name)!;
    const parents = parentLists.get(type.name)!;
    if (!hasExternalParent.has(scc)) {
      addChild(children, ROOT, type.name);
      continue;
    }
    for (const parent of parents) {
      addChild(children, parent, type.name);
    }
  }
  return { [ROOT]: buildNode(children, ROOT, new Set([ROOT])) };
};

export const datasourceTypeTree = (
  types: readonly Type[],
  options: { multiParent?: "first" | "all" } = {},
): DatasourceTypeTree =>
  buildTree(types, chosenParents(types, options.multiParent ?? "first"));

/** Each type appears once; first `references` parent wins. Cycle tops point at root. */
export const datasourceTypeTreeFirst = (
  types: readonly Type[],
): DatasourceTypeTree => datasourceTypeTree(types, { multiParent: "first" });

/** A type with several parents is nested under each of them. */
export const datasourceTypeTreeAll = (
  types: readonly Type[],
): DatasourceTypeTree => datasourceTypeTree(types, { multiParent: "all" });

/** Child → parent edges. Parentless types point at root; cycles and multi-parent are kept. */
export const datasourceTypeGraph = (
  types: readonly Type[],
): DatasourceTypeGraph => {
  const parentLists = chosenParents(types, "all");
  const nodes = [ROOT, ...types.map((type) => type.name)];
  const edges: DatasourceTypeGraphEdge[] = [];
  for (const type of types) {
    const parents = parentLists.get(type.name)!;
    if (parents.length === 0) {
      edges.push({ from: type.name, to: ROOT });
      continue;
    }
    for (const parent of parents) {
      edges.push({ from: type.name, to: parent });
    }
  }
  return { nodes, edges };
};

export const datasourceTypeHierarchies = (
  types: readonly Type[],
): DatasourceTypeHierarchies => ({
  firstParentTree: datasourceTypeTreeFirst(types),
  allParentsTree: datasourceTypeTreeAll(types),
  graph: datasourceTypeGraph(types),
});

/** Pre-order walk of the first-parent tree (parent before children, authored sibling order). */
export const datasourceTypeOrder = (
  types: readonly Type[],
): string[] => {
  const names: string[] = [];
  const walk = (node: DatasourceTypeTree) => {
    for (const [name, child] of Object.entries(node)) {
      names.push(name);
      walk(child);
    }
  };
  walk(datasourceTypeTreeFirst(types)[ROOT]!);
  return names;
};

/**
 * All in-set `references` parents of `name`, recursively, parent before child.
 * Does not include `name`. Self-edges and cycles are skipped.
 */
export const datasourceTypeAncestry = (
  types: readonly Type[],
  name: string,
): string[] => {
  const parentLists = chosenParents(types, "all");
  if (!parentLists.has(name)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (current: string, path: ReadonlySet<string>): void => {
    for (const parent of parentLists.get(current)!) {
      if (path.has(parent) || seen.has(parent)) continue;
      walk(parent, new Set([...path, current]));
      seen.add(parent);
      out.push(parent);
    }
  };
  walk(name, new Set([name]));
  return out;
};

/** Rank by tree order; names that inherit a type sort just after that type. */
export const compareByDatasourceTypeOrder = (
  types: readonly Type[],
  inheritOf: (name: string) => string | null | undefined = () => undefined,
): ((a: string, b: string) => number) => {
  const order = datasourceTypeOrder(types);
  const rank = new Map(order.map((name, i) => [name, i]));
  const key = (name: string): [number, string] => {
    const direct = rank.get(name);
    if (direct !== undefined) return [direct * 2, name];
    const inherit = inheritOf(name);
    if (inherit !== null && inherit !== undefined) {
      const parent = rank.get(inherit);
      if (parent !== undefined) return [parent * 2 + 1, name];
    }
    return [order.length * 2, name];
  };
  return (a, b) => {
    const [ia, na] = key(a);
    const [ib, nb] = key(b);
    return ia - ib || na.localeCompare(nb);
  };
};

export const datasourceTypeTreeYaml = (tree: DatasourceTypeTree): string =>
  stringify(tree);

export const datasourceTypeTreeJson = (tree: DatasourceTypeTree): string =>
  `${JSON.stringify(tree, null, 2)}\n`;

const xmlElement = (
  name: string,
  children: DatasourceTypeTree,
  indent: string,
): string => {
  const keys = Object.keys(children);
  if (keys.length === 0) return `${indent}<${name}/>\n`;
  const inner = keys
    .map((key) => xmlElement(key, children[key]!, `${indent}  `))
    .join("");
  return `${indent}<${name}>\n${inner}${indent}</${name}>\n`;
};

export const datasourceTypeTreeXml = (tree: DatasourceTypeTree): string =>
  Object.keys(tree)
    .map((key) => xmlElement(key, tree[key]!, ""))
    .join("");

export const datasourceTypeGraphYaml = (graph: DatasourceTypeGraph): string =>
  stringify(graph);

export const datasourceTypeGraphJson = (graph: DatasourceTypeGraph): string =>
  `${JSON.stringify(graph, null, 2)}\n`;

export const datasourceTypeGraphXml = (graph: DatasourceTypeGraph): string => {
  const nodes = graph.nodes
    .map((name) => `    <node>${name}</node>\n`)
    .join("");
  const edges = graph.edges
    .map((edge) => `    <edge from="${edge.from}" to="${edge.to}"/>\n`)
    .join("");
  return `<graph>\n  <nodes>\n${nodes}  </nodes>\n  <edges>\n${edges}  </edges>\n</graph>\n`;
};
