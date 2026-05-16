// PSML 0.2 — Packet Schema Markup Language.
// Normalize a PSML Packet into a flat NormalizedField[] that the cell-layout
// algorithm in `web/lib/psml/layout.ts` (and its runtime sibling
// `runtime-resolver.ts`) can consume directly.
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
import type {
  Container,
  Field,
  Group,
  Normalized,
  NormalizedField,
  Packet,
  PacketEnv,
  Repeat,
  Switch,
  Type,
} from "./types";

function isField(c: Container): c is Field {
  // A Field has a `type` property; Repeat/Switch/Group all have a `kind`
  // discriminator. Treat anything without a kind (or kind === 'field') as a
  // Field.
  return !("kind" in c) || c.kind === "field";
}

/** Compute the bit width of a Type given the current env. */
export function typeBits(type: Type, env: PacketEnv): number {
  switch (type.kind) {
    case "int":
    case "enum":
      return type.bits;
    case "bits":
      return type.n;
    case "bytes":
      return evalExpr(type.n, env) * 8;
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
    }
    // Repeat/Switch: skipped intentionally; defaults inside them are seeded
    // when (and if) the element struct is expanded.
  }
}

type WalkState = {
  out: NormalizedField[];
  env: PacketEnv;
  offset: number;
};

function emit(
  state: WalkState,
  field: Field,
  path: string,
  extra: Pick<NormalizedField, "repeatIndex" | "switchCase"> = {},
): void {
  const bits = typeBits(field.type, state.env);
  state.out.push({
    id: extra.repeatIndex !== undefined ? `${field.id}#${extra.repeatIndex}` : field.id,
    name: field.name,
    bits,
    absoluteBitOffset: state.offset,
    originalContainerPath: path,
    category: field.category,
    doc: field.doc,
    ...extra,
  });
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
  }
}

function walkGroup(g: Group, path: string, state: WalkState): void {
  const sub = `${path}/${g.id}`;
  for (const child of g.children) walkContainer(child, sub, state);
}

function walkRepeat(r: Repeat, path: string, state: WalkState): void {
  const sub = `${path}/${r.id}`;
  const count = resolveRepeatCount(r, state);
  for (let i = 0; i < count; i++) {
    const innerPath = `${sub}[${i}]`;
    // Mirror v1's TLV expansion behaviour: each repeat copy gets a synthesised
    // id suffix so the cell layout can still address it by id.
    for (const child of r.element.fields) {
      if (isField(child)) {
        emit(state, child, innerPath, { repeatIndex: i });
      } else {
        walkContainer(child, innerPath, state);
      }
    }
  }
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
 * Normalize a packet against an env. Missing field refs are tolerated where
 * an obvious default exists (defaultValue on a Field), but otherwise will
 * surface as a thrown MissingRefError from `evalExpr`.
 */
export function normalize(packet: Packet, env: PacketEnv = new Map()): Normalized {
  // Defensive: don't mutate caller's env.
  const localEnv: PacketEnv = new Map(env);
  seedDefaults(packet.body, localEnv);

  const state: WalkState = { out: [], env: localEnv, offset: 0 };
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
