// override-design-audit: core gives a varint or delimiter-terminated `bytes`
// field 0 bits when its width env key is unset, so it renders as NO cell —
// invisible, with its width picker (on the missing cell) unreachable. The seed
// gives them a representative default width so they always paint.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { seedDynamicWidthDefaults } from "@/lib/psdl/dynamic-width-defaults";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

function cellIds(src: PsdlPacket, overrides: Record<string, number> = {}) {
  const env = new Map<string, number>(Object.entries(overrides));
  for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
  seedDynamicWidthDefaults(src, env);
  return resolveLayout(src, { env }).cells.map((c) => c.field.id);
}

describe("seedDynamicWidthDefaults", () => {
  it("makes varint fields visible on default load (http3Frame)", () => {
    const ids = cellIds(PRESETS.http3Frame!);
    expect(ids).toContain("http3FrameType");
    expect(ids).toContain("http3PayloadLength");
  });

  it("makes switch-nested varints visible when their case is active (quicLong)", () => {
    // length lives in the longPacketType cases; selecting one paints it.
    const ids = cellIds(PRESETS.quicLong!, { longPacketType: 0 });
    expect(ids).toContain("length");
  });

  it("makes delimiter-terminated bytes fields visible (syslog)", () => {
    expect(cellIds(PRESETS.syslog!)).toContain("hostname");
  });

  it("a user-set width still wins over the seed", () => {
    // Setting http3FrameType to 2 bytes (16 bits) must render 16, not the 8 seed.
    const env = new Map<string, number>([["http3FrameType", 16]]);
    const src = PRESETS.http3Frame!;
    for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
    for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
    seedDynamicWidthDefaults(src, env);
    const cell = resolveLayout(src, { env }).cells.find(
      (c) => c.field.id === "http3FrameType",
    );
    expect(cell?.field.bits).toBe(16);
  });
});
