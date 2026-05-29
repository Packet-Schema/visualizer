// Round-trip test for TLV instances across PSDL ↔ renderer mirror.
//
// Before PR #115's instance-persistence work, `tlvFieldToRepeat`
// emitted the catalog but silently dropped `tlv.instances`, so any
// path that went through `rendererToPsdl` (JSON export, share URL,
// "Save as preset") lost the user's chosen records. The fix carries
// instances on the PSDL `Repeat` itself; this test pins that
// behaviour.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.generated";
import { psdlToRenderer, rendererToPsdl } from "@/lib/psdl/psdl-to-renderer";

describe("TLV instances round-trip", () => {
  it("preserves IPv4 Options across renderer → PSDL → renderer", () => {
    const mirror1 = psdlToRenderer(PRESETS.ipv4!);
    const opts = mirror1.fields.find((f) => f.id === "options");
    if (!opts?.tlv) throw new Error("options field missing tlv");

    // Mutate the renderer mirror as a user would when editing the
    // diagram: two NOPs + one Record Route with a custom extras value.
    opts.tlv.instances = [
      { kind: 1 },
      { kind: 1 },
      { kind: 7, extras: { addrCount: 3 } },
    ];

    // Lift back to PSDL (= what every export path does).
    const psdl = rendererToPsdl(mirror1);
    const repeated = psdl.body.find(
      (c) => c.kind === "repeat" && c.id === "options",
    ) as { instances?: unknown[] } | undefined;
    expect(repeated, "options Repeat must be re-emitted").toBeDefined();
    expect(
      repeated?.instances,
      "PSDL Repeat must carry the instance list",
    ).toEqual([
      { kind: 1 },
      { kind: 1 },
      { kind: 7, extras: { addrCount: 3 } },
    ]);

    // Re-import (= what every import / hydrate path does).
    const mirror2 = psdlToRenderer(psdl);
    const opts2 = mirror2.fields.find((f) => f.id === "options");
    expect(opts2?.tlv?.instances).toEqual([
      { kind: 1 },
      { kind: 1 },
      { kind: 7, extras: { addrCount: 3 } },
    ]);
  });

  it("omits the `instances` key when no records are attached", () => {
    const mirror = psdlToRenderer(PRESETS.ipv4!);
    const psdl = rendererToPsdl(mirror);
    const repeated = psdl.body.find(
      (c) => c.kind === "repeat" && c.id === "options",
    ) as { instances?: unknown[] } | undefined;
    expect(repeated).toBeDefined();
    expect(
      repeated?.instances,
      "instances should be omitted (not [] noise) when nothing's attached",
    ).toBeUndefined();
  });
});
