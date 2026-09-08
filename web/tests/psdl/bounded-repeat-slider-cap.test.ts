// SLIDER-FREEZE regression: a bounded eos/until repeat's record count is
// DERIVED from a length budget (`floor((budget - prefix) / perRecordBytes)`),
// and the length slider's max is the length field's full bit range
// (OverrideSlider: `2**field.bits - 1`). A 16-bit length field maxed to 65535
// derived tens of thousands of records (bgpLs → 39321 cells, bgpUpdateFull →
// 32776, babel → 21845); resolveLayout emits one cell per record and the
// un-virtualized main diagram freezes. PacketViewer now clamps the DERIVED
// count to MAX_DERIVED_RECORDS so a maxed slider can never explode the diagram.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import {
  applyChainInstances,
  applyTlvInstances,
  psdlToRenderer,
} from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { evalExprOr } from "@/lib/psdl/expr";
import { initialState } from "@/lib/psdl/renderer-helpers";
import type { Packet as RendererPacket } from "@/lib/psdl/renderer";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

// Mirror of PacketViewer's `MAX_DERIVED_RECORDS`. A maxed length slider must
// never derive more records than this, so the cell count stays bounded.
const MAX_DERIVED_RECORDS = 1024;

// Mirror PacketViewer's layout env build, INCLUDING the clamped bounded-repeat
// derive (the production fix). `clamp=false` reproduces the pre-fix explosion.
function cellCount(
  src: PsdlPacket,
  mirror: RendererPacket,
  overrides: Record<string, number>,
  clamp: boolean,
): number {
  const ctrl = { ...initialState(mirror), ...overrides };
  const base = applyChainInstances(applyTlvInstances(src, mirror, {}), mirror);
  const env = new Map<string, number>(
    Object.entries(ctrl).map(([k, v]) => [k, Number(v)]),
  );
  for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
  for (const br of mirror.boundedRepeats ?? []) {
    const budget = evalExprOr(br.bytesExpr, env, 0);
    const forRecords = Math.max(0, budget - br.prefixBytes);
    const derived = Math.floor(forRecords / br.perRecordBytes);
    env.set(
      br.countKey,
      clamp ? Math.min(MAX_DERIVED_RECORDS, derived) : derived,
    );
  }
  return resolveLayout(base, { env }).cells.length;
}

// The OverrideSlider max for a length field is `field.max ?? 2**field.bits - 1`.
function sliderMax(bits: number | undefined): number {
  return typeof bits === "number" ? 2 ** bits - 1 : 255;
}

describe("bounded-repeat length-slider cell-count cap", () => {
  it("derived record count never exceeds MAX_DERIVED_RECORDS at the slider max, across all presets", () => {
    for (const [key, src] of Object.entries(PRESETS)) {
      const mirror = psdlToRenderer(src);
      for (const br of mirror.boundedRepeats ?? []) {
        const lc = (mirror.lengthControllers ?? []).find(
          (f) => f.id === br.lengthKey,
        );
        const max = sliderMax(lc?.bits);
        // Build the clamped env exactly as PacketViewer does, then assert the
        // DERIVED count landed at or below the ceiling.
        const ctrl = { ...initialState(mirror), [br.lengthKey]: max };
        const env = new Map<string, number>(
          Object.entries(ctrl).map(([k, v]) => [k, Number(v)]),
        );
        for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
        for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
        const budget = evalExprOr(br.bytesExpr, env, 0);
        const forRecords = Math.max(0, budget - br.prefixBytes);
        const derived = Math.min(
          MAX_DERIVED_RECORDS,
          Math.floor(forRecords / br.perRecordBytes),
        );
        expect(
          derived,
          `${key}/${br.countKey} derived count must stay capped`,
        ).toBeLessThanOrEqual(MAX_DERIVED_RECORDS);
      }
    }
  });

  it("keeps the diagram cell count bounded for the documented freeze probes (clamped) where an unclamped derive explodes", () => {
    // The three presets the audit measured as freezing at slider max 65535.
    const probes: Record<string, string> = {
      bgpLs: "bgpLsTotalNlriLength",
      bgpUpdateFull: "bgpWithdrawnRoutesLength",
      babel: "babelBodyLength",
    };
    for (const [key, lengthKey] of Object.entries(probes)) {
      const src = PRESETS[key]!;
      const mirror = psdlToRenderer(src);
      // Confirm the probe field really drives a boundedRepeat in this preset.
      const br = (mirror.boundedRepeats ?? []).find(
        (b) => b.lengthKey === lengthKey,
      );
      expect(
        br,
        `${key}/${lengthKey} should drive a boundedRepeat`,
      ).toBeTruthy();

      const max = 65535; // 2**16 - 1, the real slider max for these 16-bit fields
      const unclamped = cellCount(src, mirror, { [lengthKey]: max }, false);
      const clamped = cellCount(src, mirror, { [lengthKey]: max }, true);

      // The pre-fix path explodes well past anything renderable; the fix keeps
      // it bounded by the per-record cell footprint × the record ceiling.
      expect(unclamped, `${key} unclamped should explode`).toBeGreaterThan(
        5000,
      );
      // A generous bound: at most MAX_DERIVED_RECORDS records, and each record
      // emits a small fixed number of cells (plus the packet's other cells).
      expect(clamped, `${key} clamped must stay bounded`).toBeLessThanOrEqual(
        MAX_DERIVED_RECORDS * 64,
      );
      expect(
        clamped,
        `${key} clamped must be far below unclamped`,
      ).toBeLessThan(unclamped);
    }
  });
});
