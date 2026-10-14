import { access } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

const SPEC_REPO = "deterministic-specifications";

/**
 * Walk ancestor directories of `start` (default: this module) for the first
 * `<ancestor>/<relPath>` that exists. Also checks a sibling
 * `deterministic-specifications/<relPath>` so this package can *read* live
 * specs and samples when it sits next to that repo. Never use this path to
 * write into the specifications repo.
 */
export async function findAncestorPath(
  relPath: string,
  start?: string,
): Promise<string | null> {
  let current = start ?? dirname(fileURLToPath(import.meta.url));
  const { root } = parse(current);
  for (;;) {
    const candidate = join(current, relPath);
    if (await fileExists(candidate)) return candidate;
    const sibling = join(current, SPEC_REPO, relPath);
    if (await fileExists(sibling)) return sibling;
    if (current === root) return null;
    current = dirname(current);
  }
}

export function specRelPath(subdir: string, name: string): string {
  return join(subdir, name);
}

/** Locate a live spec YAML by walking ancestors (and a sibling specs repo). */
export async function findSpecPath(
  subdir: string,
  name: string,
  start?: string,
): Promise<string | null> {
  return findAncestorPath(join(subdir, name), start);
}

export async function resolveSpecPath(
  subdir: string,
  name: string,
  start?: string,
): Promise<string> {
  const found = await findSpecPath(subdir, name, start);
  if (found !== null) return found;
  throw new Error(`spec file not found: ${specRelPath(subdir, name)}`);
}
