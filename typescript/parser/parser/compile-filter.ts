const ACCESSORS = new Set(["type", "tag", "inherits"]);
const ALLOWED_INTERNAL = new Set([
  "__name",
  "__tags",
  "__inherits",
  "includes",
  "true",
  "false",
  "null",
  "undefined",
  ...ACCESSORS,
]);

export type FilterCandidate = {
  name: string;
  tags: string[];
  inherits?: string;
};

export type FilterPredicate = (cand: FilterCandidate) => boolean;

type CompiledExpr = (
  name: string,
  tags: string[],
  inherits: string,
) => boolean;

const assertKnownIdents = (s: string, contextLabel: string): void => {
  for (const ident of s.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    if (ident.startsWith("__STR")) continue;
    if (ALLOWED_INTERNAL.has(ident)) continue;
    throw new Error(
      `${contextLabel}: unknown identifier or syntax near "${ident}". Supported: \`type == "name"\`, \`tag == "kind"\`, \`inherits == "parent"\`, logical && / ||, parens.`,
    );
  }
};

const compileExpr = (s: string, contextLabel: string): CompiledExpr => {
  try {
    return new Function(
      "__name",
      "__tags",
      "__inherits",
      `return (${s});`,
    ) as CompiledExpr;
  } catch (e) {
    throw new Error(
      `${contextLabel} is not a valid expression: ${(e as Error).message}`,
    );
  }
};

const rewriteDslToJs = (input: string): string =>
  input
    .replace(/\btype\s*(==|!=)\s*(__STR\d+__)/g, (_, op, idx) => {
      const jsOp = op === "==" ? "===" : "!==";
      return `(__name ${jsOp} ${idx})`;
    })
    .replace(/\btag\s*==\s*(__STR\d+__)/g, (_, idx) => `__tags.includes(${idx})`)
    .replace(/\btag\s*!=\s*(__STR\d+__)/g, (_, idx) => `!__tags.includes(${idx})`)
    .replace(/\binherits\s*(==|!=)\s*(__STR\d+__)/g, (_, op, idx) => {
      const jsOp = op === "==" ? "===" : "!==";
      return `(__inherits ${jsOp} ${idx})`;
    });

export const compileFilter = (
  filterExpr: string | null | undefined,
  contextLabel = "filter",
): FilterPredicate => {
  if (!filterExpr) return () => true;

  const placeholders: string[] = [];
  const withStrings = filterExpr.replace(/"[^"]*"/g, (m) => {
    placeholders.push(m);
    return `__STR${placeholders.length - 1}__`;
  });
  const rewritten = rewriteDslToJs(withStrings);
  assertKnownIdents(rewritten, contextLabel);
  const restored = rewritten.replace(
    /__STR(\d+)__/g,
    (_, idx) => placeholders[Number(idx)]!,
  );
  const fn = compileExpr(restored, contextLabel);
  return (cand) =>
    Boolean(fn(cand.name, cand.tags, cand.inherits ?? ""));
};

export const compileTypesFilter = (
  filterExpr: string | null | undefined,
): FilterPredicate => compileFilter(filterExpr, "types.filter");
