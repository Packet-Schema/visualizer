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
    // The chain Repeat alone reconstructs the on-wire shape. The source
    // PSML kept a separate 8-bit NextHeader Field alongside its Repeat,
    // but `psmlToRenderer` collapses both into a single chainCatalog-
    // bearing Field with `id === r.id` (which already ends in
    // `_chain`). Emitting a synthetic base Field here would:
    //   1. duplicate the Repeat id (after `_chain` strip+append they
    //      land on the same name), and
    //   2. add a spurious 8-bit cell to the exported packet's wire
    //      layout that wasn't in the original source PSML.
    // Round-trip is lossy by design (see the file header); accept that
    // NextHeader / Protocol byte vanishes on re-export rather than
    // breaking every export with an id collision (Copilot review).
    return [chainFieldToRepeat(field)];
  }
  if (field.subfields && field.subfields.length > 0) {
    return [rendererSubfieldsToGroup(field)];
  }
  if (field.variable) {
    return [];
  }
  // Zero-bit Fields are placeholders for Switch / Encrypted containers
  // that the renderer model doesn't carry over (see `psmlToRenderer`'s
  // `kind === "switch" / "encrypted"` arms, which emit `bits: 0`). PSML
  // validation rejects `type: { kind: "bits", n: 0 }`, so emitting one
  // here would corrupt the JSON export / share URL / custom-preset
  // persistence paths. Drop the placeholder — its information cannot be
  // reconstructed from the renderer model anyway. The file header
  // already documents that Switch / Encrypted aren't round-trippable.
  if (!field.bits || field.bits <= 0) {
    return [];
  }
  return [
    {
      id: field.id,
      name: field.name,
      type: { kind: "bits", n: field.bits },
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
