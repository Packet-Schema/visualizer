// renderer → PSDL lift.
//
// Used by ImportExportDrawer to round-trip a renderer packet back into a
// PSDL Packet for the format hub. The mapping is faithful but lossy:
// subfield Groups round-trip, TLV/chain catalogs round-trip as
// Repeat<Switch>, plain Fields round-trip as Field. Constraints and
// Encrypted containers cannot be reconstructed from the renderer model
// (they don't exist there) and are therefore omitted on the return trip.

import type { Container, Packet as PsdlPacket, Type } from "../types";
import type {
  Field as RendererField,
  Packet as RendererPacket,
} from "../renderer";

import { chainFieldToRepeat } from "./chain";
import { rendererSubfieldsToGroup } from "./subfield";
import { tlvFieldToRepeat } from "./tlv";

/**
 * Reconstruct a variable-length `bytes` Type from the recoverable width
 * metadata a renderer Field still carries, so a source-less lift preserves the
 * field's on-wire SHAPE instead of dropping it (which silently shrinks the
 * packet — see Finding 1). Returns `null` only when no width metadata survives
 * (e.g. a width-0 Switch/Encrypted placeholder), in which case the caller drops
 * the field as before.
 *
 *  - `isRemaining` → `bytes({ kind: "remaining" })`. The remaining tail's shape
 *    is intrinsic (it is whatever budget is left), so this is exact.
 *  - `isDelimited` → `bytes({ delimiter })`, re-using the delimiter bytes
 *    carried onto the mirror (`plainFieldToRenderer`); falls back to a single
 *    NUL delimiter for hand-built mirrors that lack them.
 *  - `lengthFrom` → `bytes({ kind: "ref", field: lengthFrom })`. The value is
 *    sized by a sibling length field; re-emit the ref so the link survives.
 */
function variableBytesType(field: RendererField): Type | null {
  if (field.isRemaining) {
    return { kind: "bytes", n: { kind: "remaining" } };
  }
  if (field.isDelimited) {
    return {
      kind: "bytes",
      n: { delimiter: field.delimiterBytes ?? [0] },
    };
  }
  if (field.lengthFrom) {
    return { kind: "bytes", n: { kind: "ref", field: field.lengthFrom } };
  }
  return null;
}

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
  // Variable-length / zero-width leaves (`bytes(remaining)`, delimiter-
  // terminated `bytes`, `bytes(ref X)`, varint, …) report `bits: 0` and may
  // be flagged `variable`. Dropping them rather than re-emitting an
  // equivalent variable `bytes` produces VALID-but-structurally-smaller PSDL
  // on a source-less lift (share/export, `targetPsdl`, `activePsdlPacket`) —
  // a silent loss of on-wire shape (Finding 1). Re-emit whenever the field
  // still carries recoverable width metadata.
  const variableType = variableBytesType(field);
  if (variableType) {
    return [
      {
        id: field.id,
        name: field.name,
        type: variableType,
        ...(field.category ? { category: field.category } : {}),
        ...(field.description ? { doc: field.description } : {}),
        ...(field.defaultValue !== undefined
          ? { defaultValue: field.defaultValue }
          : {}),
        ...(field.byteOrder ? { byteOrder: field.byteOrder } : {}),
      },
    ];
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
