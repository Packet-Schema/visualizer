// renderer → PSDL lift.
//
// Used by ImportExportDrawer to round-trip a renderer packet back into a
// PSDL Packet for the format hub. The mapping is faithful but lossy:
// subfield Groups round-trip, TLV/chain catalogs round-trip as
// Repeat<Switch>, plain Fields round-trip as Field. Constraints and
// Encrypted containers cannot be reconstructed from the renderer model
// (they don't exist there) and are therefore omitted on the return trip.

import type { Container, Packet as PsdlPacket } from "../types";
import type {
  Field as RendererField,
  Packet as RendererPacket,
} from "../renderer";

import { chainFieldToRepeat } from "./chain";
import { rendererSubfieldsToGroup } from "./subfield";
import { tlvFieldToRepeat } from "./tlv";

function rendererFieldToPsdl(field: RendererField): Container[] {
  if (field.tlv) return [tlvFieldToRepeat(field)];
  if (field.chainCatalog) {
    // Two shapes can carry a chain catalog after psdlToRenderer:
    //   (a) `bits > 0` — the chain was merged onto a sibling base Field
    //       (the IPv6 `nextHeader` 8-bit Field absorbs the
    //       `nextHeader_chain` Repeat's catalog). Emit BOTH the base
    //       Field AND the chain Repeat to keep the on-wire shape intact.
    //   (b) `bits === 0` — no base Field existed at import time, the
    //       chain landed as a standalone (invisible) catalog holder.
    //       Emit only the Repeat (back to the pre-merge form).
    const repeat = chainFieldToRepeat(field);
    if (field.bits && field.bits > 0) {
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
        repeat,
      ];
    }
    return [repeat];
  }
  if (field.subfields && field.subfields.length > 0) {
    return [rendererSubfieldsToGroup(field)];
  }
  if (field.variable) {
    return [];
  }
  // Zero-bit Fields are placeholders for Switch / Encrypted containers
  // that the renderer model doesn't carry over (see `psdlToRenderer`'s
  // `kind === "switch" / "encrypted"` arms, which emit `bits: 0`). PSDL
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
      ...(field.byteOrder ? { byteOrder: field.byteOrder } : {}),
    },
  ];
}

/** Lift a renderer-shaped Packet back to PSDL (lossy for variable-length
 *  payloads without TLV metadata, and for any Encrypted/Constraint state
 *  that was never representable in the renderer model). */
export function rendererToPsdl(packet: RendererPacket): PsdlPacket {
  const body: Container[] = [];
  for (const field of packet.fields) {
    body.push(...rendererFieldToPsdl(field));
  }
  return {
    name: packet.name,
    rowBits: packet.rowBits,
    byteOrder: packet.byteOrder === "LE" ? "LE" : "BE",
    ...(packet.description ? { description: packet.description } : {}),
    body,
  };
}
