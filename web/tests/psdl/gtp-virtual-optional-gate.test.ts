// high: gtpv1u / gtpv1c wrap their optional 4-byte block (Sequence Number,
// N-PDU Number, Next-Ext-Header-Type) in `optional { when: ref(gtpOptPresent) }`
// where `gtpOptPresent` is a `virtual` field = `gtpE | gtpS | gtpPN`.
//
// `attachOverrideMetadata`'s optional handler maps `when.kind === "ref"` to a
// stampable cell, but a VIRTUAL has no cell — `findOrSurfaceGateTarget` found
// nothing and stamped no `optionalGateFor`. The real driving bits gtpE/gtpS/gtpPN
// (subfields of the Flags group) got no gate metadata either. Net: the entire
// mirror exposed only the gtpPT / gtpMessageType enum dropdowns — neither toggles
// the block. The user could SEE the block (set E=1 and the cells render) yet had
// no OverridePanel control to reveal or hide it: a see-but-cannot-edit gap.
//
// Fix: in the optional `ref` branch, expand a virtual gate to its expr's refs
// when the expr is a pure OR of refs (presence == any leaf truthy), and stamp
// `optionalGateFor` on each underlying bit. Each becomes a Present/Absent toggle
// whose env truthiness ORs back into the virtual.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import type { Packet } from "@/lib/psdl/types";
import type { SubField } from "@/lib/psdl/renderer";

function findSub(mirror: ReturnType<typeof psdlToRenderer>, id: string) {
  for (const f of mirror.fields) {
    const sub = f.subfields?.find((s: SubField) => s.id === id);
    if (sub) return sub;
  }
  return undefined;
}

function cellIds(packet: Packet, env: Record<string, number>): string[] {
  return resolveLayout(packet, { env: new Map(Object.entries(env)) }).cells.map(
    (c) => c.field.id,
  );
}

describe("gtpv1u: virtual-gated optional Sequence-Number block is controllable", () => {
  const gtpv1u = (): Packet => PRESETS.gtpv1u as Packet;

  it("stamps optionalGateFor on each driving bit (gtpE/gtpS/gtpPN)", () => {
    const mirror = psdlToRenderer(gtpv1u());

    for (const id of ["gtpE", "gtpS", "gtpPN"]) {
      const sub = findSub(mirror, id);
      expect(sub, `${id} should surface as a subfield`).toBeDefined();
      expect(
        sub?.optionalGateFor ?? [],
        `${id} should carry an optionalGateFor`,
      ).not.toHaveLength(0);
      // It gates the whole 3-cell optional block.
      expect(sub?.optionalGateFor).toContain("Sequence Number");
    }
  });

  it("toggling env['gtpE'] reveals gtpSeqNum in the resolved layout", () => {
    const base = cellIds(gtpv1u(), {});
    expect(base).not.toContain("gtpSeqNum");

    const withE = cellIds(gtpv1u(), { gtpE: 1 });
    expect(withE).toContain("gtpSeqNum");
    expect(withE).toContain("gtpNPDUNumber");
    expect(withE).toContain("gtpNextExtHdrType");

    // Each driving bit independently ORs into the virtual presence.
    expect(cellIds(gtpv1u(), { gtpS: 1 })).toContain("gtpSeqNum");
    expect(cellIds(gtpv1u(), { gtpPN: 1 })).toContain("gtpSeqNum");
  });
});

describe("gtpv1c: virtual-gated optional block is controllable too", () => {
  const gtpv1c = (): Packet => PRESETS.gtpv1c as Packet;

  it("stamps optionalGateFor on gtpcE/gtpcS/gtpcPN", () => {
    const mirror = psdlToRenderer(gtpv1c());
    for (const id of ["gtpcE", "gtpcS", "gtpcPN"]) {
      const sub = findSub(mirror, id);
      expect(sub?.optionalGateFor ?? []).not.toHaveLength(0);
    }
  });
});

describe("virtual gates that are NOT a pure OR-of-refs stay inert-free", () => {
  // rtmp's `tsSentinel = (fmt==0 && timestamp0==0xFFFFFF) || …` is a `cond`:
  // presence depends on a specific VALUE, so a Present/Absent checkbox writing
  // 0/1 onto `fmt` would be misleading. It must NOT be expanded into a toggle.
  it("does not stamp optionalGateFor on rtmp's fmt / timestamp leaves", () => {
    const mirror = psdlToRenderer(PRESETS.rtmp as Packet);
    for (const id of ["fmt", "timestamp0", "timestamp1", "timestamp2"]) {
      const sub = findSub(mirror, id);
      const field = mirror.fields.find((f) => f.id === id);
      expect(sub?.optionalGateFor ?? []).toHaveLength(0);
      expect(field?.optionalGateFor ?? []).toHaveLength(0);
    }
  });
});
