// Immutable updates for renderer-shaped packets.
//
// The legacy TLV/Chain editors used to mutate `field.tlv.instances` and
// `field.chainInstances` in place — fast, but violates React's state
// immutability contract and breaks any consumer that compares packet
// references. Use these helpers when you want to swap a field's state
// without rebuilding the surrounding packet by hand.

import type { Field, Packet } from "./renderer";

/**
 * Return a new Packet whose field with `fieldId` has been replaced by
 * `updater(field)`. The surrounding Packet object and the rest of the
 * fields array share references with `packet`. If no field matches,
 * the input packet is returned unchanged.
 */
export function updatePacketField(
  packet: Packet,
  fieldId: string,
  updater: (field: Field) => Field,
): Packet {
  let changed = false;
  const fields = packet.fields.map((f) => {
    if (f.id !== fieldId) return f;
    changed = true;
    return updater(f);
  });
  if (!changed) return packet;
  return { ...packet, fields };
}
