// TLV expansion: rewrite PSML body Repeats so each iteration's variant is
// pre-resolved from the renderer mirror's `tlv.instances`. Solves the
// "single Switch dispatch per Repeat" limitation of PSML normalize —
// without expansion, every iteration sees the same `env[<discriminator>]`
// and the diagram shows N copies of the same variant (= "Type=0 everywhere"
// when no override is set).
//
// Used by PacketViewer just before `resolveLayout` so the cells reflect the
// per-instance variants the user has chosen via TlvEditor or the inline
// TLV-inner variant dropdown.

import type {
  Container,
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
        // No instances: keep the original Repeat so normalize falls back to
        // env-driven count + default Switch case (= the current behaviour
        // pre-fix, which shows Type=0 EOL when nothing's been picked yet).
        newBody.push(c);
        continue;
      }
      mutated = true;
      for (let i = 0; i < tlv.instances.length; i++) {
        const inst = tlv.instances[i];
        const entry = tlv.catalog.find((e) => e.kind === inst.kind);
        if (!entry?.fields || entry.fields.length === 0) continue;
        const group: PsmlGroup = {
          kind: "group",
          id: `${c.id}__inst_${i}`,
          name: entry.name,
          children: entry.fields.map((f) => ({
            id: f.id,
            name: f.name,
            type: { kind: "bits", n: f.bits },
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
