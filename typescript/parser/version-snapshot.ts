import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { YamlMap, YamlValue } from "./yaml-node.ts";

const versionDir = /^version-\d{8}T\d{6}Z-\d{3}$/;
const own = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

export class VersionSnapshot {
  readonly documents: Readonly<Record<string, YamlValue | undefined>>;

  private constructor(diffsInOrder: Array<YamlValue | null | undefined>) {
    const docs: Record<string, YamlValue | undefined> = {};
    for (const diff of diffsInOrder) {
      if (diff == null) continue;
      if (!this.isMap(diff)) throw new Error("expected a mapping");
      for (const [path, envelope] of Object.entries(diff)) {
        const next = this.applyFile(docs[path], envelope);
        if (this.isNull(next)) delete docs[path];
        else docs[path] = next;
      }
    }
    this.documents = docs;
  }

  static combine(diffsInOrder: Array<YamlValue | null | undefined>): VersionSnapshot {
    return new VersionSnapshot(diffsInOrder);
  }

  static async read(deterministicRoot: string): Promise<VersionSnapshot> {
    const names = (await readdir(deterministicRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && versionDir.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const snapshot = new VersionSnapshot([]);
    return VersionSnapshot.combine(await Promise.all(names.map((name) => snapshot.diffOf(deterministicRoot, name))));
  }

  yaml(path: string): string {
    if (!own(this.documents, path)) throw new Error(`missing ${path}`);
    return stringify(this.documents[path]);
  }

  private async diffOf(root: string, name: string): Promise<YamlValue | undefined> {
    let text: string;
    try {
      text = await readFile(join(root, name, "diff.yaml"), "utf8");
    } catch {
      return undefined;
    }
    if (text === "") return undefined;
    let rootValue: YamlValue;
    try {
      rootValue = parse(text) as YamlValue;
    } catch (error) {
      throw new Error(`${name}/diff.yaml: ${String(error)}`);
    }
    if (!this.isMap(rootValue)) throw new Error(`${name}/diff.yaml: expected a mapping`);
    return rootValue;
  }

  private applyFile(before: YamlValue | undefined, envelope: YamlValue | undefined): YamlValue | undefined {
    if (this.isNull(envelope)) return before;
    if (this.isMap(envelope) && this.isTrue(envelope, "removed") && Object.keys(envelope).length === 1)
      return undefined;
    if (this.isMap(envelope) && this.isTrue(envelope, "added")) return envelope.content;
    return this.apply(before, envelope);
  }

  private apply(before: YamlValue | undefined, next: YamlValue | undefined): YamlValue | undefined {
    if (this.isNull(next)) return before;
    if (this.isKeyed(before) && this.isMap(next) && this.isSplit(next)) return this.applyKeyed(before, next);
    if (this.isMap(before) && this.isMap(next)) return this.applyObject(before, next);
    return next;
  }

  private applyKeyed(beforeVal: YamlMap[], split: YamlMap): YamlValue {
    const removed = new Set(this.strings(split, "removed"));
    const changed = new Map(
      this.seq(split.changed).flatMap((entry) => {
        const pair = this.firstPair(entry);
        return pair ? [[pair.key, pair.value] as const] : [];
      }),
    );
    return [
      ...this.seq(split.added),
      ...beforeVal.flatMap((entry) => {
        const pair = this.firstPair(entry);
        if (!pair || removed.has(pair.key)) return [];
        return [
          changed.has(pair.key)
            ? { [pair.key]: this.apply(pair.value, changed.get(pair.key)) as YamlValue }
            : entry,
        ];
      }),
    ];
  }

  private applyObject(beforeVal: YamlMap, next: YamlMap): YamlMap {
    const removed = new Set(this.strings(next, "removed"));
    const output: Record<string, YamlValue> = {};
    for (const [key, value] of Object.entries(beforeVal)) {
      if (removed.has(key)) continue;
      output[key] = (own(next, key) ? this.apply(value, next[key]) : value) as YamlValue;
    }
    for (const [key, value] of Object.entries(next)) {
      if (key === "removed" && Array.isArray(value)) continue;
      if (!own(beforeVal, key)) output[key] = value;
    }
    return output;
  }

  private isSplit(map: YamlMap) {
    return Object.keys(map).every((key) => key === "added" || key === "changed" || key === "removed");
  }

  private isKeyed(value: YamlValue | undefined): value is YamlMap[] {
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((item) => this.isMap(item) && Object.keys(item).length === 1)
    );
  }

  private seq(value: YamlValue | undefined): YamlValue[] {
    return Array.isArray(value) ? value : [];
  }

  private strings(map: YamlMap, key: string) {
    return this.seq(map[key]).map((item) => (this.isScalar(item) ? String(item ?? "") : ""));
  }

  private firstPair(entry: YamlValue | undefined) {
    if (!this.isMap(entry)) return undefined;
    const key = Object.keys(entry)[0];
    return key === undefined ? undefined : { key, value: entry[key] };
  }

  private isMap(value: YamlValue | undefined | null): value is YamlMap {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private isTrue(map: YamlMap, key: string) {
    return map[key] === true || map[key] === "true" || map[key] === "True";
  }

  private isNull(value: YamlValue | undefined | null) {
    return value == null;
  }

  private isScalar(value: YamlValue | undefined) {
    return value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
  }
}
