// Regression: Diameter AVP's `avpFlagV` (V / Vendor-Specific) bit gates an
// `optional(when: ref avpFlagV){ avpVendorId }` that flips the 32-bit Vendor-ID
// in or out of each AVP. `avpFlagV` is a 1-bit leaf inside the `avpFlagsGroup`
// group, which lives INSIDE the top-level `diameterAvps` eos repeat element.
//
// `attachOverrideMetadata.visit()` recurses into the repeat element and reaches
// the Optional, but `findOrSurfaceGateTarget` previously resolved the gate's
// owning group via `groupOwning`, which walked `flattenForMirror(body)` — and
// `flattenForMirror` never descends into a repeat. So `avpFlagsGroup` was
// unreachable, the diameter mirror had an EMPTY `fields[]`, and no
// `optionalGateFor` was stamped: the user could SEE `avpFlagsGroup#0` and watch
// `avpVendorId#0` appear/disappear but had no control to toggle it.
//
// The fix threads the currently-visited scope into `findOrSurfaceGateTarget`, so
// a gate owned by a group nested in the repeat element is found in the element's
// own scope and surfaced (deep-collapsed) as a subfield-anchored toggle.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import type { Packet } from "@/lib/psdl/types";
import type { SubField } from "@/lib/psdl/renderer";

const diameter = (): Packet => PRESETS.diameter as Packet;

function findSub(mirror: ReturnType<typeof psdlToRenderer>, id: string) {
  for (const f of mirror.fields) {
    const sub = f.subfields?.find((s: SubField) => s.id === id);
    if (sub) return sub;
  }
  return undefined;
}

describe("diameter: AVP Vendor-Specific (avpFlagV) gate is controllable", () => {
  it("surfaces avpFlagV as a subfield carrying optionalGateFor", () => {
    const mirror = psdlToRenderer(diameter());

    // The flags group lives inside the repeat element; without the
    // scope-aware gate resolution the whole group (and avpFlagV) is absent.
    const flags = mirror.fields.find((f) => f.id === "avpFlagsGroup");
    expect(flags).toBeDefined();
    expect(flags?.subfields?.map((s) => s.id)).toContain("avpFlagV");

    const avpFlagV = findSub(mirror, "avpFlagV");
    expect(avpFlagV).toBeDefined();
    expect(avpFlagV?.optionalGateFor ?? []).not.toHaveLength(0);
  });

  it("toggling env['avpFlagV'] flips the 32-bit avpVendorId in the layout", () => {
    // The diameterAvps free-repeat seeds a representative record (defaultCount
    // 1); mirror that seeded state with an explicit count so a record exists.
    const ids = (env: Record<string, number>): string[] =>
      resolveLayout(diameter(), {
        env: new Map(Object.entries({ diameterAvps: 1, ...env })),
      }).cells.map((c) => c.field.id);

    expect(ids({ avpFlagV: 0 })).not.toContain("avpVendorId#0");
    expect(ids({ avpFlagV: 1 })).toContain("avpVendorId#0");
  });
});
