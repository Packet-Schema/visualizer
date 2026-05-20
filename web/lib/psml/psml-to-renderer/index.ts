// PSML 0.3 — PSML → renderer adapter (top-level).
//
// Lowers a PSML Packet to the renderer Packet shape consumed by React
// components (DetailPanel, ControlsPanel, TlvEditor, ChainEditor,
// DependencyOverlay, …). The renderer model is intentionally lossier than
// PSML: Repeat<Switch> TLV catalogs are flattened to a `tlv` extension on a
// single variable-length placeholder Field, subfield Groups collapse to a
// `subfields[]` array, etc. The PSML Packet is still the canonical source —
// `resolveLayout(packet, …)` is the path for cell positioning, and PSML
// alone drives serialization through `lib/formats/*`.
//
// The transformation is split across:
//   - `./tlv.ts`       — TLV catalog detection & round-trip
//   - `./chain.ts`     — IPv6 extension-header chain detection & round-trip
//   - `./subfield.ts`  — Group → subfield collapse + plain leaf transform
//   - `./to-psml.ts`   — renderer → PSML lift (`rendererToPsml`)
//   - `./shared.ts`    — `typeBits` + helpers used across the modules

import { isField } from "../utils";
import type { Packet as PsmlPacket } from "../types";
import type {
  Field as RendererField,
  Packet as RendererPacket,
} from "../renderer";

import { isLikelyChainRepeat, repeatToChainField } from "./chain";
import { groupToSubfieldField, plainFieldToRenderer } from "./subfield";
import { isTlvRepeat, repeatToTlvField } from "./tlv";

export { rendererToPsml } from "./to-psml";

/**
 * Inspect a Constraint to discover field controller relations of the form
 * `ref(fieldA) * lit(N) == ref(fieldB)` (or the symmetric form). When such a
 * shape is found, return `{ fromId: fieldA, controlsName: fieldB }` so the
 * caller can tag fieldA's renderer Field with `controlsLength: fieldB`.
 */
function constraintToController(constraint: {
  lhs: { kind: string; field?: string; op?: string; a?: unknown; b?: unknown };
  rhs: { kind: string; field?: string; op?: string; a?: unknown; b?: unknown };
}): { fromId: string; controlsName: string } | null {
  const tryMatch = (
    mul: typeof constraint.lhs,
    target: typeof constraint.rhs,
  ): { fromId: string; controlsName: string } | null => {
    if (target.kind !== "ref" || typeof target.field !== "string") return null;
    if (mul.kind === "ref" && typeof mul.field === "string") {
      return { fromId: mul.field, controlsName: target.field };
    }
    if (mul.kind === "op" && mul.op === "*") {
      const a = mul.a as { kind: string; field?: string };
      const b = mul.b as { kind: string; field?: string };
      if (a.kind === "ref" && typeof a.field === "string") {
        return { fromId: a.field, controlsName: target.field };
      }
      if (b.kind === "ref" && typeof b.field === "string") {
        return { fromId: b.field, controlsName: target.field };
      }
    }
    return null;
  };
  return (
    tryMatch(constraint.lhs, constraint.rhs) ??
    tryMatch(constraint.rhs, constraint.lhs)
  );
}

/**
 * Walk the PSML body and produce a renderer-shaped Packet. Top-level
 * Repeat<Switch> nodes that look like TLV catalogs / chain catalogs are
 * promoted to renderer fields with `tlv` / `chainCatalog` populated so
 * TlvEditor and ChainEditor keep working. Groups whose direct children are
 * all leaf fields collapse to a single subfield-bearing renderer field.
 *
 * Nested Encrypted containers are skipped here — they contribute layout
 * cells via `resolveLayout`, not editor metadata.
 */
export function psmlToRenderer(packet: PsmlPacket): RendererPacket {
  const fields: RendererField[] = [];
  for (const c of packet.body) {
    if (isField(c)) {
      fields.push(plainFieldToRenderer(c));
      continue;
    }
    if (c.kind === "group") {
      const flat = groupToSubfieldField(c);
      if (flat) fields.push(flat);
      continue;
    }
    if (c.kind === "repeat") {
      if (isLikelyChainRepeat(c)) {
        fields.push(repeatToChainField(c));
      } else if (isTlvRepeat(c)) {
        fields.push(repeatToTlvField(c));
      }
      continue;
    }
    if (c.kind === "switch") {
      // Bare Switch — flatten to a placeholder.
      fields.push({ id: c.id, name: c.name ?? c.id, bits: 0 });
      continue;
    }
    if (c.kind === "encrypted") {
      // Surface as a single field placeholder so the DetailPanel can name
      // it. The actual cell layout (and headerProtected/encrypted flags)
      // comes from `resolveLayout`, not this adapter.
      const fld: RendererField = {
        id: c.id,
        name: c.name ?? c.id,
        bits: 0,
      };
      if (c.category) fld.category = c.category;
      if (c.doc) fld.description = c.doc;
      fields.push(fld);
      continue;
    }
  }
  // Stitch controller annotations onto the renderer fields by scanning the
  // PSML constraints. This lets ControlsPanel surface IHL / Data Offset as
  // length-driving sliders the same way the legacy preset model did.
  // The slider writes its value back under the field's own id; the layout
  // step is responsible for deriving any downstream Repeat counts from it.
  if (packet.constraints) {
    for (const c of packet.constraints) {
      const match = constraintToController(
        c as Parameters<typeof constraintToController>[0],
      );
      if (!match) continue;
      const target = fields.find((f) => f.id === match.fromId);
      if (target && !target.controlsLength) {
        target.controlsLength = match.fromId;
        if (target.bits != null) {
          target.max = Math.max(target.max ?? 0, 2 ** target.bits - 1);
        }
      }
    }
  }
  return {
    name: packet.name,
    rowBits: packet.rowBits,
    fields,
    ...(packet.description ? { description: packet.description } : {}),
    ...(packet.byteOrder ? { byteOrder: packet.byteOrder } : {}),
  };
}
