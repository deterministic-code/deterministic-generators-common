import {
  parseDocument,
  LineCounter,
  isMap,
  isSeq,
  isScalar,
  isPair,
} from "yaml";
import type { Document } from "yaml";
import type { Position } from "./types.ts";

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function parseYamlWithPositions(yamlText: string): {
  doc: Document;
  lineCounter: LineCounter;
} {
  const lineCounter = new LineCounter();
  const doc = parseDocument(yamlText, { lineCounter, keepSourceTokens: true });
  return { doc, lineCounter };
}

export function parseJsonPointer(pointer: string): string[] {
  if (!pointer || pointer === "") return [];
  return pointer
    .split("/")
    .slice(1)
    .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function nodeAtPath(doc: Document, segments: string[]): unknown {
  let node: unknown = doc.contents;
  for (const seg of segments) {
    if (node == null) return null;
    if (isMap(node)) {
      const pair = node.items.find((p) => {
        const key = isScalar(p.key) ? p.key.value : p.key;
        return String(key) === seg;
      });
      if (!pair) return node;
      node = pair.value;
    } else if (isSeq(node)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= node.items.length)
        return node;
      node = node.items[idx];
    } else {
      return node;
    }
  }
  return node;
}

function rangeOfNode(node: unknown): readonly number[] | null {
  if (node == null) return null;
  const ranged = (v: unknown): readonly number[] | null =>
    (asRecord(v)?.range as readonly number[] | undefined) ?? null;
  if (isPair(node)) return ranged(node.key) ?? ranged(node.value);
  return ranged(node);
}

export function positionFor(
  doc: Document,
  lineCounter: LineCounter,
  instancePath: string,
): Position {
  const segments = parseJsonPointer(instancePath);
  const node = nodeAtPath(doc, segments);
  const range = rangeOfNode(node);
  const offset = range ? range[0] : 0;
  const { line, col } = lineCounter.linePos(offset);
  return { line, col };
}
