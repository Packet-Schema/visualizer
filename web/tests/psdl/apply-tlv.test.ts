// applyTlvInstances smoke — verifies that the renderer mirror's
// `tlv.instances` are expanded into per-instance Group containers in the
// PSDL body so each Repeat iteration renders its own variant (instead of
// the env-driven single Switch dispatch that produces N copies of the
// default variant — the "Type=0 everywhere" symptom).

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { applyTlvInstances, psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import type { Container, Optional, Repeat } from "@/lib/psdl/types";

// Locate the TLV options Repeat wherever it lives in the body (the ipv4
// preset nests it inside a `bounded` wire-scope).
function findOptionsRepeat(body: Container[]): Repeat {
  for (const c of body) {
    if (c.kind === "repeat" && c.id === "options") return c;
    if (c.kind === "bounded") {
      const r = c.fields.find((f) => f.kind === "repeat" && f.id === "options");
      if (r) return r as Repeat;
    }
  }
  throw new Error("options Repeat not found");
}

describe("applyTlvInstances", () => {
  it("returns the packet unchanged when no instances and no slot bytes", () => {
    const psdl = PRESETS.ipv4!;
    const mirror = psdlToRenderer(psdl);
    const out = applyTlvInstances(psdl, mirror, {});
    expect(out).toBe(psdl);
  });

  it("emits a single bytes(N) placeholder when instances=[] and slot>0", () => {
    const psdl = PRESETS.ipv4!;
    const mirror = psdlToRenderer(psdl);
    const opt = mirror.fields.find((f) => f.id === "options");
    if (!opt?.tlv) throw new Error("options field missing tlv");
    expect(opt.tlv.instances.length).toBe(0);
    const out = applyTlvInstances(psdl, mirror, { options: 8 });
    expect(out).not.toBe(psdl);
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

  it("prefixes each instance's child ids with the Group id so duplicate variants get distinct field ids", () => {
    const psdl = PRESETS.ipv4!;
    const mirror = psdlToRenderer(psdl);
    const opt = mirror.fields.find((f) => f.id === "options");
    if (!opt?.tlv) throw new Error("options field missing tlv");
    opt.tlv.instances = [{ kind: 1 }, { kind: 1 }, { kind: 1 }];
    const out = applyTlvInstances(psdl, mirror, { options: 4 });
    const groups = out.body.filter(
      (c) => c.kind === "group" && c.id.startsWith("options__inst_"),
    );
    expect(groups).toHaveLength(3);
    const childIds = groups.flatMap((g) => {
      const children = (g as { children?: Array<{ id: string }> }).children;
      return children?.map((c) => c.id) ?? [];
    });
    expect(new Set(childIds).size).toBe(childIds.length);
    expect(childIds).toEqual([
      "options__inst_0__type",
      "options__inst_1__type",
      "options__inst_2__type",
    ]);
  });

  it("emits a trailing 'remaining' placeholder when instances total < slot", () => {
    const psdl = PRESETS.ipv4!;
    const mirror = psdlToRenderer(psdl);
    const opt = mirror.fields.find((f) => f.id === "options");
    if (!opt?.tlv) throw new Error("options field missing tlv");
    opt.tlv.instances = [{ kind: 1 }, { kind: 1 }]; // two NOPs = 2 bytes
    const out = applyTlvInstances(psdl, mirror, { options: 8 });
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
    const psdl = PRESETS.ipv4!;
    const mirror = psdlToRenderer(psdl);
    const opt = mirror.fields.find((f) => f.id === "options");
    expect(opt?.tlv).toBeDefined();
    if (!opt?.tlv) throw new Error("options field missing tlv");
    opt.tlv.instances = [{ kind: 7 }, { kind: 1 }];
    const out = applyTlvInstances(psdl, mirror);
    expect(out).not.toBe(psdl);
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

  // Codex P2: PSDL 0.5 Optional can wrap a TLV Repeat. `expand` must recurse
  // into `optional.container` or the diagram shows the raw Repeat.
  it("expands a TLV Repeat nested inside an Optional (populated → Group of instances)", () => {
    const psdl = PRESETS.ipv4!;
    const mirror = psdlToRenderer(psdl);
    const opt = mirror.fields.find((f) => f.id === "options");
    if (!opt?.tlv) throw new Error("options field missing tlv");
    opt.tlv.instances = [{ kind: 7 }, { kind: 1 }];

    // Rebuild the body with the options Repeat wrapped in an Optional rather
    // than its native `bounded` wire-scope.
    const repeat = findOptionsRepeat(psdl.body);
    const optional: Optional = {
      kind: "optional",
      id: "optsOptional",
      when: { kind: "lit", value: 1 },
      container: repeat,
    };
    const wrapped = {
      ...psdl,
      body: psdl.body.map((c) =>
        c.kind === "bounded" &&
        c.fields.some((f) => f.kind === "repeat" && f.id === "options")
          ? optional
          : c,
      ),
    };

    const out = applyTlvInstances(wrapped, mirror);
    expect(out).not.toBe(wrapped);
    const outer = out.body.find(
      (c) => c.kind === "optional" && c.id === "optsOptional",
    ) as Optional | undefined;
    expect(outer).toBeDefined();
    // Multiple expanded containers (the per-instance Groups) collapse into a
    // single Group so the Optional keeps wrapping exactly one container.
    const inner = outer!.container as {
      kind: string;
      id: string;
      children: Container[];
    };
    expect(inner.kind).toBe("group");
    expect(inner.id).toBe("optsOptional__opt");
    const groups = inner.children.filter(
      (c) => c.kind === "group" && c.id.startsWith("options__inst_"),
    );
    expect(groups).toHaveLength(2);
  });

  it("expands a TLV Repeat nested inside an Optional (slot only → single placeholder kept under the Optional)", () => {
    const psdl = PRESETS.ipv4!;
    const mirror = psdlToRenderer(psdl);
    const opt = mirror.fields.find((f) => f.id === "options");
    if (!opt?.tlv) throw new Error("options field missing tlv");
    expect(opt.tlv.instances.length).toBe(0);

    const repeat = findOptionsRepeat(psdl.body);
    const optional: Optional = {
      kind: "optional",
      id: "optsOptional",
      when: { kind: "lit", value: 1 },
      container: repeat,
    };
    const wrapped = {
      ...psdl,
      body: psdl.body.map((c) =>
        c.kind === "bounded" &&
        c.fields.some((f) => f.kind === "repeat" && f.id === "options")
          ? optional
          : c,
      ),
    };

    const out = applyTlvInstances(wrapped, mirror, { options: 8 });
    const outer = out.body.find(
      (c) => c.kind === "optional" && c.id === "optsOptional",
    ) as Optional | undefined;
    expect(outer).toBeDefined();
    // Single expanded container → the Optional wraps it directly (no Group).
    const inner = outer!.container as { id: string; type: { kind: string } };
    expect(inner.id).toBe("options");
    expect(inner.type.kind).toBe("bytes");
  });
});
