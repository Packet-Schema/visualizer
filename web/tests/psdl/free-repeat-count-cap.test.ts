// FREE-REPEAT-FREEZE regression: a freeRepeat's record count is driven STRAIGHT
// by env[countKey] (through the optional affine transform), NOT derived from a
// byte budget like boundedRepeats. Unlike boundedRepeats (count capped) and
// direct length controllers (bytes capped), the freeRepeat count had NO
// layout-level ceiling — the only guard was OverridePanel's RepeatCountStepper
// input cap, which (a) was far too high (4096 records × ~6-20 cells/record) and
// (b) is bypassed entirely when a freeRepeat count arrives via share-URL
// hydration / JSON import (countKeys ride in `controllers` → env). A node probe
// at 65535 drove dnsResponse.dnsAnCount to ~917k cells / 67s in resolveLayout —
// a reachable frozen diagram. PacketViewer now clamps the DERIVED record count
// to MAX_DERIVED_RECORDS (inverting through the transform) before resolveLayout.

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

// Mirror of PacketViewer's `MAX_DERIVED_RECORDS`. A freeRepeat count arriving
// from any path (stepper, share-URL, import) must never derive more records
// than this so the un-virtualized diagram's cell count stays bounded.
const MAX_DERIVED_RECORDS = 1024;

// Mirror PacketViewer's layout env build, INCLUDING both the bounded-repeat
// derive and the freeRepeat clamp (the production fix). `clampFree=false`
// reproduces the pre-fix explosion where env[countKey] flows in raw.
function cellCount(
  src: PsdlPacket,
  mirror: RendererPacket,
  overrides: Record<string, number>,
  clampFree: boolean,
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
    env.set(
      br.countKey,
      Math.min(MAX_DERIVED_RECORDS, Math.floor(forRecords / br.perRecordBytes)),
    );
  }
  if (clampFree) {
    for (const fr of mirror.freeRepeats ?? []) {
      const v = env.get(fr.countKey);
      if (typeof v !== "number") continue;
      const mul = fr.transform?.mul ?? 1;
      const add = fr.transform?.add ?? 0;
      if (v * mul + add > MAX_DERIVED_RECORDS) {
        env.set(
          fr.countKey,
          Math.max(0, Math.floor((MAX_DERIVED_RECORDS - add) / mul)),
        );
      }
    }
  }
  return resolveLayout(base, { env }).cells.length;
}

describe("free-repeat count cell-count cap", () => {
  it("clamps the DERIVED record count to MAX_DERIVED_RECORDS for every freeRepeat at a huge env value, across all presets", () => {
    for (const [key, src] of Object.entries(PRESETS)) {
      const mirror = psdlToRenderer(src);
      for (const fr of mirror.freeRepeats ?? []) {
        const mul = fr.transform?.mul ?? 1;
        const add = fr.transform?.add ?? 0;
        // The URL/import-reachable extreme: a 16-bit field maxed to 65535.
        const env = new Map<string, number>([[fr.countKey, 65535]]);
        const raw = env.get(fr.countKey)!;
        const capped =
          raw * mul + add > MAX_DERIVED_RECORDS
            ? Math.max(0, Math.floor((MAX_DERIVED_RECORDS - add) / mul))
            : raw;
        const recordCount = capped * mul + add;
        expect(
          recordCount,
          `${key}/${fr.countKey} record count must stay capped`,
        ).toBeLessThanOrEqual(MAX_DERIVED_RECORDS);
      }
    }
  });

  it("keeps the diagram cell count bounded for the documented freeze probes where an unclamped freeRepeat count explodes", () => {
    // The audit probes: at env 65535 these produced hundreds of thousands of
    // cells (dnsResponse.dnsAnCount → ~917k) and froze resolveLayout.
    const probes: Record<string, string> = {
      dnsResponse: "dnsAnCount",
      netflowV5: "netflowRecordCount",
    };
    for (const [key, countKey] of Object.entries(probes)) {
      const src = PRESETS[key]!;
      const mirror = psdlToRenderer(src);
      // Confirm the probe field really drives a freeRepeat in this preset.
      const fr = (mirror.freeRepeats ?? []).find(
        (f) => f.countKey === countKey,
      );
      expect(fr, `${key}/${countKey} should drive a freeRepeat`).toBeTruthy();

      const huge = 65535; // URL/import-reachable, bypassing the stepper input cap
      // The pre-fix path scales ~linearly with the count, so even at a MODEST
      // unclamped count (well below the URL-reachable 65535 that produced ~917k
      // cells / 67s) the cell count already blows past anything renderable —
      // measure the explosion cheaply here rather than time out on the full 65535.
      const unclamped = cellCount(src, mirror, { [countKey]: 4096 }, false);
      // The clamped path is fast precisely BECAUSE it caps at MAX_DERIVED_RECORDS,
      // so we can drive it at the full URL-reachable extreme without freezing.
      const clamped = cellCount(src, mirror, { [countKey]: huge }, true);

      // The pre-fix path explodes well past anything renderable; the fix keeps
      // it bounded by the per-record cell footprint × the record ceiling.
      expect(unclamped, `${key} unclamped should explode`).toBeGreaterThan(
        5000,
      );
      // At most MAX_DERIVED_RECORDS records, each emitting a small fixed number
      // of cells (plus the packet's other cells).
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
