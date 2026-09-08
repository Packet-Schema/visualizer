// Regression: an `Optional` gated by `ref(X)` where X is a 1-bit subcell of a
// flags Group that ALSO nests a sub-group must still surface a controllable
// gate. `groupToSubfieldField` bails entirely on a Group with a compound
// (nested-group) child, so such a flags Group never reached the renderer mirror
// and its bit leaves were absent — no field, no subfield, no `optionalGateFor`.
//
// Concrete victim: GTPv2-C (`gtpv2c`). `gtpv2Flags` nests `gtpv2SpareGroup`, so
// the whole group dropped out of the mirror. Its `gtpv2T` (TEID-Present) bit
// gates `optional(when: ref gtpv2T){ gtpv2Teid }`, which flips the header from 8
// to 12 bytes. The user could SEE the T flag and watch the 32-bit TEID
// appear/disappear, but had no control to toggle it — see-but-cannot-edit.
//
// The fix lazily deep-collapses the owning Group into subfields when a gate ref
// resolves to a bit leaf inside it, so `attachOverrideMetadata` can stamp
// `gtpv2T.optionalGateFor` and OverridePanel can render an OptionalToggle keyed
// on env['gtpv2T'].

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import type { Packet } from "@/lib/psdl/types";
import type { SubField } from "@/lib/psdl/renderer";

const gtp = (): Packet => PRESETS.gtpv2c as Packet;

function findSub(mirror: ReturnType<typeof psdlToRenderer>, id: string) {
  for (const f of mirror.fields) {
    const sub = f.subfields?.find((s: SubField) => s.id === id);
    if (sub) return sub;
  }
  return undefined;
}

describe("gtpv2c: TEID-Present (gtpv2T) gate is controllable", () => {
  it("surfaces gtpv2T as a subfield carrying optionalGateFor", () => {
    const mirror = psdlToRenderer(gtp());

    // The flags group nests a spare sub-group, so without the deep collapse the
    // whole group (and gtpv2T) is absent.
    const flags = mirror.fields.find((f) => f.id === "gtpv2Flags");
    expect(flags).toBeDefined();
    expect(flags?.subfields?.map((s) => s.id)).toContain("gtpv2T");

    const gtpv2T = findSub(mirror, "gtpv2T");
    expect(gtpv2T).toBeDefined();
    expect(gtpv2T?.optionalGateFor ?? []).not.toHaveLength(0);
  });

  it("toggling env['gtpv2T'] makes the 32-bit TEID appear / disappear", () => {
    const ids = (env: Record<string, number>): string[] =>
      resolveLayout(gtp(), { env: new Map(Object.entries(env)) }).cells.map(
        (c) => c.field.id,
      );
    expect(ids({ gtpv2T: 0 })).not.toContain("gtpv2Teid");
    expect(ids({ gtpv2T: 1 })).toContain("gtpv2Teid");
  });
});
