// PSML edit reducer — the canonical state machine for the Custom Packet
// Studio. Sibling Round 7 agents (7B/7C) read the action shape declared
// here; do not change it without updating issue #64.
//
// Path scheme
// -----------
// A `Path` is a sequence of (string | number) tokens that addresses a node
// inside a `PsmlPacket`. Paths always descend into the packet body using
// numeric indices and named child slots:
//
//   []                                     → the packet itself
//   [i]                                    → packet.body[i] (Container)
//   [i, 'field']                           → packet.body[i] treated as a Field
//   [i, 'element', 'fields', j]            → Repeat → element.fields[j]
//   [i, 'plaintext', 'fields', j]          → Encrypted → plaintext.fields[j]
//   [i, 'children', j]                     → Group → children[j]
//   [i, 'cases', '<key>', 'fields', j]     → Switch case struct field
//   [i, 'default', 'fields', j]            → Switch default struct field
//
// `add-field`, `delete-field`, `add-container`, etc. address the **slot**
// (the numeric index inside the parent's array). `move-field`'s `from` and
// `to` paths both end on the slot index.
//
// History
// -------
// Every mutating action pushes the pre-action packet onto `history`,
// clears `future`, and caps history at 50 entries (oldest dropped first).
// `undo` moves current → `future` and pops from `history`. `redo` is the
// reverse. Packets are deep-cloned via `structuredClone` on every mutation
// so callers can hold references to historical entries safely.

import type {
  Constraint,
  Container,
  Encrypted,
  Field,
  Group,
  Packet,
  PsmlPacket,
  Repeat,
  Struct,
  Switch,
} from "./types";

/* ------------------------------------------------------------------ *
 * Public types
 * ------------------------------------------------------------------ */

export type Path = (string | number)[];

export type EditAction =
  | { type: "add-field"; at: Path; field: Field }
  | { type: "delete-field"; at: Path }
  | { type: "move-field"; from: Path; to: Path }
  | { type: "update-field"; at: Path; patch: Partial<Field> }
  | {
      type: "wrap-in";
      at: Path;
      kind: "struct" | "group" | "repeat" | "switch" | "encrypted";
    }
  | { type: "add-container"; at: Path; container: Container }
  | { type: "update-container"; at: Path; patch: Record<string, unknown> }
  | { type: "add-constraint"; constraint: Constraint }
  | { type: "update-constraint"; index: number; patch: Partial<Constraint> }
  | { type: "delete-constraint"; index: number }
  | { type: "replace-packet"; packet: PsmlPacket }
  | { type: "undo" }
  | { type: "redo" };

export type EditState = {
  packet: PsmlPacket;
  history: PsmlPacket[];
  future: PsmlPacket[];
};

export const HISTORY_LIMIT = 50;

/* ------------------------------------------------------------------ *
 * Helpers — deep clone + history bookkeeping
 * ------------------------------------------------------------------ */

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Build the new state for a mutating action: push the prior packet onto
 * `history` (capped at HISTORY_LIMIT), clear `future`, and adopt the new
 * packet. The caller passes the *already-cloned* mutated packet.
 */
function commit(state: EditState, next: PsmlPacket): EditState {
  const history = state.history.concat([state.packet]);
  while (history.length > HISTORY_LIMIT) history.shift();
  return { packet: next, history, future: [] };
}

/* ------------------------------------------------------------------ *
 * Path resolution
 * ------------------------------------------------------------------ */

/**
 * Walk a path, returning the parent array and the final index. Throws on
 * a malformed path (no final numeric index) so callers can rely on the
 * tuple shape. Operates on a packet that the caller has already deep-cloned.
 */
function resolveParent(
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
 *   'field'    — return the container itself as a single-element array
 *                (used only by code that wants the Field object; we don't
 *                support descending further so this is treated as a no-op).
 *   'children' — Group.children
 *   'fields'   — Struct.fields (used inside element/plaintext/cases)
 *   'element'  — Repeat.element (returns its `fields` array directly so the
 *                next token may be a numeric index).
 *   'plaintext'— Encrypted.plaintext (same: returns `.fields`).
 *   'cases'    — Switch.cases (the caller must provide the case key next,
 *                followed by 'fields').
 *   'default'  — Switch.default (returns its `.fields`).
 */
function descendNamed(node: Container, slot: string): Container[] {
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
      // node here is a Struct, not a Container. We tolerate that by checking
      // for `.fields`.
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
      // Cast through unknown — the caller must specify 'fields' next.
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
      // Switch case lookup: parent token is 'cases', this token is the key.
      // To support this, the caller writes [..., i, 'cases', key, 'fields', j].
      // We reach here when slot is the case key — but we've lost the context
      // that the parent step was 'cases'. To keep resolution simple, we use
      // a sentinel: callers must write 'cases:<key>' as a single token.
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

function describeKind(node: Container): string {
  if (!node || typeof node !== "object") return String(node);
  if ("kind" in node && node.kind) return String(node.kind);
  return "field";
}

/* ------------------------------------------------------------------ *
 * Wrap helper — wrap a slot in a new container of the requested kind.
 * ------------------------------------------------------------------ */

function wrapNode(
  inner: Container,
  kind: "struct" | "group" | "repeat" | "switch" | "encrypted",
): Container {
  const id = `${describeKind(inner)}_wrap_${Math.random().toString(36).slice(2, 8)}`;
  switch (kind) {
    case "group":
      return { kind: "group", id, children: [inner] };
    case "repeat":
      return {
        kind: "repeat",
        id,
        element: { id: `${id}_struct`, fields: [inner] },
        count: { kind: "lit", value: 1 },
      };
    case "switch":
      return {
        kind: "switch",
        id,
        on: { kind: "lit", value: 0 },
        cases: { "0": { id: `${id}_case`, fields: [inner] } },
      };
    case "encrypted":
      return {
        kind: "encrypted",
        id,
        plaintext: { id: `${id}_pt`, fields: [inner] },
        contextNote: "",
      };
    case "struct":
      // A Struct is not a Container in PSML — we model 'wrap as struct' as a
      // Group containing the inner, which is the closest first-class
      // representation. Sibling agents that need a literal Struct can switch
      // to 'group' which carries the same on-wire semantics.
      return { kind: "group", id, children: [inner] };
  }
}

/* ------------------------------------------------------------------ *
 * Reducer
 * ------------------------------------------------------------------ */

export function makeInitialState(packet: PsmlPacket): EditState {
  return { packet: clone(packet), history: [], future: [] };
}

export function editReducer(state: EditState, action: EditAction): EditState {
  switch (action.type) {
    case "undo": {
      if (state.history.length === 0) return state;
      const history = state.history.slice();
      const prev = history.pop()!;
      const future = state.future.concat([state.packet]);
      return { packet: prev, history, future };
    }
    case "redo": {
      if (state.future.length === 0) return state;
      const future = state.future.slice();
      const next = future.pop()!;
      const history = state.history.concat([state.packet]);
      while (history.length > HISTORY_LIMIT) history.shift();
      return { packet: next, history, future };
    }
    case "replace-packet": {
      return commit(state, clone(action.packet));
    }
    case "add-field": {
      const next = clone(state.packet);
      const { parent, index } = resolveParent(next, action.at);
      parent.splice(index, 0, clone(action.field));
      return commit(state, next);
    }
    case "delete-field": {
      const next = clone(state.packet);
      const { parent, index } = resolveParent(next, action.at);
      parent.splice(index, 1);
      return commit(state, next);
    }
    case "move-field": {
      const next = clone(state.packet);
      const { parent: fromParent, index: fromIdx } = resolveParent(
        next,
        action.from,
      );
      const [moved] = fromParent.splice(fromIdx, 1);
      if (!moved) {
        // No-op if source missing — leave state unchanged.
        return state;
      }
      const { parent: toParent, index: toIdx } = resolveParent(next, action.to);
      toParent.splice(toIdx, 0, moved);
      return commit(state, next);
    }
    case "update-field": {
      const next = clone(state.packet);
      const { parent, index } = resolveParent(next, action.at);
      const existing = parent[index];
      if (!existing) return state;
      parent[index] = { ...(existing as Field), ...action.patch } as Container;
      return commit(state, next);
    }
    case "wrap-in": {
      const next = clone(state.packet);
      const { parent, index } = resolveParent(next, action.at);
      const inner = parent[index];
      if (!inner) return state;
      parent[index] = wrapNode(inner, action.kind);
      return commit(state, next);
    }
    case "add-container": {
      const next = clone(state.packet);
      const { parent, index } = resolveParent(next, action.at);
      parent.splice(index, 0, clone(action.container));
      return commit(state, next);
    }
    case "update-container": {
      const next = clone(state.packet);
      const { parent, index } = resolveParent(next, action.at);
      const existing = parent[index];
      if (!existing) return state;
      parent[index] = { ...existing, ...action.patch } as Container;
      return commit(state, next);
    }
    case "add-constraint": {
      const next = clone(state.packet);
      const list = next.constraints ? next.constraints.slice() : [];
      list.push(clone(action.constraint));
      next.constraints = list;
      return commit(state, next);
    }
    case "update-constraint": {
      const next = clone(state.packet);
      if (!next.constraints || !next.constraints[action.index]) return state;
      const list = next.constraints.slice();
      list[action.index] = { ...list[action.index], ...action.patch };
      next.constraints = list;
      return commit(state, next);
    }
    case "delete-constraint": {
      const next = clone(state.packet);
      if (!next.constraints || !next.constraints[action.index]) return state;
      const list = next.constraints.slice();
      list.splice(action.index, 1);
      next.constraints = list;
      return commit(state, next);
    }
  }
}

// Re-export types so consumers can `import type { PsmlPacket } ...` indirectly.
export type { Packet, PsmlPacket };
