// Round-trip test for TLV instances across PSML ↔ renderer mirror.
//
// Before PR #115's instance-persistence work, `tlvFieldToRepeat`
// emitted the catalog but silently dropped `tlv.instances`, so any
// path that went through `rendererToPsml` (JSON export, share URL,
// "Save as preset") lost the user's chosen records. The fix carries
// instances on the PSML `Repeat` itself; this test pins that
// behaviour.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psml/presets.generated";
import {
  psmlToRenderer,
  rendererToPsml,
} from "@/lib/psml/psml-to-renderer";

describe("TLV instances round-trip", () => {
  it("preserves IPv4 Options across renderer → PSML → renderer", () => {
    const mirror1 = psmlToRenderer(PRESETS.ipv4!);
    const opts = mirror1.fields.find((f) => f.id === "options");
    if (!opts?.tlv) throw new Error("options field missing tlv");

    // Mutate the renderer mirror as a user would when editing the
    // diagram: two NOPs + one Record Route with a custom extras value.
    opts.tlv.instances = [
      { kind: 1 },
      { kind: 1 },
      { kind: 7, extras: { addrCount: 3 } },
    ];

    // Lift back to PSML (= what every export path does).
    const psml = rendererToPsml(mirror1);
    const repeated = psml.body.find(
      (c) => c.kind === "repeat" && c.id === "options",
    ) as { instances?: unknown[] } | undefined;
    expect(repeated, "options Repeat must be re-emitted").toBeDefined();
    expect(
      repeated?.instances,
      "PSML Repeat must carry the instance list",
    ).toEqual([
      { kind: 1 },
      { kind: 1 },
      { kind: 7, extras: { addrCount: 3 } },
    ]);

    // Re-import (= what every import / hydrate path does).
    const mirror2 = psmlToRenderer(psml);
    const opts2 = mirror2.fields.find((f) => f.id === "options");
    expect(opts2?.tlv?.instances).toEqual([
      { kind: 1 },
      { kind: 1 },
      { kind: 7, extras: { addrCount: 3 } },
    ]);
  });

  it("omits the `instances` key when no records are attached", () => {
    const mirror = psmlToRenderer(PRESETS.ipv4!);
    const psml = rendererToPsml(mirror);
    const repeated = psml.body.find(
      (c) => c.kind === "repeat" && c.id === "options",
    ) as { instances?: unknown[] } | undefined;
    expect(repeated).toBeDefined();
    expect(
      repeated?.instances,
      "instances should be omitted (not [] noise) when nothing's attached",
    ).toBeUndefined();
  });
});
