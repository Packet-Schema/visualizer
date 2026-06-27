// Subfield extraction and round-trip for the PSDL ↔ renderer adapter.
//
// PSDL idiom: a Group whose direct children are leaf Fields collapses
// in the renderer to a single Field with `subfields[]` (so the renderer
// can draw e.g. IPv4 flag bits R/DF/MF as sub-cells inside one Field).

import { isField } from "../utils";
import type { EnumVariant, Field as PsdlField, Group } from "../types";
import type { Field as RendererField, SubField } from "../renderer";

import { typeBits } from "./shared";

/**
 * Flatten 0.5 enum variants (`string | { label; … }`) down to the renderer's
 * `Record<number, string>` label map. The renderer only paints the label;
 * per-variant docs/levels are dropped here.
 */
function enumLabels(
  variants: Record<number, EnumVariant>,
): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [k, v] of Object.entries(variants)) {
    out[Number(k)] = typeof v === "string" ? v : v.label;
  }
  return out;
}

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
    if (child.defaultValue !== undefined) sf.defaultValue = child.defaultValue;
    if (child.type.kind === "varint") sf.varintEncoding = child.type.encoding;
    if (child.type.kind === "berLength") sf.isBerLength = true;
    if (child.type.kind === "enum")
      sf.enumVariants = enumLabels(child.type.variants);
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

/** Lower a PSDL leaf Field to its renderer-side counterpart. */
export function plainFieldToRenderer(f: PsdlField): RendererField {
  const out: RendererField = {
    id: f.id,
    name: f.name,
    bits: typeBits(f.type),
  };
  if (f.category) out.category = f.category;
  if (f.doc) out.description = f.doc;
  if (f.defaultValue !== undefined) out.defaultValue = f.defaultValue;
  // Data-dependent type widths get an env-override widget in OverridePanel.
  if (f.type.kind === "varint") out.varintEncoding = f.type.encoding;
  if (f.type.kind === "berLength") out.isBerLength = true;
  if (f.type.kind === "enum") out.enumVariants = enumLabels(f.type.variants);
  if (f.byteOrder) out.byteOrder = f.byteOrder;
  return out;
}

/** Reconstruct a subfield's PSDL type from the renderer-carried flags. Returns
 *  null for a width-0 subfield with no dynamic-type flag (so the caller drops
 *  it rather than emitting an invalid {kind:"bits", n:0}). */
function subFieldType(sf: SubField): PsdlField["type"] | null {
  if (sf.isBerLength) return { kind: "berLength" };
  if (sf.varintEncoding) return { kind: "varint", encoding: sf.varintEncoding };
  if (sf.enumVariants && sf.bits > 0) {
    return { kind: "enum", bits: sf.bits, variants: sf.enumVariants };
  }
  if (sf.bits > 0) return { kind: "bits", n: sf.bits };
  return null;
}

/** Inverse of `groupToSubfieldField` — round-trips renderer subfields
 *  back into a PSDL Group. Used by `rendererToPsdl`.
 *
 *  The previous form rewrote ids on the way back (`${field.id}_bits` for
 *  the Group, `${field.id}_${sf.id}` for each subfield), which made
 *  PSDL→renderer→PSDL non-idempotent and broke any Expr / constraint
 *  reference that pointed at the original subfield id. We now preserve
 *  the source ids — `groupToSubfieldField` keeps the original SubField
 *  id intact when lowering, so honouring it on the way back makes the
 *  round-trip stable and keeps ref lookups working (Copilot review).
 */
export function rendererSubfieldsToGroup(field: RendererField): Group {
  const subs: SubField[] = field.subfields ?? [];
  return {
    kind: "group",
    id: field.id,
    name: field.name,
    // Reconstruct each child's PSDL type from the carried flags instead of
    // forcing `bits` — a berLength / varint / dynamic subfield collapses to
    // bits=0, and emitting {kind:"bits", n:0} produces PSDL the validator
    // rejects (override-design-audit). Drop any width-0 subfield that has no
    // dynamic-type flag to recover from (mirrors the plain-field guard).
    children: subs
      .map((sf) => {
        const type = subFieldType(sf);
        if (!type) return null;
        return {
          id: sf.id,
          name: sf.name,
          type,
          ...(field.category ? { category: field.category } : {}),
          ...(sf.description ? { doc: sf.description } : {}),
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null),
  };
}
