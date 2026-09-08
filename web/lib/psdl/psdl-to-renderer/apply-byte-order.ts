// Stamp the renderer mirror's diagram-driven byteOrder flips back onto the
// PSDL packet that feeds `resolveLayout`, so a flip on a Switch-case- /
// Repeat-element-nested cell actually changes the diagram's `[LE]`/`[BE]`
// marker.
//
// Top-level fields carry their byteOrder on `mirror.fields`, and the diagram
// re-derives from that mirror outside editMode (or from `studioState.packet`
// inside editMode). A NESTED field is only ever a `Cell` — it never reaches
// `mirror.fields` -- so its flip is recorded on `mirror.byteOrderOverrides`
// (keyed by field id) instead. This pass deep-walks the PSDL body (every
// composition primitive: Group / Optional / Switch / Encrypted / Repeat /
// Bounded / Ref) and applies those overrides to the matching `Field`, leaving
// the body's shape otherwise untouched.
//
// A field inside a `ref`-expanded `def` is laid out under a qualified cell id --
// every enclosing RefContainer's `id` prefixes the leaf (`<refId>.<leaf>`, and
// for nested refs `<outerRefId>.<innerRefId>.<leaf>`). The diagram flip is
// recorded on the override map under that qualified id, so the walk threads a
// `prefix` accumulated from each RefContainer's `id`. Stamping a flip onto a
// SHARED def would flip every ref to it, so a ref whose subtree carries a flip
// forks a per-ref clone def (`<def>__<refQualifier>`) and its `ref` node is
// rewritten to point at the clone — mirroring the lift in `merge-instances`.
//
// The walk is shape-preserving: a subtree with no override inside it returns
// the same reference, so the common no-edit case is O(body) with zero churn.

import { isField } from "../utils";
import type { Container, NamedStruct, Packet as PsdlPacket } from "../types";
import type { Packet as RendererPacket } from "../renderer";

type Overrides = Record<string, "BE" | "LE">;

/** Carries the override map plus the source defs and a lazily-populated map of
 *  per-ref def clones. A ref-resolved field's diagram-driven byteOrder flip is
 *  keyed by its QUALIFIED id (`<refId>.<fieldId>`, matching the renderer
 *  mirror's `flattenForMirrorQualified`). Stamping it onto the SHARED def would
 *  flip every ref to that def, so a ref whose subtree carries a flip forks a
 *  clone def (`<def>__<refQualifier>`) and its body `ref` node is rewritten to
 *  point at the clone — exactly like the lift in `merge-instances`. */
type Ctx = {
  overrides: Overrides;
  defs: Record<string, NamedStruct>;
  cloneDefs: Record<string, NamedStruct>;
  /** Def names on the current descent path — guards recursive / cyclic defs. */
  seen: Set<string>;
};

function applyToContainer(c: Container, prefix: string, ctx: Ctx): Container {
  if (isField(c)) {
    const next = ctx.overrides[`${prefix}${c.id}`];
    if (next !== undefined && c.byteOrder !== next) {
      return { ...c, byteOrder: next };
    }
    return c;
  }
  if (c.kind === "group") {
    const children = c.children.map((ch) => applyToContainer(ch, prefix, ctx));
    return children.some((ch, i) => ch !== c.children[i])
      ? { ...c, children }
      : c;
  }
  if (c.kind === "repeat") {
    const fields = c.element.fields.map((f) =>
      applyToContainer(f, prefix, ctx),
    );
    return fields.some((f, i) => f !== c.element.fields[i])
      ? { ...c, element: { ...c.element, fields } }
      : c;
  }
  if (c.kind === "switch") {
    let mutated = false;
    const cases: Record<string, (typeof c.cases)[string]> = {};
    for (const [k, v] of Object.entries(c.cases)) {
      const fields = v.fields.map((f) => applyToContainer(f, prefix, ctx));
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
    const fields = c.plaintext.fields.map((f) =>
      applyToContainer(f, prefix, ctx),
    );
    return fields.some((f, i) => f !== c.plaintext.fields[i])
      ? { ...c, plaintext: { ...c.plaintext, fields } }
      : c;
  }
  if (c.kind === "optional") {
    const container = applyToContainer(c.container, prefix, ctx);
    return container !== c.container ? ({ ...c, container } as typeof c) : c;
  }
  if (c.kind === "bounded") {
    const fields = c.fields.map((f) => applyToContainer(f, prefix, ctx));
    return fields.some((f, i) => f !== c.fields[i]) ? { ...c, fields } : c;
  }
  if (c.kind === "ref") {
    // A ref-resolved field's flip is keyed by `<prefix><refId>.<fieldId>`.
    // Descend the def under that qualifier; if the resolved subtree actually
    // changes, fork a per-ref clone def and point this ref node at it so two
    // refs to one def stamp independently (and the shared def stays intact).
    const def = ctx.defs[c.ref];
    if (!def || ctx.seen.has(c.ref)) return c;
    const childPrefix = `${prefix}${c.id}.`;
    ctx.seen.add(c.ref);
    const fields = def.fields.map((f) => applyToContainer(f, childPrefix, ctx));
    ctx.seen.delete(c.ref);
    if (!fields.some((f, i) => f !== def.fields[i])) return c; // no flip inside
    const suffix =
      childPrefix
        .replace(/\.$/, "")
        .replace(/\./g, "__")
        .replace(/[^A-Za-z0-9_]/g, "_") || c.id;
    const cloneName = `${c.ref}__${suffix}`;
    ctx.cloneDefs[cloneName] = { ...def, id: cloneName, fields };
    return { ...c, ref: cloneName };
  }
  // align carries no nested Field to stamp.
  return c;
}

/** Return a new PSDL packet whose Fields carry the renderer mirror's
 *  diagram-driven byteOrder flips (`mirror.byteOrderOverrides`). When the
 *  mirror has no recorded overrides the input packet is returned unchanged
 *  (same reference), so callers can chain it cheaply in a layout memo. */
export function applyByteOrderOverrides(
  psdl: PsdlPacket,
  mirror: RendererPacket,
): PsdlPacket {
  const overrides = mirror.byteOrderOverrides;
  if (!overrides || Object.keys(overrides).length === 0) return psdl;
  const ctx: Ctx = {
    overrides,
    defs: psdl.defs ?? {},
    cloneDefs: {},
    seen: new Set(),
  };
  const body = psdl.body.map((c) => applyToContainer(c, "", ctx));
  const changed = body.some((c, i) => c !== psdl.body[i]);
  if (!changed) return psdl;
  return Object.keys(ctx.cloneDefs).length > 0
    ? { ...psdl, body, defs: { ...psdl.defs, ...ctx.cloneDefs } }
    : { ...psdl, body };
}
