// Path resolution for the edit-reducer.
//
// A `Path` is a sequence of (string | number) tokens that addresses a slot
// inside a PSML Packet body. See `edit-reducer.ts` for the slot grammar.
// Resolving a path returns the parent array and the final numeric index;
// the reducer then performs splice/replace operations against the parent.
//
// Both functions operate on a packet that the caller has already
// deep-cloned. They throw on a malformed path so the reducer can fail
// fast.

import type {
  Container,
  Encrypted,
  Group,
  PsmlPacket,
  Repeat,
  Struct,
  Switch,
} from "./types";

export type Path = (string | number)[];

export function describeKind(node: Container): string {
  if (!node || typeof node !== "object") return String(node);
  if ("kind" in node && node.kind) return String(node.kind);
  return "field";
}

/**
 * Walk a path, returning the parent array and the final index.
 *
 * Throws on a malformed path (no final numeric index) so callers can rely
 * on the tuple shape. Operates on a packet that the caller has already
 * deep-cloned.
 */
export function resolveParent(
  packet: PsmlPacket,
  path: Path,
): { parent: Container[]; index: number } {
  if (path.length === 0) {
    throw new Error("path must address a slot inside the packet body");
  }
  const last = path[path.length - 1];
  if (typeof last !== "number") {
    throw new Error(
      `path must end with a numeric slot index; got ${String(last)}`,
    );
  }
  const head = path.slice(0, -1);
  let parent: Container[] = packet.body;
  for (let i = 0; i < head.length; i++) {
    const token = head[i];
    if (typeof token === "number") {
      const node = parent[token];
      if (node === undefined) {
        throw new Error(`path token ${i} (${token}) is out of range`);
      }
      // Numeric token alone means "step *into* this container's primary
      // child array". We only descend if the *next* token is a string slot
      // name, otherwise this number is the final slot index handled above.
      const nextToken = head[i + 1];
      if (typeof nextToken !== "string") {
        throw new Error(
          `path token ${i + 1} must be a slot name (e.g. 'fields', 'children')`,
        );
      }
      i += 1; // consume the slot name
      parent = descendNamed(node, nextToken);
    } else {
      throw new Error(
        `path expects (index, slot-name) pairs; got string ${token} at position ${i}`,
      );
    }
  }
  return { parent, index: last };
}

/**
 * Step into a container's named child array. Recognized slot names:
 *   'field'    — terminal marker; cannot be descended into.
 *   'children' — Group.children
 *   'fields'   — Struct.fields (used inside element/plaintext/cases)
 *   'element'  — Repeat.element (returns its `fields` array directly so the
 *                next token may be a numeric index).
 *   'plaintext'— Encrypted.plaintext (same: returns `.fields`).
 *   'cases:<key>' — Switch.cases[key] (encoded as a single token so the
 *                   reducer's path stays positional).
 *   'default'  — Switch.default (returns its `.fields`).
 */
export function descendNamed(node: Container, slot: string): Container[] {
  switch (slot) {
    case "field":
      throw new Error(
        "'field' is a terminal marker and cannot be descended into",
      );
    case "children": {
      const group = node as Group;
      if (group.kind !== "group") {
        throw new Error(`expected group at path; got ${describeKind(node)}`);
      }
      return group.children;
    }
    case "fields": {
      const s = node as unknown as Struct;
      if (!Array.isArray(s.fields)) {
        throw new Error("expected struct with 'fields' array");
      }
      return s.fields;
    }
    case "element": {
      const r = node as Repeat;
      if (r.kind !== "repeat") {
        throw new Error(`expected repeat at path; got ${describeKind(node)}`);
      }
      return r.element as unknown as Container[];
    }
    case "plaintext": {
      const e = node as Encrypted;
      if (e.kind !== "encrypted") {
        throw new Error(
          `expected encrypted at path; got ${describeKind(node)}`,
        );
      }
      return e.plaintext as unknown as Container[];
    }
    case "default": {
      const sw = node as Switch;
      if (sw.kind !== "switch" || !sw.default) {
        throw new Error("expected switch with a default case at path");
      }
      return sw.default as unknown as Container[];
    }
    default: {
      if (slot.startsWith("cases:")) {
        const sw = node as Switch;
        if (sw.kind !== "switch") {
          throw new Error(`expected switch at path; got ${describeKind(node)}`);
        }
        const key = slot.slice("cases:".length);
        const variant = sw.cases[key];
        if (!variant) {
          throw new Error(`switch has no case with key ${key}`);
        }
        return variant as unknown as Container[];
      }
      throw new Error(`unknown path slot name: ${slot}`);
    }
  }
}
