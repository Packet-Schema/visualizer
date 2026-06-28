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
// `prefix` accumulated from each RefContainer's `id` and resolves the def out
// of `psdl.defs`, writing any merged def back (shape-preserving) so the diagram
// re-derives the flipped marker.
//
// The walk is shape-preserving: a subtree with no override inside it returns
// the same reference, so the common no-edit case is O(body) with zero churn.

import { isField } from "../utils";
import type { Container, NamedStruct, Packet as PsdlPacket } from "../types";
import type { Packet as RendererPacket } from "../renderer";

type Overrides = Record<string, "BE" | "LE">;

type WalkCtx = {
  overrides: Overrides;
  defs: Record<string, NamedStruct>;
  outDefs: Record<string, NamedStruct>;
  seenRefs: Set<string>;
};

function applyToContainer(
  c: Container,
  ctx: WalkCtx,
  prefix: string,
): Container {
  if (isField(c)) {
    const next = ctx.overrides[prefix + c.id];
    if (next !== undefined && c.byteOrder !== next) {
      return { ...c, byteOrder: next };
    }
    return c;
  }
  if (c.kind === "group") {
    const children = c.children.map((ch) => applyToContainer(ch, ctx, prefix));
    return children.some((ch, i) => ch !== c.children[i])
      ? { ...c, children }
      : c;
  }
  if (c.kind === "repeat") {
    const fields = c.element.fields.map((f) =>
      applyToContainer(f, ctx, prefix),
    );
    return fields.some((f, i) => f !== c.element.fields[i])
      ? { ...c, element: { ...c.element, fields } }
      : c;
  }
  if (c.kind === "switch") {
    let mutated = false;
    const cases: Record<string, (typeof c.cases)[string]> = {};
    for (const [k, v] of Object.entries(c.cases)) {
      const fields = v.fields.map((f) => applyToContainer(f, ctx, prefix));
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
      applyToContainer(f, ctx, prefix),
    );
    return fields.some((f, i) => f !== c.plaintext.fields[i])
      ? { ...c, plaintext: { ...c.plaintext, fields } }
      : c;
  }
  if (c.kind === "optional") {
    const container = applyToContainer(c.container, ctx, prefix);
    return container !== c.container ? ({ ...c, container } as typeof c) : c;
  }
  if (c.kind === "bounded") {
    const fields = c.fields.map((f) => applyToContainer(f, ctx, prefix));
    return fields.some((f, i) => f !== c.fields[i]) ? { ...c, fields } : c;
  }
  if (c.kind === "ref") {
    const def = ctx.defs[c.ref];
    if (def && !ctx.seenRefs.has(c.ref)) {
      ctx.seenRefs.add(c.ref);
      const childPrefix = `${prefix}${c.id}.`;
      const fields = def.fields.map((f) =>
        applyToContainer(f, ctx, childPrefix),
      );
      ctx.seenRefs.delete(c.ref);
      if (fields.some((f, i) => f !== def.fields[i])) {
        ctx.outDefs[c.ref] = { ...def, fields };
      }
    }
    return c;
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
  const ctx: WalkCtx = {
    overrides,
    defs: psdl.defs ?? {},
    outDefs: {},
    seenRefs: new Set(),
  };
  const body = psdl.body.map((c) => applyToContainer(c, ctx, ""));
  const bodyChanged = body.some((c, i) => c !== psdl.body[i]);
  const defsChanged = Object.keys(ctx.outDefs).length > 0;
  if (!bodyChanged && !defsChanged) return psdl;
  const next: PsdlPacket = bodyChanged ? { ...psdl, body } : { ...psdl };
  if (defsChanged) next.defs = { ...psdl.defs, ...ctx.outDefs };
  return next;
}
