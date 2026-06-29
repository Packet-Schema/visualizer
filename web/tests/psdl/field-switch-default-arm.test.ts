// Regression — a FIELD-LEVEL `switchCases` picker must be able to select a
// structurally distinct `_` default arm.
//
// The field-level switchCases path (psdl-to-renderer/index.ts) stamps
// `field.switchCases` from ONLY the listed (numeric) case keys. Unlike the
// peek-switch path it historically never appended a `defaultArmSyntheticCase`,
// so when a Switch's `_` arm differs structurally from every listed arm the
// dropdown offered only the listed values and the `_` arm was unreachable.
//
// For a discriminator field that carries NO `enumVariants` there is no other
// control on that env key, so a STRUCTURALLY-DISTINCT `_` arm rendered on the
// diagram but could not be selected — and an imported packet whose
// discriminator falls into `_` could not round-trip-select.
//
// icmpv6Ndp `type` (no enum) is the see-but-cannot-edit case: an unlisted type
// renders the `_` arm `ndpOpaque` (a `bytes(remaining)` blob distinct from
// every listed option arm), but the picker offered only {133..137}. The fix
// (mirroring the peek path: `defaultArmSyntheticCase` + `unshift`) adds a
// default-arm option whose sentinel value routes through core's `selectArm`
// to `_` and renders `ndpOpaque`.
//
// http3Frame `http3FrameType` is the deliberately-NOT-synthesised counterpart:
// its `_` arm `payload` is `bytes(ref http3PayloadLength)` — structurally
// IDENTICAL to listed cases 0 (`data`) / 1 (`headerBlock`). Selecting case 0
// already produces the byte-identical diagram, so — exactly as the peek path's
// structural-distinctness gate decides — no redundant synthetic option is
// added, yet the `_`-arm layout is still fully representable through case 0.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { resolveLayout } from "@/lib/psdl/layout";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { seedDynamicWidthDefaults } from "@/lib/psdl/dynamic-width-defaults";
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

function cellIds(src: PsdlPacket, env: Map<string, number>): string[] {
  return resolveLayout(src, { env }).cells.map((c) => c.field.id);
}

describe("field-level switchCases picker reaches the `_` default arm", () => {
  it("http3Frame http3FrameType `_` arm is byte-equivalent to listed case 0 (no redundant synthetic option, fully representable)", () => {
    const src = PRESETS.http3Frame!;
    const field = psdlToRenderer(src).fields.find(
      (f) => f.id === "http3FrameType",
    )!;
    expect(field, "http3FrameType field").toBeDefined();
    // No enum on the same env key, so the switchCases picker is the ONLY control.
    expect(field.enumVariants ?? null).toBeNull();

    // The picker still surfaces the listed cases.
    const values = (field.switchCases ?? []).map((c) => c.value);
    expect(values.length).toBeGreaterThanOrEqual(2);

    // The `_` arm `payload` and listed case 0 `data` are both
    // `bytes(ref http3PayloadLength)`: structurally identical. An unlisted
    // discriminator renders `payload`; case 0 renders `data` — but at the SAME
    // byte layout (same field count, same widths), so the `_` arm is
    // representable through case 0 and no redundant synthetic option is added.
    const listed = new Set([0, 1, 3, 4, 5, 7, 13]);
    expect(values.every((v) => listed.has(v))).toBe(true);

    const unlisted = resolveLayout(src, {
      env: seededEnv(src, { http3FrameType: 99 }),
    }).cells;
    const case0 = resolveLayout(src, {
      env: seededEnv(src, { http3FrameType: 0 }),
    }).cells;
    expect(unlisted.map((c) => c.field.id)).toContain("payload");
    expect(case0.map((c) => c.field.id)).toContain("data");
    // Byte-identical: same number of cells and same per-cell widths.
    expect(unlisted.map((c) => c.field.bits)).toEqual(
      case0.map((c) => c.field.bits),
    );
  });

  it("icmpv6Ndp type offers a default-arm option that renders `ndpOpaque`", () => {
    const src = PRESETS.icmpv6Ndp!;
    const field = psdlToRenderer(src).fields.find((f) => f.id === "type")!;
    expect(field, "type field").toBeDefined();
    expect(field.enumVariants ?? null).toBeNull();

    const values = (field.switchCases ?? []).map((c) => c.value);
    expect(values.length).toBeGreaterThanOrEqual(2);
    const listed = new Set([133, 134, 135, 136, 137]);
    const sentinel = values.find((v) => !listed.has(v));
    expect(sentinel, "synthetic default-arm option").toBeDefined();

    expect(cellIds(src, seededEnv(src, { type: 133 }))).not.toContain(
      "ndpOpaque",
    );
    const def = cellIds(src, seededEnv(src, { type: sentinel! }));
    expect(def).toContain("ndpOpaque");
  });
});
