// Layout-level static-count ceiling.
//
// PacketViewer's product-aware freeze guard (`buildLayoutEnv`) only clamps
// counts that flow through an OVERRIDE surface — a freeRepeat's `env[countKey]`,
// a boundedRepeat's budget-derived count, a direct `bytes(ref X)` length, or the
// remaining-bytes seed. None of those see a PLAIN `repeat{ count: <literal> }`
// whose count is a fixed numeric literal (not a ref, so `psdlToRenderer` never
// surfaces it as a freeRepeat) or a single fixed-size `bytes(<literal>)` field.
// Those literals are baked into the PSDL AST and passed STRAIGHT to
// `resolveLayout`, which expands ~1 SVG cell per record / per byte into the
// un-virtualized StaticDiagram / HybridDiagram (every cell `.map`ped to DOM).
// A perfectly valid user-supplied PSDL with `count: 50000` (or `bytes(50000)`)
// therefore resolves to ~50000 cells and freezes / OOM-crashes the page — a
// reachable freeze for legal authoring that violates the part-2 bar ("ANY
// user-supplied PSDL ... renders correctly ... no frozen diagrams").
//
// This pass rewrites the PSDL body (shape-preserving — an untouched subtree
// returns the same reference) so a STATIC literal record count or fixed byte
// size can never exceed the SAME ceiling the override paths already enforce
// (`MAX_DERIVED_RECORDS`). It is layout-env-only: it runs on the PSDL clone fed
// to `resolveLayout`, never on the source the user edits / exports — so the
// authored `count: 50000` round-trips losslessly; only the rendered cell count
// is bounded.
//
// Only LITERAL counts/sizes are touched. A ref-/expr-driven count is already
// bounded by the override guard (its surfaced `env[countKey]`); rewriting it
// here would double-clamp and fight that surface. A `bytes(ref X)` /
// delimited / remaining / varint size is dynamic and handled elsewhere.

import { isField } from "./utils";
import type { Container, NamedStruct, Packet as PsdlPacket } from "./types";

/** Recursion guard for cyclic `ref` defs; mirrors apply-byte-order's `seen`. */
type Ctx = {
  defs: Record<string, NamedStruct>;
  seen: Set<string>;
  /** Per-record cell ceiling for a fixed-size `bytes`/`bits` field. */
  cap: number;
};

/** True when `n` is a plain numeric literal expression (`{kind:'lit', value}`),
 *  not a ref / op / delimited / remaining form. */
function litValue(n: unknown): number | null {
  if (
    n !== null &&
    typeof n === "object" &&
    (n as { kind?: unknown }).kind === "lit" &&
    typeof (n as { value?: unknown }).value === "number"
  ) {
    return (n as { value: number }).value;
  }
  return null;
}

function clampContainer(c: Container, ctx: Ctx): Container {
  if (isField(c)) {
    // A fixed-size `bytes(<literal>)` field emits ~1 cell per byte; a `bits`
    // field with a huge literal `n` (bytes = ceil(n/8)) the same. Clamp the
    // literal byte/bit count so a lone `bytes(50000)` can't flood the diagram.
    // Only literal sizes — `bytes(ref X)` / delimited / remaining are dynamic
    // and bounded by the env guard, not here.
    const t = c.type;
    if (t.kind === "bytes") {
      const v = litValue(t.n);
      if (v !== null && v > ctx.cap) {
        return { ...c, type: { ...t, n: { kind: "lit", value: ctx.cap } } };
      }
      return c;
    }
    if (t.kind === "bits") {
      // bits `n` is a raw number (not an Expr). Clamp to cap BITS-worth of
      // bytes so the rendered cell count matches the bytes-field ceiling.
      const capBits = ctx.cap * 8;
      if (typeof t.n === "number" && t.n > capBits) {
        return { ...c, type: { ...t, n: capBits } };
      }
      return c;
    }
    return c;
  }
  if (c.kind === "group") {
    const children = c.children.map((ch) => clampContainer(ch, ctx));
    return children.some((ch, i) => ch !== c.children[i])
      ? { ...c, children }
      : c;
  }
  if (c.kind === "repeat") {
    // Clamp a fixed LITERAL count. A `count: <ref>` / `eos` / `until` is driven
    // by an override surface (freeRepeat / boundedRepeat) that the env guard
    // already caps — leave it untouched so we never double-clamp or fight it.
    let next = c;
    const v = litValue(c.count);
    if (v !== null && v > ctx.cap) {
      next = { ...next, count: { kind: "lit", value: ctx.cap } };
    }
    const fields = next.element.fields.map((f) => clampContainer(f, ctx));
    if (fields.some((f, i) => f !== next.element.fields[i])) {
      next = { ...next, element: { ...next.element, fields } };
    }
    return next;
  }
  if (c.kind === "switch") {
    let mutated = false;
    const cases: Record<string, (typeof c.cases)[string]> = {};
    for (const [k, v] of Object.entries(c.cases)) {
      const fields = v.fields.map((f) => clampContainer(f, ctx));
      if (fields.some((f, i) => f !== v.fields[i])) {
        mutated = true;
        cases[k] = { ...v, fields };
      } else {
        cases[k] = v;
      }
    }
    return mutated ? { ...c, cases } : c;
  }
  if (c.kind === "encrypted") {
    const fields = c.plaintext.fields.map((f) => clampContainer(f, ctx));
    return fields.some((f, i) => f !== c.plaintext.fields[i])
      ? { ...c, plaintext: { ...c.plaintext, fields } }
      : c;
  }
  if (c.kind === "optional") {
    const container = clampContainer(c.container, ctx);
    return container !== c.container ? ({ ...c, container } as typeof c) : c;
  }
  if (c.kind === "bounded") {
    const fields = c.fields.map((f) => clampContainer(f, ctx));
    return fields.some((f, i) => f !== c.fields[i]) ? { ...c, fields } : c;
  }
  if (c.kind === "ref") {
    const def = ctx.defs[c.ref];
    if (!def || ctx.seen.has(c.ref)) return c;
    ctx.seen.add(c.ref);
    const fields = def.fields.map((f) => clampContainer(f, ctx));
    ctx.seen.delete(c.ref);
    if (!fields.some((f, i) => f !== def.fields[i])) return c;
    // A clamped subtree inside a shared def forks a per-ref clone so other refs
    // to the same def are untouched (mirrors apply-byte-order's clone fork).
    const cloneName = `${c.ref}__clamp_${c.id}`;
    ctx.defs[cloneName] = { ...def, id: cloneName, fields };
    return { ...c, ref: cloneName };
  }
  // align carries no nested size / count.
  return c;
}

/** Return a PSDL packet whose plain LITERAL repeat counts and fixed-size
 *  `bytes`/`bits` literals are clamped to `cap`, so a static authoring choice
 *  (`count: 50000`, `bytes(50000)`) cannot exceed the same record/cell ceiling
 *  the OVERRIDE freeze guard enforces, and the un-virtualized diagram never
 *  freezes. Shape-preserving: when nothing exceeds `cap` the input packet is
 *  returned unchanged (same reference), so callers can chain it cheaply in a
 *  layout memo. Layout-only — never mutate the source the user edits/exports. */
export function clampStaticLayoutCounts(
  psdl: PsdlPacket,
  cap: number,
): PsdlPacket {
  const ctx: Ctx = {
    // Mutated in place as ref clones are forked; seed from the source defs.
    defs: { ...(psdl.defs ?? {}) },
    seen: new Set(),
    cap,
  };
  const body = psdl.body.map((c) => clampContainer(c, ctx));
  const changed = body.some((c, i) => c !== psdl.body[i]);
  if (!changed) return psdl;
  return { ...psdl, body, defs: ctx.defs };
}
