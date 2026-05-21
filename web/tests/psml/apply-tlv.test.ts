// applyTlvInstances smoke — verifies that the renderer mirror's
// `tlv.instances` are expanded into per-instance Group containers in the
// PSML body so each Repeat iteration renders its own variant (instead of
// the env-driven single Switch dispatch that produces N copies of the
// default variant — the "Type=0 everywhere" symptom).

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psml/presets.generated";
import { applyTlvInstances, psmlToRenderer } from "@/lib/psml/psml-to-renderer";

describe("applyTlvInstances", () => {
  it("returns the packet unchanged when no instances and no slot bytes", () => {
    const psml = PRESETS.ipv4!;
    const mirror = psmlToRenderer(psml);
    const out = applyTlvInstances(psml, mirror, {});
    expect(out).toBe(psml);
  });

  it("emits a single bytes(N) placeholder when instances=[] and slot>0", () => {
    const psml = PRESETS.ipv4!;
    const mirror = psmlToRenderer(psml);
    const opt = mirror.fields.find((f) => f.id === "options");
    if (!opt?.tlv) throw new Error("options field missing tlv");
    expect(opt.tlv.instances.length).toBe(0);
    const out = applyTlvInstances(psml, mirror, { options: 8 });
    expect(out).not.toBe(psml);
    const repeats = out.body.filter(
      (c) => c.kind === "repeat" && c.id === "options",
    );
    expect(repeats).toHaveLength(0);
    const placeholder = out.body.find(
      (c) =>
        (!("kind" in c) || c.kind === "field") &&
        (c as { id: string }).id === "options",
    );
    expect(placeholder).toBeDefined();
    const type = (placeholder as { type: { kind: string; n: unknown } }).type;
    expect(type.kind).toBe("bytes");
    expect((type.n as { value: number }).value).toBe(8);
  });

  it("emits a trailing 'remaining' placeholder when instances total < slot", () => {
    const psml = PRESETS.ipv4!;
    const mirror = psmlToRenderer(psml);
    const opt = mirror.fields.find((f) => f.id === "options");
    if (!opt?.tlv) throw new Error("options field missing tlv");
    opt.tlv.instances = [{ kind: 1 }, { kind: 1 }]; // two NOPs = 2 bytes
    const out = applyTlvInstances(psml, mirror, { options: 8 });
    const groups = out.body.filter(
      (c) => c.kind === "group" && c.id.startsWith("options__inst_"),
    );
    expect(groups).toHaveLength(2);
    const remaining = out.body.find(
      (c) =>
        (!("kind" in c) || c.kind === "field") &&
        (c as { id: string }).id === "options__remaining",
    );
    expect(remaining).toBeDefined();
    const type = (remaining as { type: { kind: string; n: unknown } }).type;
    expect((type.n as { value: number }).value).toBe(6);
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
