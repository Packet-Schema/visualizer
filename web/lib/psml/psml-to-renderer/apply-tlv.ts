// TLV expansion: rewrite PSML body Repeats so each iteration's variant is
// pre-resolved from the renderer mirror's `tlv.instances`. Solves the
// "single Switch dispatch per Repeat" limitation of PSML normalize —
// without expansion, every iteration sees the same env-keyed discriminator
// and the diagram shows N copies of the same variant.
//
// Each instance becomes a `Group` of the variant's leaf fields. Normalize
// then collapses each Group into one NormalizedField with `subfields[]` so
// the diagram renders the instance as a single cell whose sub-cells show
// the variant's internal layout (Record Route → Type / Len / Ptr / Addr 1
// / …) — the canonical wire-format reading.

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

export function applyTlvInstances(
  psml: PsmlPacket,
  mirror: RendererPacket,
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
      if (tlv.instances.length === 0) {
        // No instances yet: keep the original Repeat so normalize falls
        // back to env-driven count. Once TLV_LENGTH_SYNC (or the user)
        // populates instances, the expansion below kicks in.
        newBody.push(c);
        continue;
      }
      mutated = true;
      for (let i = 0; i < tlv.instances.length; i++) {
        const inst = tlv.instances[i];
        const entry = tlv.catalog.find((e) => e.kind === inst.kind);
        if (!entry?.fields || entry.fields.length === 0) continue;
        // Emit one PSML Group per instance: normalize collapses Groups
        // with leaf-only children into a single NormalizedField with
        // `subfields[]`, so each instance renders as ONE cell with the
        // variant's fields shown as sub-cells.
        const group: PsmlGroup = {
          kind: "group",
          id: `${c.id}__inst_${i}`,
          name: entry.name,
          children: entry.fields.map<PsmlField>((f) => ({
            id: f.id,
            name: f.name,
            type: { kind: "bits", n: f.bits },
            ...(f.description ? { doc: f.description } : {}),
            ...(c.category ? { category: c.category } : {}),
          })),
        };
        newBody.push(group);
      }
      continue;
    }
    newBody.push(c);
  }
  return mutated ? { ...psml, body: newBody } : psml;
}
