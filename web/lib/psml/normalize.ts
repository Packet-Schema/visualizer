// PSML 0.3 — Packet Schema Markup Language.
// Normalize a PSML Packet into a flat NormalizedField[] that the cell-layout
// algorithm in `web/lib/psml/layout.ts` can consume directly.
//
// Walks the Container tree depth-first. Repeat is expanded by evaluating its
// count expression against the current env. Switch is dispatched by the
// value of its `on` expression matched against the case-key string.
//
// Bit-widths come from the field's Type:
//   * int / bits / enum   — fixed bit count.
//   * bytes               — `n` expression, converted bytes → bits.
//
// Default field values are auto-seeded into the env on entry so that
// expressions referencing not-yet-set fields (e.g. an IHL with defaultValue=5
// driving the Options length) evaluate sensibly on a fresh packet.

import { evalExpr } from "./expr";
import { isField } from "./utils";
import type {
  Container,
  Encrypted,
  Field,
  Group,
  Normalized,
  NormalizedField,
  Packet,
  PacketEnv,
  Repeat,
  Struct,
  Switch,
  Type,
  ViewMode,
} from "./types";

/**
 * Compute the bit width of a Type given the current env.
 *
 * Varints have no static width — callers may supply a concrete bit count via
 * the env keyed by the owning field's id, otherwise 0 is returned (the
 * renderer treats the slot as design-time-empty).
 */
/** Synthetic env key prefix for a BER length width override. */
export function berLenEnvKey(fieldId: string): string {
  return `__berLen__${fieldId}`;
}

export function typeBits(type: Type, env: PacketEnv, fieldId?: string): number {
  switch (type.kind) {
    case "int":
    case "enum":
      return type.bits;
    case "bits":
      return type.n;
    case "bytes":
      return evalExpr(type.n, env) * 8;
    case "varint": {
      if (fieldId !== undefined) {
        const v = env.get(fieldId);
        if (v !== undefined) return v;
      }
      return 0;
    }
    case "berLength": {
      // PSML 0.4 — width is dynamic; consult env override under the namespaced
      // key `__berLen__<fieldId>` so the bare fieldId stays available for other
      // uses (e.g. ref expressions). Default to 1 byte (8 bits).
      if (fieldId !== undefined) {
        const v = env.get(berLenEnvKey(fieldId));
        if (v !== undefined) return v;
      }
      return 8;
    }
  }
}

/**
 * Seed `env` with defaultValue for every Field reachable through Group nodes
 * at the top level of a packet body. We do not descend into Repeat/Switch
 * here because their expansion depends on values that might not yet exist —
 * the recursive walk handles that case.
 */
function seedDefaults(containers: Container[], env: PacketEnv): void {
  for (const c of containers) {
    if (isField(c)) {
      if (c.defaultValue !== undefined && !env.has(c.id)) {
        env.set(c.id, c.defaultValue);
      }
    } else if (c.kind === "group") {
      seedDefaults(c.children, env);
    } else if (c.kind === "encrypted") {
      // Plaintext defaults should still seed — they're needed both in
      // semantic mode (when those fields are emitted) and in wire mode (when
      // wireBits is absent and we fall back to summing plaintext bits).
      seedDefaults(c.plaintext.fields, env);
    } else if (c.kind === "optional") {
      // Seed the wrapped field's default so the inner field can be emitted
      // with a sensible value when `when` evaluates truthy.
      if (c.field.defaultValue !== undefined && !env.has(c.field.id)) {
        env.set(c.field.id, c.field.defaultValue);
      }
    }
    // Repeat/Switch: skipped intentionally; defaults inside them are seeded
    // when (and if) the element struct is expanded.
  }
}

type EncryptedFrame = {
  parentId: string;
  contextNote: string;
  headerProtected: Set<string>;
};

type WalkState = {
  out: NormalizedField[];
  env: PacketEnv;
  offset: number;
  viewMode: ViewMode;
  /** Stack of Encrypted containers currently being expanded (semantic mode). */
  encryptedStack: EncryptedFrame[];
  /**
   * Active Repeat index when descending through a Repeat's element. Carried
   * on the state so that nested constructs (Switch / Group / Encrypted) inside
   * a Repeat still tag every emitted field with the parent repetition,
   * producing unique synthesised ids like `type#0`, `type#1`, … Without this
   * the cell layout would emit two fields with the same id, and React's key
   * deduplication would silently drop or duplicate cells.
   */
  repeatIndex?: number;
};

type EmitExtra = Pick<NormalizedField, "repeatIndex" | "switchCase">;

function emit(
  state: WalkState,
  field: Field,
  path: string,
  extra: EmitExtra = {},
): void {
  const bits = typeBits(field.type, state.env, field.id);
  const repeatIndex = extra.repeatIndex ?? state.repeatIndex;
  const nf: NormalizedField = {
    id: repeatIndex !== undefined ? `${field.id}#${repeatIndex}` : field.id,
    name: field.name,
    bits,
    absoluteBitOffset: state.offset,
    originalContainerPath: path,
    category: field.category,
    doc: field.doc,
    ...extra,
    ...(repeatIndex !== undefined ? { repeatIndex } : {}),
  };
  // Apply Encrypted-parent tagging in semantic mode. We use the innermost
  // frame for parentId/contextNote (matches the nearest-encrypted ancestor),
  // but headerProtected matches if ANY ancestor lists the source field id.
  if (state.encryptedStack.length > 0) {
    const top = state.encryptedStack[state.encryptedStack.length - 1];
    nf.encryptedParentId = top.parentId;
    nf.encryptedContextNote = top.contextNote;
    for (const frame of state.encryptedStack) {
      if (frame.headerProtected.has(field.id)) {
        nf.headerProtected = true;
        break;
      }
    }
  }
  if (field.byteOrder) nf.byteOrder = field.byteOrder;
  state.out.push(nf);
  state.offset += bits;
}

function walkContainer(c: Container, path: string, state: WalkState): void {
  if (isField(c)) {
    emit(state, c, path);
    return;
  }
  switch (c.kind) {
    case "group": {
      walkGroup(c, path, state);
      return;
    }
    case "repeat": {
      walkRepeat(c, path, state);
      return;
    }
    case "switch": {
      walkSwitch(c, path, state);
      return;
    }
    case "encrypted": {
      walkEncrypted(c, path, state);
      return;
    }
    case "optional": {
      // PSML 0.4 — emit inner field iff `when` evaluates truthy in env. A
      // missing ref in the predicate is treated as "absent" (the safer
      // documentation-time default), matching the rfc-ascii adapter.
      let test = 0;
      try {
        test = evalExpr(c.when, state.env);
      } catch {
        test = 0;
      }
      if (test !== 0) {
        emit(state, c.field, path);
      }
      return;
    }
  }
}

function walkGroup(g: Group, path: string, state: WalkState): void {
  const sub = `${path}/${g.id}`;
  for (const child of g.children) walkContainer(child, sub, state);
}

function walkRepeat(r: Repeat, path: string, state: WalkState): void {
  const sub = `${path}/${r.id}`;
  const count = resolveRepeatCount(r, state);
  const prevRepeatIndex = state.repeatIndex;
  for (let i = 0; i < count; i++) {
    const innerPath = `${sub}[${i}]`;
    // Tag the active repeat index on the walk state so any nested Switch /
    // Group / Encrypted that emits fields inherits the suffix, not just the
    // direct Field children handled in this loop.
    state.repeatIndex = i;
    for (const child of r.element.fields) {
      if (isField(child)) {
        emit(state, child, innerPath, { repeatIndex: i });
      } else {
        walkContainer(child, innerPath, state);
      }
    }
  }
  state.repeatIndex = prevRepeatIndex;
}

function resolveRepeatCount(r: Repeat, state: WalkState): number {
  if (r.count === "eos") {
    // Without a known parent extent, treat `eos` as 0 — caller can override
    // by attaching a count to the env keyed by the repeat id.
    const v = state.env.get(r.id);
    return v ?? 0;
  }
  if (typeof r.count === "object" && "until" in r.count) {
    // Predicate-based termination is not safe to expand offline (we'd need a
    // payload to scan). The env may provide an explicit count keyed by r.id.
    const v = state.env.get(r.id);
    return v ?? 0;
  }
  // Expression count.
  return Math.max(0, Math.trunc(evalExpr(r.count, state.env)));
}

function walkSwitch(s: Switch, path: string, state: WalkState): void {
  const sub = `${path}/${s.id}`;
  const disc = evalExpr(s.on, state.env);
  const key = String(disc);
  const chosen = s.cases[key] ?? s.default;
  if (!chosen) return;
  for (const child of chosen.fields) {
    if (isField(child)) {
      emit(state, child, sub, { switchCase: key });
    } else {
      walkContainer(child, sub, state);
    }
  }
}

/**
 * Walk an Encrypted container.
 *
 *   * wire mode     — emit ONE virtual NormalizedField with `bits` equal to
 *                     the evaluated `wireBits` if provided, else the sum of
 *                     the plaintext's bit width (also computed via a wire-
 *                     mode pass so any nested Encrypted collapses too).
 *   * semantic mode — recurse into `plaintext.fields`, pushing an
 *                     EncryptedFrame so each emitted leaf gets
 *                     `encryptedParentId` / `encryptedContextNote` / (when
 *                     listed) `headerProtected`.
 */
function walkEncrypted(e: Encrypted, path: string, state: WalkState): void {
  const sub = `${path}/${e.id}`;
  if (state.viewMode === "wire") {
    const bits =
      e.wireBits !== undefined
        ? Math.max(0, Math.trunc(evalExpr(e.wireBits, state.env)))
        : sumPlaintextBits(e.plaintext, state.env);
    const nf: NormalizedField = {
      id: e.id,
      name: e.name ?? e.id,
      bits,
      absoluteBitOffset: state.offset,
      originalContainerPath: sub,
      category: e.category,
      doc: e.doc,
      encrypted: true,
      encryptedContextNote: e.contextNote,
    };
    // Nested Encrypted: a wire-mode child of a semantic-mode parent still
    // carries the parent's encryptedParentId so the renderer knows it sits
    // inside an outer decrypted region.
    if (state.encryptedStack.length > 0) {
      const top = state.encryptedStack[state.encryptedStack.length - 1];
      nf.encryptedParentId = top.parentId;
    }
    state.out.push(nf);
    state.offset += bits;
    return;
  }
  // semantic mode — recurse into plaintext.
  const frame: EncryptedFrame = {
    parentId: e.id,
    contextNote: e.contextNote,
    headerProtected: new Set(e.headerProtected ?? []),
  };
  state.encryptedStack.push(frame);
  try {
    for (const child of e.plaintext.fields) {
      walkContainer(child, sub, state);
    }
  } finally {
    state.encryptedStack.pop();
  }
}

/**
 * Sum the bit widths of a plaintext Struct as if we were emitting it in wire
 * mode (so nested Encrypted collapses to its wireBits). Used to back-fill the
 * size of an Encrypted with no explicit wireBits.
 */
function sumPlaintextBits(plaintext: Struct, env: PacketEnv): number {
  const tmp: WalkState = {
    out: [],
    env,
    offset: 0,
    viewMode: "wire",
    encryptedStack: [],
  };
  for (const child of plaintext.fields) {
    walkContainer(child, plaintext.id, tmp);
  }
  return tmp.offset;
}

/** Optional knobs accepted by `normalize`. */
export type NormalizeOptions = {
  viewMode?: ViewMode;
};

/**
 * Normalize a packet against an env. Missing field refs are tolerated where
 * an obvious default exists (defaultValue on a Field), but otherwise will
 * surface as a thrown MissingRefError from `evalExpr`.
 *
 * `opts.viewMode` controls how Encrypted containers are emitted:
 *   * `'wire'` (default) — collapse each Encrypted into one opaque field;
 *   * `'semantic'`       — expand the plaintext substructure with parent
 *                          tagging so the renderer can decorate.
 */
export function normalize(
  packet: Packet,
  env: PacketEnv = new Map(),
  opts: NormalizeOptions = {},
): Normalized {
  // Defensive: don't mutate caller's env.
  const localEnv: PacketEnv = new Map(env);
  seedDefaults(packet.body, localEnv);

  const state: WalkState = {
    out: [],
    env: localEnv,
    offset: 0,
    viewMode: opts.viewMode ?? "wire",
    encryptedStack: [],
  };
  for (const c of packet.body) {
    walkContainer(c, packet.name, state);
  }
  return { fields: state.out, totalBits: state.offset };
}

/** Build a fresh env from a packet's default values (top-level only). */
export function initialEnv(packet: Packet): PacketEnv {
  const env: PacketEnv = new Map();
  seedDefaults(packet.body, env);
  return env;
}
