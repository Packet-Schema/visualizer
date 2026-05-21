// applyTlvInstances smoke — verifies that the renderer mirror's
// `tlv.instances` are expanded into per-instance Group containers in the
// PSML body so each Repeat iteration renders its own variant (instead of
// the env-driven single Switch dispatch that produces N copies of the
// default variant — the "Type=0 everywhere" symptom).

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psml/presets.generated";
import { applyTlvInstances, psmlToRenderer } from "@/lib/psml/psml-to-renderer";

describe("applyTlvInstances", () => {
  it("returns the packet unchanged when no instances are present", () => {
    const psml = PRESETS.ipv4!;
    const mirror = psmlToRenderer(psml);
    const out = applyTlvInstances(psml, mirror);
    expect(out).toBe(psml);
  });

  it("replaces a TLV Repeat with one Group per instance (variant fields as Group children)", () => {
    const psml = PRESETS.ipv4!;
    const mirror = psmlToRenderer(psml);
    const opt = mirror.fields.find((f) => f.id === "options");
    expect(opt?.tlv).toBeDefined();
    if (!opt?.tlv) throw new Error("options field missing tlv");
    opt.tlv.instances = [{ kind: 7 }, { kind: 1 }];
    const out = applyTlvInstances(psml, mirror);
    expect(out).not.toBe(psml);
    const repeats = out.body.filter(
      (c) => c.kind === "repeat" && c.id === "options",
    );
    expect(repeats, "TLV Repeat should be gone from the body").toHaveLength(0);
    const groups = out.body.filter(
      (c) => c.kind === "group" && c.id.startsWith("options__inst_"),
    );
    expect(groups).toHaveLength(2);
    expect((groups[0] as { children?: unknown[] }).children).toHaveLength(6);
    expect((groups[1] as { children?: unknown[] }).children).toHaveLength(1);
  });
});
