// override-design-audit: http3Frame's `http3FrameType` is a quic varint that is
// ALSO the discriminator of `switch http3FramePayload on=ref(http3FrameType)`.
// The single `env[http3FrameType]` key was overloaded between the discriminator
// VALUE (which case core selects) and the varint's wire WIDTH (bridged into
// `__varintBits__http3FrameType`). That collision (a) made picking frame type 5
// freeze the diagram — the varint went 5 bits wide, misaligning the cursor so
// case-5's `bytes(remaining)` threw and PacketViewer reverted; (b) painted the
// frameType cell at a width equal to the chosen value (type 7 → 7 bits, never a
// valid varint width); and (c) seeded the discriminator to 8 (no defined case),
// rendering the `_` fallthrough arm while the picker claimed case 0.
//
// The fix decouples the two roles: the discriminator value lives on
// `env[http3FrameType]`, the wire width on `__varintBits__http3FrameType`
// (seeded byte-aligned, never copied from the value), and the WidthPicker is
// suppressed on a field that is a switch `on:ref` target.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { resolveLayout } from "@/lib/psdl/layout";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { initialEnv, varintBitsEnvKey } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import {
  collectSwitchOnRefIds,
  seedDynamicWidthDefaults,
} from "@/lib/psdl/dynamic-width-defaults";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

function seededEnv(
  src: PsdlPacket,
  overrides: Record<string, number> = {},
): Map<string, number> {
  const env = new Map<string, number>(Object.entries(overrides));
  for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
  seedDynamicWidthDefaults(src, env);
  return env;
}

function frameTypeBits(src: PsdlPacket, env: Map<string, number>): number {
  const cell = resolveLayout(src, { env }).cells.find(
    (c) => c.field.id === "http3FrameType",
  );
  return cell?.field.bits ?? -1;
}

describe("http3Frame varint discriminator decoupling", () => {
  const src = (): PsdlPacket => PRESETS.http3Frame!;

  it("selecting PUSH_PROMISE (type 5) does not throw / freeze the diagram", () => {
    expect(() =>
      resolveLayout(src(), { env: seededEnv(src(), { http3FrameType: 5 }) }),
    ).not.toThrow();
    // case-5 payload (Push ID + the remaining-sized field section) renders.
    const ids = resolveLayout(src(), {
      env: seededEnv(src(), { http3FrameType: 5 }),
    }).cells.map((c) => c.field.id);
    expect(ids).toContain("pushId");
    expect(ids).toContain("pushHeaderBlock");
  });

  it("frameType cell width is independent of the selected frame type", () => {
    const widths = [0, 1, 3, 4, 5, 7, 13].map((t) =>
      frameTypeBits(src(), seededEnv(src(), { http3FrameType: t })),
    );
    // Every type resolves to the SAME (byte-aligned) varint width — never the
    // discriminator value (1, 3, 7, 13 are not valid varint widths).
    expect(new Set(widths)).toEqual(new Set([8]));
  });

  it("the dynamic-width seed leaves the discriminator value free", () => {
    const env = seededEnv(src());
    // Width seeded on the dedicated key, NOT onto the value key.
    expect(env.get(varintBitsEnvKey("http3FrameType"))).toBe(8);
    // Base discriminator resolves to a DEFINED case (DATA = 0), so the picker
    // label matches the diagram instead of falling through to the `_` arm.
    const ids = resolveLayout(src(), { env }).cells.map((c) => c.field.id);
    expect(ids).toContain("data");
    expect(ids).not.toContain("payload");
  });

  it("the discriminator field surfaces a case picker but no WidthPicker", () => {
    const field = psdlToRenderer(src()).fields.find(
      (f) => f.id === "http3FrameType",
    )!;
    expect(field.switchCases?.length).toBe(7);
    expect(field.varintEncoding).toBeUndefined();
    expect(field.isBerLength).toBeUndefined();
    expect(field.isDelimited).toBeUndefined();
  });

  it("http3Frame is the only preset whose dynamic-width field is a switch discriminator", () => {
    const affected: string[] = [];
    for (const [name, p] of Object.entries(PRESETS)) {
      if (!p) continue;
      if (
        collectSwitchOnRefIds(p).has("http3FrameType") &&
        name === "http3Frame"
      )
        affected.push(name);
    }
    expect(affected).toEqual(["http3Frame"]);
    // And the discriminator id is genuinely collected.
    expect(collectSwitchOnRefIds(src()).has("http3FrameType")).toBe(true);
  });
});
