// TLV expansion: replace a PSML body's TLV `Repeat<Switch>` with a single
// variable-length `bytes` Field whose total bit width matches the sum of
// `tlv.instances` byte sizes. The result is ONE big "Options" cell in the
// diagram — variant detail lives in TlvEditor (opened from OverridePanel
// when the cell is clicked), not as inline leaf cells.
//
// Why one cell rather than per-instance expansion: PSML `Repeat<Switch>`
// dispatches once per packet (env-keyed discriminator), so naively
// expanding each iteration into its variant's leaf fields either picks the
// wrong variant for every iteration ("Type=0 everywhere") or visually
// fragments the option slot into many one-byte cells. The wire-format
// reading the user actually wants is: "this 8-byte block holds N option
// records; click to see / edit them".

import type { Container, Packet as PsmlPacket } from "../types";
import type {
  Field as RendererField,
  Packet as RendererPacket,
} from "../renderer";

export function applyTlvInstances(
  psml: PsmlPacket,
  mirror: RendererPacket,
): PsmlPacket {
  const tlvByRepeatId = new Map<string, NonNullable<RendererField["tlv"]>>();
  const fieldMetaByRepeatId = new Map<string, RendererField>();
  for (const f of mirror.fields) {
    if (f.tlv) {
      tlvByRepeatId.set(f.id, f.tlv);
      fieldMetaByRepeatId.set(f.id, f);
    }
  }
  if (tlvByRepeatId.size === 0) return psml;

  let mutated = false;
  const newBody: Container[] = [];
  for (const c of psml.body) {
    if (c.kind === "repeat" && tlvByRepeatId.has(c.id)) {
      const tlv = tlvByRepeatId.get(c.id)!;
      if (tlv.instances.length === 0) {
        // No instances yet: keep the original Repeat so normalize falls
        // back to env-driven count (current behaviour pre-fix). Once
        // TLV_LENGTH_SYNC populates instances from the IHL slider this
        // branch is dead in normal use.
        newBody.push(c);
        continue;
      }
      // Sum every instance's byte size into one bytes-typed Field. Each
      // instance's byte size = total bits of its active catalog entry's
      // fields, divided by 8.
      const totalBytes = tlv.instances.reduce((acc, inst) => {
        const entry = tlv.catalog.find((e) => e.kind === inst.kind);
        const bits = (entry?.fields ?? []).reduce((a, f) => a + f.bits, 0);
        return acc + bits / 8;
      }, 0);
      if (totalBytes === 0) {
        newBody.push(c);
        continue;
      }
      mutated = true;
      const meta = fieldMetaByRepeatId.get(c.id);
      newBody.push({
        id: c.id,
        name: c.name ?? meta?.name ?? "Options",
        type: { kind: "bytes", n: { kind: "lit", value: totalBytes } },
        ...(c.category ? { category: c.category } : {}),
        ...(c.doc ? { doc: c.doc } : {}),
      });
      continue;
    }
    newBody.push(c);
  }
  return mutated ? { ...psml, body: newBody } : psml;
}
