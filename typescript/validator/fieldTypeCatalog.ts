import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { findSpecPath } from "./resolveSpecPath.ts";
import { asRecord } from "./yamlPositions.ts";

export interface DefaultToken {
  token: string;
  regex: string;
  description?: string;
}

export interface FieldType {
  name: string;
  supports_size?: boolean;
  implicit_default?: string | number | boolean | null;
  min_value?: string | null;
  max_value?: string | null;
  defaults: DefaultToken[];
}

function singleKey(
  value: unknown,
): { key: string; body: Record<string, unknown> } | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const key = Object.keys(rec)[0];
  if (!key) return null;
  return { key, body: asRecord(rec[key]) ?? {} };
}

function parseDefaults(raw: unknown): DefaultToken[] {
  if (!Array.isArray(raw)) return [];
  const out: DefaultToken[] = [];
  for (const entry of raw) {
    const pair = singleKey(entry);
    if (!pair) continue;
    const regex = pair.body.regex;
    if (typeof regex !== "string") continue;
    out.push({
      token: pair.key,
      regex,
      description:
        typeof pair.body.description === "string"
          ? pair.body.description
          : undefined,
    });
  }
  return out;
}

function parseType(entry: unknown): FieldType | null {
  const pair = singleKey(entry);
  if (!pair) return null;
  const min = pair.body.min_value;
  const max = pair.body.max_value;
  return {
    name: pair.key,
    supports_size:
      typeof pair.body.supports_size === "boolean"
        ? pair.body.supports_size
        : undefined,
    implicit_default:
      pair.body.implicit_default as FieldType["implicit_default"],
    min_value: typeof min === "string" ? min : min === null ? null : undefined,
    max_value: typeof max === "string" ? max : max === null ? null : undefined,
    defaults: parseDefaults(pair.body.defaults),
  };
}

export function parseFieldTypeCatalog(text: string): Map<string, FieldType> {
  const data = parseDocument(text).toJS();
  const types = asRecord(data)?.types;
  const out = new Map<string, FieldType>();
  if (!Array.isArray(types)) return out;
  for (const entry of types) {
    const parsed = parseType(entry);
    if (parsed) out.set(parsed.name, parsed);
  }
  return out;
}

const cache = new Map<string, Promise<Map<string, FieldType>>>();

export async function loadFieldTypeCatalog(
  start?: string,
): Promise<Map<string, FieldType>> {
  const key = start ?? "";
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = (async () => {
    const path = await findSpecPath("backend", "types.yaml", start);
    if (!path) {
      throw new Error("field type catalog not found: backend/types.yaml");
    }
    return parseFieldTypeCatalog(await readFile(path, "utf8"));
  })();
  cache.set(key, pending);
  return pending;
}
