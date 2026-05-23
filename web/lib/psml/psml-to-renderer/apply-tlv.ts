// TLV expansion: rewrite a PSML body's TLV `Repeat<Switch>` into one of
// three shapes depending on the renderer mirror's `tlv.instances` and the
// caller-supplied `slotBytes` map (= the size of the Options *slot*
// derived from the upstream length controller, e.g. `(IHL − 5) × 4` for
// IPv4).
//
// Three stages mirror the user-facing workflow:
//
//   1. **Slot only** (`instances.length === 0` and `slotBytes > 0`)
//      Emit ONE placeholder `bytes(slotBytes)` Field carrying the TLV's
//      id. The diagram shows a single empty "Options" cell. Clicking it
//      lands on `packet.fields[tlvId]` (which still has the catalog) so
//      OverridePanel opens TlvEditor → user picks which Option records
//      to fill the slot with.
//
//   2. **Populated** (`instances.length > 0`)
//      Emit one PSML `Group` per instance. Layout collapses each Group
//      into a single cell whose `subCells[]` shows the variant's
//      Type / Length / etc. internals. When the instances total < slot,
//      a trailing `bytes(remaining)` placeholder fills the rest so the
//      slot visually closes at the controller boundary.
//
//   3. **Neither** (no instances and no slot — e.g. IHL = 5 on IPv4)
//      Keep the original Repeat so normalize falls back to env-driven
//      iteration (currently 0 → no cells at all). No mutation needed.

import type {
  Container,
  Field as PsmlField,
  Group as PsmlGroup,
  Packet as PsmlPacket,
} from "../types";
import type {
  Field as RendererField,
  Packet as RendererPacket,
} from "../renderer";

export type TlvSlotBytes = Record<string, number>;

export function applyTlvInstances(
  psml: PsmlPacket,
  mirror: RendererPacket,
  slotBytes: TlvSlotBytes = {},
): PsmlPacket {
  const tlvByRepeatId = new Map<string, NonNullable<RendererField["tlv"]>>();
  for (const f of mirror.fields) {
    if (f.tlv) tlvByRepeatId.set(f.id, f.tlv);
  }
  if (tlvByRepeatId.size === 0) return psml;

  let mutated = false;
  const newBody: Container[] = [];
  for (const c of psml.body) {
    if (c.kind === "repeat" && tlvByRepeatId.has(c.id)) {
      const tlv = tlvByRepeatId.get(c.id)!;
      const slot = Math.max(0, Math.floor(slotBytes[c.id] ?? 0));

      // Stage 3: neither instances nor a slot → leave the Repeat alone.
      if (tlv.instances.length === 0 && slot === 0) {
        newBody.push(c);
        continue;
      }

      mutated = true;

      // Stage 1: slot only → one empty placeholder Field of bytes(slot).
      if (tlv.instances.length === 0) {
        newBody.push({
          id: c.id,
          name: c.name ?? "Options",
          type: { kind: "bytes", n: { kind: "lit", value: slot } },
          ...(c.category ? { category: c.category } : {}),
          ...(c.doc ? { doc: c.doc } : {}),
        });
        continue;
      }

      // Stage 2: populated → one Group per instance.
      let instanceBytes = 0;
      for (let i = 0; i < tlv.instances.length; i++) {
        const inst = tlv.instances[i];
        const entry = tlv.catalog.find((e) => e.kind === inst.kind);
        if (!entry?.fields || entry.fields.length === 0) continue;
        const bits = entry.fields.reduce((a, f) => a + f.bits, 0);
        if (bits % 8 !== 0) {
          // The slot accounting (and the trailing "remaining" placeholder)
          // assumes byte-aligned variants. Real-world TLV catalogs all are,
          // but a bespoke preset could declare a non-aligned variant — fail
          // loudly in dev and ceil to the next byte so the diagram still
          // renders something sensible.
          console.warn(
            `[applyTlvInstances] TLV variant kind=${inst.kind} has ${bits} bits (not byte-aligned). ` +
              `Rounding up for slot accounting; consider padding the catalog entry.`,
          );
        }
        instanceBytes += Math.ceil(bits / 8);
        const groupId = `${c.id}__inst_${i}`;
        const group: PsmlGroup = {
          kind: "group",
          id: groupId,
          name: entry.name,
          children: entry.fields.map<PsmlField>((f) => ({
            // Prefix the child id with the instance group's id so two
            // copies of the same variant (e.g. NOP × 8) produce
            // distinct NormalizedField ids. Without this, normalize
            // emits N fields with the same `id: "type"` and React keys
            // collide, plus `selectedFieldId.split(":")` lookups land
            // on the first match instead of the actually clicked one.
            id: `${groupId}__${f.id}`,
            name: f.name,
            type: { kind: "bits", n: f.bits },
            ...(f.description ? { doc: f.description } : {}),
            ...(c.category ? { category: c.category } : {}),
          })),
        };
        newBody.push(group);
      }

      // Stage 2b: trailing placeholder when the user-declared slot is
      // bigger than the records that have been added so far. Lets the
      // diagram visually close on the controller boundary instead of
      // leaving a phantom gap.
      if (slot > instanceBytes) {
        const remaining = slot - instanceBytes;
        newBody.push({
          id: `${c.id}__remaining`,
          name: `Options remaining (${remaining} B)`,
          type: { kind: "bytes", n: { kind: "lit", value: remaining } },
          ...(c.category ? { category: c.category } : {}),
        });
      }
      // Stage 2c (overshoot, `instanceBytes > slot`): the user added
      // more record bytes than the controller declares. Wire format is
      // malformed (IHL would need to grow). We currently let the
      // instance cells overflow past the controller boundary in the
      // diagram without a visible warning — a follow-up should surface
      // this as a banner above the diagram or auto-grow IHL to match.
      // See PR #115 sub-agent review for the rationale.
      continue;
    }
    newBody.push(c);
  }
  return mutated ? { ...psml, body: newBody } : psml;
}
