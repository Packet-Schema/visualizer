// Subfield extraction and round-trip for the PSML ↔ renderer adapter.
//
// PSML idiom: a Group whose direct children are leaf Fields collapses
// in the renderer to a single Field with `subfields[]` (so the renderer
// can draw e.g. IPv4 flag bits R/DF/MF as sub-cells inside one Field).

import { isField } from "../utils";
import type { Field as PsmlField, Group } from "../types";
import type { Field as RendererField, SubField } from "../renderer";

import { typeBits } from "./shared";

/**
 * Collapse a Group of leaf fields into one renderer Field whose
 * `subfields[]` carries the per-child labels and widths. Returns `null`
 * when the group is empty or contains compound children — caller falls
 * back to whatever the schema says.
 */
export function groupToSubfieldField(g: Group): RendererField | null {
  const subs: SubField[] = [];
  let total = 0;
  let category: RendererField["category"];
  for (const child of g.children) {
    if (!isField(child)) return null;
    const bits = typeBits(child.type);
    const sf: SubField = { id: child.id, name: child.name, bits };
    if (child.doc) sf.description = child.doc;
    subs.push(sf);
    total += bits;
    if (child.category && !category) category = child.category;
  }
  if (subs.length === 0) return null;
  const out: RendererField = {
    id: g.id,
    name: g.name ?? g.id,
    bits: total,
    subfields: subs,
  };
  if (category) out.category = category;
  return out;
}

/** Lower a PSML leaf Field to its renderer-side counterpart. */
export function plainFieldToRenderer(f: PsmlField): RendererField {
  const out: RendererField = {
    id: f.id,
    name: f.name,
    bits: typeBits(f.type),
  };
  if (f.category) out.category = f.category;
  if (f.doc) out.description = f.doc;
  if (f.defaultValue !== undefined) out.defaultValue = f.defaultValue;
  return out;
}

/** Inverse of `groupToSubfieldField` — round-trips renderer subfields
 *  back into a PSML Group. Used by `rendererToPsml`. */
export function rendererSubfieldsToGroup(field: RendererField): Group {
  const subs: SubField[] = field.subfields ?? [];
  return {
    kind: "group",
    id: `${field.id}_bits`,
    name: field.name,
    children: subs.map((sf) => ({
      id: `${field.id}_${sf.id}`,
      name: sf.name,
      type: { kind: "bits", n: sf.bits },
      ...(field.category ? { category: field.category } : {}),
      ...(sf.description ? { doc: sf.description } : {}),
    })),
  };
}
