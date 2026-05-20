// renderer → PSML lift.
//
// Used by ImportExportDrawer to round-trip a renderer packet back into a
// PSML Packet for the format hub. The mapping is faithful but lossy:
// subfield Groups round-trip, TLV/chain catalogs round-trip as
// Repeat<Switch>, plain Fields round-trip as Field. Constraints and
// Encrypted containers cannot be reconstructed from the renderer model
// (they don't exist there) and are therefore omitted on the return trip.

import type { Container, Packet as PsmlPacket } from "../types";
import type {
  Field as RendererField,
  Packet as RendererPacket,
} from "../renderer";

import { chainFieldToRepeat } from "./chain";
import { rendererSubfieldsToGroup } from "./subfield";
import { tlvFieldToRepeat } from "./tlv";

function rendererFieldToPsml(field: RendererField): Container[] {
  if (field.tlv) return [tlvFieldToRepeat(field)];
  if (field.chainCatalog) {
    // `repeatToChainField` sets bits: 0 on the placeholder it builds for
    // the chain dispatcher field, but PSML validation requires bit
    // widths > 0 (a bit-typed Field must occupy at least one wire bit).
    // Treat non-positive as "unset" and fall back to the canonical
    // IPv6 NextHeader / Protocol byte width of 8.
    const baseBits = field.bits && field.bits > 0 ? field.bits : 8;
    const base: Container = {
      id: field.id,
      name: field.name,
      type: { kind: "bits", n: baseBits },
      ...(field.category ? { category: field.category } : {}),
      ...(field.description ? { doc: field.description } : {}),
      ...(field.defaultValue !== undefined
        ? { defaultValue: field.defaultValue }
        : {}),
    };
    return [base, chainFieldToRepeat(field)];
  }
  if (field.subfields && field.subfields.length > 0) {
    return [rendererSubfieldsToGroup(field)];
  }
  if (field.variable) {
    return [];
  }
  return [
    {
      id: field.id,
      name: field.name,
      type: { kind: "bits", n: field.bits ?? 0 },
      ...(field.category ? { category: field.category } : {}),
      ...(field.description ? { doc: field.description } : {}),
      ...(field.defaultValue !== undefined
        ? { defaultValue: field.defaultValue }
        : {}),
    },
  ];
}

/** Lift a renderer-shaped Packet back to PSML (lossy for variable-length
 *  payloads without TLV metadata, and for any Encrypted/Constraint state
 *  that was never representable in the renderer model). */
export function rendererToPsml(packet: RendererPacket): PsmlPacket {
  const body: Container[] = [];
  for (const field of packet.fields) {
    body.push(...rendererFieldToPsml(field));
  }
  return {
    name: packet.name,
    rowBits: packet.rowBits,
    byteOrder: packet.byteOrder ?? "BE",
    ...(packet.description ? { description: packet.description } : {}),
    body,
  };
}
