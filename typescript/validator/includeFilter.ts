import { asRecord } from "./yamlPositions.ts";
import type { SpecValidationError, SpecValidationResult } from "./types.ts";
import type { ParsedYaml } from "./SpecValidator.ts";
import { specErr } from "./semanticsUtil.ts";

const ACCESSORS = new Set(["type", "tag", "inherits"]);

type Op = "||" | "&&" | "==" | "!=" | "(" | ")" | "eof";
type Tok =
  | { kind: "ident"; value: string }
  | { kind: "string"; value: string }
  | { kind: "op"; value: Op };

export type FilterParseResult = { ok: true } | { ok: false; message: string };

function tokenize(input: string): Tok[] | { error: string } {
  const tokens: Tok[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (input.startsWith("||", i)) {
      tokens.push({ kind: "op", value: "||" });
      i += 2;
      continue;
    }
    if (input.startsWith("&&", i)) {
      tokens.push({ kind: "op", value: "&&" });
      i += 2;
      continue;
    }
    if (input.startsWith("==", i)) {
      tokens.push({ kind: "op", value: "==" });
      i += 2;
      continue;
    }
    if (input.startsWith("!=", i)) {
      tokens.push({ kind: "op", value: "!=" });
      i += 2;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push({ kind: "op", value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      i += 1;
      let value = "";
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < input.length) {
          value += input[i + 1];
          i += 2;
          continue;
        }
        value += input[i];
        i += 1;
      }
      if (i >= input.length) return { error: "unterminated string literal" };
      i += 1;
      tokens.push({ kind: "string", value });
      continue;
    }
    if (/[a-z_]/.test(ch)) {
      let value = "";
      while (i < input.length && /[a-z0-9_]/.test(input[i]!)) {
        value += input[i];
        i += 1;
      }
      tokens.push({ kind: "ident", value });
      continue;
    }
    return { error: `unexpected character '${ch}'` };
  }
  tokens.push({ kind: "op", value: "eof" });
  return tokens;
}

class Parser {
  #tokens: Tok[];
  #i = 0;

  constructor(tokens: Tok[]) {
    this.#tokens = tokens;
  }

  parse(): FilterParseResult {
    const atom = this.#or();
    if (!atom.ok) return atom;
    if (!this.#is("op", "eof")) {
      return { ok: false, message: this.#unexpected() };
    }
    return { ok: true };
  }

  #or(): FilterParseResult {
    const left = this.#and();
    if (!left.ok) return left;
    while (this.#is("op", "||")) {
      this.#i += 1;
      const right = this.#and();
      if (!right.ok) return right;
    }
    return { ok: true };
  }

  #and(): FilterParseResult {
    const left = this.#atom();
    if (!left.ok) return left;
    while (this.#is("op", "&&")) {
      this.#i += 1;
      const right = this.#atom();
      if (!right.ok) return right;
    }
    return { ok: true };
  }

  #atom(): FilterParseResult {
    if (this.#is("op", "(")) {
      this.#i += 1;
      const inner = this.#or();
      if (!inner.ok) return inner;
      if (!this.#is("op", ")")) {
        return { ok: false, message: "expected ')'" };
      }
      this.#i += 1;
      return { ok: true };
    }
    const tok = this.#peek();
    if (tok?.kind === "ident" && ACCESSORS.has(tok.value)) {
      return this.#compare(tok.value);
    }
    return { ok: false, message: this.#unexpected() };
  }

  #compare(accessor: string): FilterParseResult {
    this.#i += 1;
    if (!this.#is("op", "==") && !this.#is("op", "!=")) {
      return { ok: false, message: `expected == or != after ${accessor}` };
    }
    this.#i += 1;
    const value = this.#peek();
    if (value?.kind === "string") {
      this.#i += 1;
      return { ok: true };
    }
    if (value?.kind === "ident") {
      return {
        ok: false,
        message: `unquoted '${value.value}'; wrap names in double quotes`,
      };
    }
    return { ok: false, message: `expected a quoted string after ${accessor}` };
  }

  #peek(): Tok | undefined {
    return this.#tokens[this.#i];
  }

  #is(kind: Tok["kind"], value: string): boolean {
    const tok = this.#peek();
    return tok?.kind === kind && tok.value === value;
  }

  #unexpected(): string {
    const tok = this.#peek();
    if (!tok || (tok.kind === "op" && tok.value === "eof")) {
      return "unexpected end of filter";
    }
    if (tok.kind === "ident") {
      return `unexpected identifier '${tok.value}'`;
    }
    if (tok.kind === "string") {
      return `unexpected string "${tok.value}"`;
    }
    return `unexpected '${tok.value}'`;
  }
}

export function parseIncludeFilter(expr: string): FilterParseResult {
  const tokens = tokenize(expr);
  if ("error" in tokens) {
    return { ok: false, message: `invalid include filter: ${tokens.error}` };
  }
  const parsed = new Parser(tokens).parse();
  if (!parsed.ok) {
    return { ok: false, message: `invalid include filter: ${parsed.message}` };
  }
  return parsed;
}

function filterEntries(
  data: unknown,
): Array<{ instancePath: string; filter: string }> {
  const includes = asRecord(data)?.includes;
  if (!Array.isArray(includes)) return [];
  const out: Array<{ instancePath: string; filter: string }> = [];
  includes.forEach((entry, i) => {
    const rec = asRecord(entry);
    if (!rec) return;
    const filter = asRecord(rec.types)?.filter;
    if (typeof filter === "string") {
      out.push({
        instancePath: `/includes/${i}/types/filter`,
        filter,
      });
    }
  });
  return out;
}

export type FilterCandidate = {
  name: string;
  tags: string[];
  inherits?: string;
};

export function matchTypesFilter(
  expr: string | undefined,
  cand: FilterCandidate,
): boolean {
  if (!expr) return true;
  const placeholders: string[] = [];
  const withStrings = expr.replace(/"[^"]*"/g, (m) => {
    placeholders.push(m);
    return `__STR${placeholders.length - 1}__`;
  });
  const rewritten = withStrings
    .replace(/\btype\s*(==|!=)\s*(__STR\d+__)/g, (_, op, idx) => {
      const jsOp = op === "==" ? "===" : "!==";
      return `(__name ${jsOp} ${idx})`;
    })
    .replace(/\btag\s*==\s*(__STR\d+__)/g, (_, idx) => `__tags.includes(${idx})`)
    .replace(/\btag\s*!=\s*(__STR\d+__)/g, (_, idx) => `!__tags.includes(${idx})`)
    .replace(/\binherits\s*(==|!=)\s*(__STR\d+__)/g, (_, op, idx) => {
      const jsOp = op === "==" ? "===" : "!==";
      return `(__inherits ${jsOp} ${idx})`;
    })
    .replace(/__STR(\d+)__/g, (_, idx) => placeholders[Number(idx)]!);
  try {
    const fn = new Function(
      "__name",
      "__tags",
      "__inherits",
      `return (${rewritten});`,
    ) as (name: string, tags: string[], inherits: string) => boolean;
    return Boolean(fn(cand.name, cand.tags, cand.inherits ?? ""));
  } catch {
    return false;
  }
}

export function checkIncludeFilters(parsed: ParsedYaml): SpecValidationResult {
  const errors: SpecValidationError[] = [];
  for (const { instancePath, filter } of filterEntries(parsed.data)) {
    const result = parseIncludeFilter(filter);
    if (!result.ok) {
      errors.push(specErr(parsed, instancePath, result.message));
    }
  }
  return errors.length === 0
    ? { valid: true, errors: [] }
    : { valid: false, errors };
}
