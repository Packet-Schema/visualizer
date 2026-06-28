// MULTIPLICATIVE-FREEZE regression: PacketViewer's per-control freeze caps each
// bound ONE control to MAX_DERIVED_RECORDS (a freeRepeat count, a bounded-derived
// count, a direct length byte-count). None of them bounded the PRODUCT of several
// controls that the layout MULTIPLIES together:
//
//   * a repeat nested inside another repeat — dnsResponse's
//     `dnsQuestions{count=ref dnsQdCount}` contains `dnsQNameLabels{until}`, BOTH
//     surfaced as independent freeRepeat steppers. With each at its own 1024 cap
//     the product is 1024×1024 ≈ 1.05M cells, ~26s in resolveLayout → a hard
//     browser freeze / OOM reachable by dragging two surfaced steppers.
//   * a repeat count times a per-record length controller — diameter
//     (diameterAvps × avpLength), dhcpv6 / dhcpv6Relay (options × optionLen).
//
// The fix adds a PRODUCT-aware budget in PacketViewer's layout memo: every
// layout-multiplying driver (bounded-derived counts, freeRepeat counts, and —
// against the leftover budget — direct length byte-counts) is walked against a
// single shrinking `MAX_DERIVED_PRODUCT` budget, so their product can never
// exceed the already-accepted single-maxed-control cell count. The controller
// VALUES stay user-editable; only the layout env fed to resolveLayout is clamped.
//
// This test reproduces the pre-fix explosion and asserts the product-clamped env
// keeps resolveLayout's cell count bounded with EVERY surfaced control maxed.

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
import type { Field, Packet as RendererPacket } from "@/lib/psdl/renderer";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

// Mirrors of PacketViewer's freeze ceilings.
const MAX_DERIVED_RECORDS = 1024;
const MAX_LENGTH_CONTROLLER_BYTES = MAX_DERIVED_RECORDS;
const MAX_DERIVED_PRODUCT = MAX_DERIVED_RECORDS;

// Env keys that DIRECTLY size a `bytes(ref X)` payload (a lengthController surface
// or a `controlsLength`-stamped cell), EXCLUDING boundedRepeat lengthKeys.
function directLengthControllerIds(mirror: RendererPacket): Set<string> {
  const boundedKeys = new Set(
    (mirror.boundedRepeats ?? []).map((br) => br.lengthKey),
  );
  const ids = new Set<string>();
  for (const lc of mirror.lengthControllers ?? []) {
    if (lc.controlsLength && !boundedKeys.has(lc.controlsLength)) {
      ids.add(lc.controlsLength);
    }
  }
  for (const f of mirror.fields) {
    if (f.controlsLength && !boundedKeys.has(f.controlsLength)) {
      ids.add(f.controlsLength);
    }
  }
  return ids;
}

function sliderMax(field: Field): number {
  return (
    field.max ?? (typeof field.bits === "number" ? 2 ** field.bits - 1 : 255)
  );
}

// Faithfully rebuild PacketViewer's layout env from the renderer mirror.
// `product=true` applies the production PRODUCT-aware clamp; `product=false`
// applies ONLY the old per-key caps (reproducing the pre-fix multiplicative
// explosion). Returns the resolveLayout cell count.
function cellCount(
  src: PsdlPacket,
  mirror: RendererPacket,
  overrides: Record<string, number>,
  product: boolean,
): number {
  const ctrl = { ...initialState(mirror), ...overrides };
  const base = applyChainInstances(applyTlvInstances(src, mirror, {}), mirror);
  const env = new Map<string, number>(
    Object.entries(ctrl).map(([k, v]) => [k, Number(v)]),
  );
  for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);

  let budget = MAX_DERIVED_PRODUCT;
  const factor = (value: number, perKeyCap: number): number => {
    const capped = product
      ? Math.max(0, Math.min(value, perKeyCap, budget))
      : Math.max(0, Math.min(value, perKeyCap));
    if (product) budget = Math.max(1, Math.floor(budget / Math.max(1, capped)));
    return capped;
  };

  for (const br of mirror.boundedRepeats ?? []) {
    for (const seed of br.innerScopeSeeds ?? []) {
      if (!env.get(seed.key)) env.set(seed.key, seed.value);
    }
    const b = evalExprOr(br.bytesExpr, env, 0);
    const forRecords = Math.max(0, b - br.prefixBytes);
    env.set(
      br.countKey,
      factor(Math.floor(forRecords / br.perRecordBytes), MAX_DERIVED_RECORDS),
    );
  }
  for (const fr of mirror.freeRepeats ?? []) {
    const v = env.get(fr.countKey);
    if (typeof v !== "number") continue;
    const mul = fr.transform?.mul ?? 1;
    const add = fr.transform?.add ?? 0;
    const recordCount = v * mul + add;
    const allowed = factor(recordCount, MAX_DERIVED_RECORDS);
    if (allowed !== recordCount) {
      env.set(fr.countKey, Math.max(0, Math.floor((allowed - add) / mul)));
    }
  }
  const directCap = product
    ? Math.min(MAX_LENGTH_CONTROLLER_BYTES, budget)
    : MAX_LENGTH_CONTROLLER_BYTES;
  for (const id of directLengthControllerIds(mirror)) {
    const v = env.get(id);
    if (typeof v === "number" && v > directCap) env.set(id, directCap);
  }

  return resolveLayout(base, { env }).cells.length;
}

// Drive every surfaced count/length control to the worst value a user can
// request through the panel (the stepper / slider max).
function maxAllOverrides(mirror: RendererPacket): Record<string, number> {
  const o: Record<string, number> = {};
  for (const fr of mirror.freeRepeats ?? []) o[fr.countKey] = 65535;
  for (const br of mirror.boundedRepeats ?? []) o[br.lengthKey] = 65535;
  for (const id of directLengthControllerIds(mirror)) {
    const f =
      (mirror.lengthControllers ?? []).find((l) => l.controlsLength === id) ??
      mirror.fields.find((field) => field.controlsLength === id);
    o[id] = f ? sliderMax(f) : 65535;
  }
  return o;
}

describe("nested / per-record repeat product cell-count cap", () => {
  it("reproduces dnsResponse's nested-repeat explosion and confirms the product clamp tames it", () => {
    const src = PRESETS.dnsResponse!;
    const mirror = psdlToRenderer(src);

    // Both steppers are surfaced as independent freeRepeats.
    const frKeys = (mirror.freeRepeats ?? []).map((f) => f.countKey);
    expect(frKeys).toContain("dnsQdCount");
    expect(frKeys).toContain("dnsQNameLabels");

    // Pre-fix: even a MODEST product already over-explodes (the full 1024×1024
    // OOMs the worker, so probe at a small product that still proves the blow-up).
    const unclamped = cellCount(
      src,
      mirror,
      { dnsQdCount: 200, dnsQNameLabels: 200, dnsLabelLen: 2 },
      false,
    );
    expect(
      unclamped,
      "nested product unclamped should explode",
    ).toBeGreaterThan(20000);

    // Post-fix: both steppers driven to the URL/import-reachable extreme stays
    // renderable because the PRODUCT of derived counts is bounded.
    const clamped = cellCount(src, mirror, maxAllOverrides(mirror), true);
    expect(
      clamped,
      "product-clamped dnsResponse must stay bounded",
    ).toBeLessThan(unclamped);
    expect(
      clamped,
      "product-clamped dnsResponse must be renderable",
    ).toBeLessThanOrEqual(MAX_DERIVED_PRODUCT * 64);
  });

  it("bounds the cell count for every preset with ALL surfaced count/length controls maxed simultaneously", () => {
    for (const [key, src] of Object.entries(PRESETS)) {
      const mirror = psdlToRenderer(src);
      const hasControls =
        (mirror.freeRepeats?.length ?? 0) +
          (mirror.boundedRepeats?.length ?? 0) +
          directLengthControllerIds(mirror).size >
        0;
      if (!hasControls) continue;

      const clamped = cellCount(src, mirror, maxAllOverrides(mirror), true);
      // The product of all derived drivers is bounded by MAX_DERIVED_PRODUCT; each
      // record/byte emits a small fixed number of cells, plus the packet's own
      // cells and any additive sibling controls. A generous renderable ceiling.
      expect(
        clamped,
        `${key}: product-clamped cell count must stay renderable (got ${clamped})`,
      ).toBeLessThanOrEqual(MAX_DERIVED_PRODUCT * 64 + 4096);
    }
  });

  it("bounds the repeat × per-record-length product (diameter, dhcpv6, dhcpv6Relay)", () => {
    for (const key of ["diameter", "dhcpv6", "dhcpv6Relay"]) {
      const src = PRESETS[key]!;
      const mirror = psdlToRenderer(src);

      // Pre-fix: a repeat count × its per-record length multiplies.
      const overrides: Record<string, number> = {};
      for (const fr of mirror.freeRepeats ?? []) overrides[fr.countKey] = 200;
      for (const id of directLengthControllerIds(mirror)) overrides[id] = 200;
      const unclamped = cellCount(src, mirror, overrides, false);

      const clamped = cellCount(src, mirror, maxAllOverrides(mirror), true);
      expect(
        clamped,
        `${key}: product clamp must keep the diagram renderable`,
      ).toBeLessThanOrEqual(MAX_DERIVED_PRODUCT * 64 + 4096);
      expect(
        clamped,
        `${key}: product clamp must beat the unclamped explosion`,
      ).toBeLessThanOrEqual(Math.max(unclamped, MAX_DERIVED_PRODUCT * 64));
    }
  });
});
