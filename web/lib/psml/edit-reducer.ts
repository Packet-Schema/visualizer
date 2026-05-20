// PSML edit reducer — the canonical state machine for the Custom Packet
// Studio. The action shape declared here is also the contract for any
// consumer that builds and dispatches `EditAction` values (ContainerRow
// editors, TLV / Chain forms). Treat its discriminated union as part of
// the module's public API — additions go in `EditAction`, removals
// require updating every dispatch site.
//
// Path scheme
// -----------
// A `Path` is a sequence of (string | number) tokens that addresses a node
// inside a `PsmlPacket`. The grammar is defined and walked by
// `path-resolver.ts`'s `resolveParent` / `descendNamed`; the shapes
// recognised there are:
//
//   [i]                                      → packet.body[i] (Container).
//                                              The empty path `[]` is
//                                              reserved for "the packet
//                                              itself", but `resolveParent`
//                                              throws on it — none of the
//                                              mutating actions target the
//                                              packet root directly. Use
//                                              `replace-packet` instead
//                                              when you need to swap the
//                                              whole body.
//   [i, 'field']                             → terminal marker; this path
//                                              token form is a leaf and
//                                              cannot be descended into
//   [i, 'children', j]                       → Group.children[j]
//   [i, 'fields', j]                         → Struct.fields[j] inside a
//                                              Switch case / default arm
//   [i, 'element', j]                        → Repeat.element.fields[j]
//   [i, 'plaintext', j]                      → Encrypted.plaintext.fields[j]
//   [i, 'default', j]                        → Switch.default.fields[j]
//   [i, 'cases:<key>', j]                    → Switch.cases[<key>].fields[j]
//                                              (the colon-separated key
//                                              keeps the path positional
//                                              even when <key> is dynamic)
//
// `add-field`, `delete-field`, `add-container`, etc. address the **slot**
// (the numeric index inside the parent's array). `move-field`'s `from`
// and `to` paths both end on a numeric slot index.
//
// History
// -------
// Every mutating action pushes the pre-action packet onto `history`,
// clears `future`, and caps history at 50 entries (oldest dropped first).
// `undo` moves current → `future` and pops from `history`. `redo` is the
// reverse. Packets are deep-cloned via `structuredClone` on every mutation
// so callers can hold references to historical entries safely.

import type { Constraint, Container, Field, Packet, PsmlPacket } from "./types";
import { describeKind, resolveParent, type Path } from "./path-resolver";
import { isField } from "./utils";

/* ------------------------------------------------------------------ *
 * Public types
 * ------------------------------------------------------------------ */

export type { Path } from "./path-resolver";

/**
 * A targeted patch for any Container variant.
 *
 * We distribute over the `Container` union (`T extends unknown ? ... :
 * never`) so each variant keeps its own non-discriminator fields —
 * `Repeat.count`, `Switch.on`, `Encrypted.wireBits`, etc. — instead of
 * being collapsed into the union's intersection. The `Omit<_, "kind">`
 * strips the discriminator from every arm so the `update-container`
 * reducer case can't be handed a patch that flips `kind` mid-tree
 * (e.g. turning a `repeat` into a `switch`) and corrupt the PSML shape
 * by leaving required variant fields missing. The reducer spreads onto
 * an existing node whose `kind` is already fixed, so excluding it from
 * the patch type is the minimum guard against that corruption path
 * (Copilot review).
 */
type DistributivePartialOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<Partial<T>, K>
  : never;
export type ContainerPatch = DistributivePartialOmit<Container, "kind">;

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
  | { type: "update-container"; at: Path; patch: ContainerPatch }
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
      if (!isField(existing)) {
        // The `update-field` action only patches Field-shape props (name,
        // doc, bits, type, …). Routing it at a Container slot would drop
        // the kind discriminator on spread and silently corrupt the tree.
        throw new Error(
          `update-field expected a Field; got ${describeKind(existing)} at path ${action.at.join("/")}`,
        );
      }
      parent[index] = { ...existing, ...action.patch };
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
    default: {
      // Compile-time exhaustiveness (new EditAction variants fail to
      // assign to `never`); at runtime we fall back to the previous
      // state instead of returning the raw action object, so an
      // untyped dispatch can't replace EditState with a free-form
      // payload and corrupt history.
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}

// Re-export types so consumers can `import type { PsmlPacket } ...` indirectly.
export type { Packet, PsmlPacket };
