import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { asRecord, parseYamlWithPositions, positionFor } from "./yamlPositions.ts";
import type { ParsedYaml } from "./SpecValidator.ts";
import type {
  SpecValidationError,
  SpecValidationResult,
  ValidateOptions,
} from "./types.ts";

export function withIncludeFilePath(
  path: string,
  options?: ValidateOptions,
): ValidateOptions {
  return {
    ...options,
    includeFilePath: options?.includeFilePath ?? path,
    includeBasePath: options?.includeBasePath ?? dirname(path),
  };
}

function err(
  parsed: ParsedYaml,
  instancePath: string,
  message: string,
): SpecValidationError {
  const { line, col } = positionFor(parsed.doc, parsed.lineCounter, instancePath);
  return { line, col, instancePath, message };
}

function displayPath(absPath: string, rootDir: string): string {
  return relative(rootDir, absPath);
}

async function resolvedId(path: string): Promise<string> {
  const abs = resolve(path);
  try {
    return await realpath(abs);
  } catch {
    try {
      return join(await realpath(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }
}

type FileInclude = { index: number; file: string };

function fileIncludes(data: unknown): FileInclude[] {
  const includes = asRecord(data)?.includes;
  if (!Array.isArray(includes)) return [];
  const out: FileInclude[] = [];
  for (const [index, entry] of includes.entries()) {
    const rec = asRecord(entry);
    if (typeof rec?.file !== "string" || rec.file.length === 0) continue;
    out.push({ index, file: rec.file });
  }
  return out;
}

async function loadChild(
  path: string,
): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    const shown = basename(path);
    if (asRecord(e)?.code === "ENOENT") {
      return { ok: false, message: `include file not found: ${shown}` };
    }
    return { ok: false, message: `cannot read include ${shown}: ${String(e)}` };
  }
  const { doc } = parseYamlWithPositions(text);
  if (doc.errors.length > 0) {
    return {
      ok: false,
      message: `include is not valid YAML: ${doc.errors[0]!.message}`,
    };
  }
  const data = doc.toJS();
  if (!asRecord(data) || Array.isArray(data)) {
    return { ok: false, message: `include must be a mapping: ${basename(path)}` };
  }
  return { ok: true, data };
}

/**
 * Walk `file:` includes from a types/datasource/routes/services document and report cycles,
 * missing files, and unreadable / non-mapping targets. Remote includes
 * (`id` / `uuid` / `user_id`+`name`) are skipped — they cannot be followed
 * without a resolver. No-ops when neither `includeFilePath` nor
 * `includeBasePath` is set (in-memory `validate()` stays schema-only).
 */
export async function checkIncludeCycles(
  parsed: ParsedYaml,
  options?: ValidateOptions,
): Promise<SpecValidationResult> {
  const rootPath = options?.includeFilePath
    ? resolve(options.includeFilePath)
    : options?.includeBasePath
      ? resolve(options.includeBasePath, "types.yaml")
      : null;
  if (!rootPath) return { valid: true, errors: [] };

  const rootId = await resolvedId(rootPath);
  const rootDir = dirname(rootId);
  const errors: SpecValidationError[] = [];
  const stack: string[] = [];
  const done = new Set<string>();

  const walk = async (path: string, rootIncludeIndex: number): Promise<void> => {
    const id = await resolvedId(path);
    const instancePath = `/includes/${rootIncludeIndex}/file`;
    if (stack.includes(id)) {
      const cycle = [...stack, id].map((p) => displayPath(p, rootDir));
      errors.push(
        err(parsed, instancePath, `circular include: ${cycle.join(" → ")}`),
      );
      return;
    }
    if (done.has(id)) return;

    const loaded = await loadChild(path);
    if (!loaded.ok) {
      errors.push(err(parsed, instancePath, loaded.message));
      return;
    }

    stack.push(id);
    for (const inc of fileIncludes(loaded.data)) {
      await walk(resolve(dirname(path), inc.file), rootIncludeIndex);
    }
    stack.pop();
    done.add(id);
  };

  stack.push(rootId);
  for (const inc of fileIncludes(parsed.data)) {
    await walk(resolve(dirname(rootPath), inc.file), inc.index);
  }
  stack.pop();
  done.add(rootId);
  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}
