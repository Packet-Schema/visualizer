// SLIDER-FREEZE regression (DUAL-ROLE boundedRepeat length key):
//
// A boundedRepeat's `lengthKey` is EXEMPT from PacketViewer's direct
// length-controller cap (`directLengthControllerIds`): its value drives a
// budget-DERIVED record count already capped to MAX_DERIVED_RECORDS, and
// clamping the budget in the direct-cap loop would wrongly shrink that scope.
//
// But the SAME length field often ALSO directly sizes a `bytes(ref X)` payload
// in a DIFFERENT switch arm — the generic / raw / data arm. http3Frame's
// `http3PayloadLength` budgets a `bounded` in the SETTINGS / PUSH_PROMISE arms
// yet directly sizes `data = bytes(ref http3PayloadLength)` in the DATA arm;
// dnssecRecords' `rrRdLength` budgets `rrsigSignerName` / `nsecNextDomainName`
// in the RRSIG / NSEC arms yet directly sizes `rdataRawBytes = bytes(ref
// rrRdLength)` in the `_` raw-rdata arm (reachable at the default discriminator).
// resolveLayout emits ~1 SVG cell per payload byte for that direct arm, and
// because the key escapes the cap, dragging its 16-bit slider toward 65535
// generated tens of thousands of un-virtualized cells (rrRdLength → 16390,
// http3PayloadLength → 18434) and FROZE the page — the very freeze the cap
// exists to prevent.
//
// The fix: `boundedKeysWithDirectPayload` detects these dual-role keys from the
// source AST, and PacketViewer clamps env[X] to MAX_LENGTH_CONTROLLER_BYTES
// BEFORE deriving the bounded count (so the budget and the derived count stay
// consistent — clamping AFTER leaves a maxed-budget record count against a
// 1024-byte budget and core's normalize throws `bounded over-consumed`). This
// test reproduces the pre-fix explosion and asserts the clamped path stays
// bounded for every dual-role key at the slider max, across their direct arms.

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
import { clampStaticLayoutCounts } from "@/lib/psdl/clamp-static-layout";
import { boundedKeysWithDirectPayload } from "@/lib/psdl/bounded-direct-payload-keys";
import type { Packet as RendererPacket } from "@/lib/psdl/renderer";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

// Mirror of PacketViewer's `MAX_LENGTH_CONTROLLER_BYTES` (= MAX_DERIVED_RECORDS).
const MAX_LENGTH_CONTROLLER_BYTES = 1024;
const MAX_DERIVED_RECORDS = 1024;

// Build the layout env exactly as PacketViewer's `buildLayoutEnv` does, with the
// dual-role clamp applied BEFORE the bounded-count derive when `clamp` is true.
// `clamp=false` reproduces the pre-fix path (no dual-role cap).
function cellCount(
  src: PsdlPacket,
  mirror: RendererPacket,
  dualKeys: Set<string>,
  overrides: Record<string, number>,
  clamp: boolean,
): number {
  const ctrl = { ...initialState(mirror), ...overrides };
  const base = clampStaticLayoutCounts(
    applyChainInstances(applyTlvInstances(src, mirror, {}), mirror),
    MAX_DERIVED_RECORDS,
  );
  const env = new Map<string, number>(
    Object.entries(ctrl).map(([k, v]) => [k, Number(v)]),
  );
  for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
  // DUAL-ROLE direct-payload cap, applied BEFORE the bounded derive (the fix).
  if (clamp) {
    for (const id of dualKeys) {
      const v = env.get(id);
      if (typeof v === "number" && v > MAX_LENGTH_CONTROLLER_BYTES) {
        env.set(id, MAX_LENGTH_CONTROLLER_BYTES);
      }
    }
  }
  for (const br of mirror.boundedRepeats ?? []) {
    for (const seed of br.innerScopeSeeds ?? []) {
      if (!env.get(seed.key)) env.set(seed.key, seed.value);
    }
    const budget = evalExprOr(br.bytesExpr, env, 0);
    const forRecords = Math.max(0, budget - br.prefixBytes);
    const overage = (br.innerScopeSeeds ?? []).reduce(
      (sum, seed) =>
        sum +
        Math.max(0, Number(env.get(seed.key) ?? 0) - seed.value) *
          (seed.bytesPerUnit ?? 1),
      0,
    );
    env.set(
      br.countKey,
      Math.min(
        MAX_DERIVED_RECORDS,
        Math.floor(forRecords / (br.perRecordBytes + overage)),
      ),
    );
  }
  return resolveLayout(base, { env }).cells.length;
}

function dualKeysOf(src: PsdlPacket, mirror: RendererPacket): Set<string> {
  return boundedKeysWithDirectPayload(
    src,
    (mirror.boundedRepeats ?? []).map((br) => br.lengthKey),
  );
}

describe("dual-role boundedRepeat length-key slider cell-count cap", () => {
  it("detects exactly the direct-payload-bearing bounded keys (http3Frame, dnssecRecords)", () => {
    const found: Record<string, string[]> = {};
    for (const [key, src] of Object.entries(PRESETS)) {
      const mirror = psdlToRenderer(src);
      const dual = dualKeysOf(src, mirror);
      if (dual.size > 0) found[key] = [...dual].sort();
    }
    expect(found).toEqual({
      dnssecRecords: ["rrRdLength"],
      http3Frame: ["http3PayloadLength"],
    });
  });

  it("reproduces the pre-fix freeze and confirms the clamp tames every dual-role key at the slider max", () => {
    // The two audited direct-payload-bearing bounded keys and the arm whose
    // generic/raw payload `bytes(ref X)` explodes when the slider is maxed.
    const probes: { key: string; id: string }[] = [
      { key: "http3Frame", id: "http3PayloadLength" },
      { key: "dnssecRecords", id: "rrRdLength" },
    ];
    for (const { key, id } of probes) {
      const src = PRESETS[key]!;
      expect(src, `preset ${key} should exist`).toBeTruthy();
      const mirror = psdlToRenderer(src);
      const dual = dualKeysOf(src, mirror);
      expect(
        dual.has(id),
        `${key}/${id} should be a dual-role direct-payload bounded key`,
      ).toBe(true);

      // Pre-fix: the direct `bytes(ref X)` arm emits ~1 cell/byte → explodes.
      const unclamped = cellCount(src, mirror, dual, { [id]: 65535 }, false);
      expect(
        unclamped,
        `${key}/${id} unclamped should explode`,
      ).toBeGreaterThan(10000);

      // Post-fix: the dual-role clamp keeps the diagram renderable even at the
      // full 16-bit slider max, AND never throws `bounded over-consumed`.
      const clamped = cellCount(src, mirror, dual, { [id]: 65535 }, true);
      expect(
        clamped,
        `${key}/${id} clamped must stay bounded (got ${clamped})`,
      ).toBeLessThan(1100);
      expect(
        clamped,
        `${key}/${id} clamped must be far below the explosion`,
      ).toBeLessThan(unclamped);
    }
  });

  it("clamps every dual-role key across ALL presets at the slider max without exploding or throwing", () => {
    for (const [key, src] of Object.entries(PRESETS)) {
      const mirror = psdlToRenderer(src);
      const dual = dualKeysOf(src, mirror);
      if (dual.size === 0) continue;
      const overrides: Record<string, number> = {};
      for (const id of dual) overrides[id] = 65535;
      // resolveLayout must not throw (no `bounded over-consumed`) and the cell
      // count stays renderable — the whole packet plus a 1024-byte direct arm.
      const clamped = cellCount(src, mirror, dual, overrides, true);
      expect(
        clamped,
        `${key}: clamped cell count must stay bounded (got ${clamped})`,
      ).toBeLessThan(MAX_LENGTH_CONTROLLER_BYTES * 4 + 2048);
    }
  });

  it("does NOT cap a pure bounded length key (no direct payload arm)", () => {
    // bgpUpdateFull's `bgpWithdrawnRoutesLength` budgets a bounded scope but has
    // no `bytes(ref X)` direct arm, so it must stay UNcapped (full slider range,
    // record-display UX preserved).
    const src = PRESETS.bgpUpdateFull!;
    const mirror = psdlToRenderer(src);
    const dual = dualKeysOf(src, mirror);
    expect(dual.has("bgpWithdrawnRoutesLength")).toBe(false);
    expect(dual.has("bgpTotalPathAttributeLength")).toBe(false);
  });
});
