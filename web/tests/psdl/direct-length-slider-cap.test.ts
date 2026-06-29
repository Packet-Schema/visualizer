// SLIDER-FREEZE regression (DIRECT length-controller category): a
// `lengthController` / `controlsLength` cell that sizes a DIRECT `bytes(ref X)`
// payload is surfaced as an OverrideSlider whose max is the length field's full
// int range (`field.max ?? 2**bits - 1`, up to 2**32-1 for 32-bit fields). The
// PacketViewer layout memo maps `controllers[X]` straight into `env[X]` and calls
// resolveLayout, which emits ~1 diagram cell per payload byte — so dragging that
// slider toward its max generates millions-to-billions of cells in the
// un-virtualized SVG diagram and the page freezes / V8 heap OOM-crashes.
//
// The boundedRepeat freeze class was already capped (bounded-repeat-slider-cap),
// but the DIRECT-length category was left unguarded. PacketViewer now clamps the
// EFFECTIVE byte count used for layout (env[X]) for any direct length controller
// to MAX_LENGTH_CONTROLLER_BYTES, and OverridePanel lowers the slider max to the
// same ceiling — the length CELL value stays user-editable; only the layout env /
// slider max is capped. This test reproduces the pre-fix explosion and asserts
// the clamped path stays bounded across ALL presets.

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

// Mirror of PacketViewer's `MAX_LENGTH_CONTROLLER_BYTES` (= MAX_DERIVED_RECORDS).
// A direct length controller's layout env value must never exceed this, so the
// payload's cell count stays renderable.
const MAX_LENGTH_CONTROLLER_BYTES = 1024;

// The OverrideSlider max for a length field is `field.max ?? 2**field.bits - 1`.
function sliderMax(field: Field): number {
  return (
    field.max ?? (typeof field.bits === "number" ? 2 ** field.bits - 1 : 255)
  );
}

// Every env key that DIRECTLY sizes a `bytes(ref X)` payload (a lengthController
// surface or a `controlsLength`-stamped cell), EXCLUDING boundedRepeat lengthKeys
// (those drive a budget-derived count capped elsewhere).
function directLengthControllers(
  mirror: RendererPacket,
): { id: string; field: Field }[] {
  const boundedKeys = new Set(
    (mirror.boundedRepeats ?? []).map((br) => br.lengthKey),
  );
  const out = new Map<string, Field>();
  for (const lc of mirror.lengthControllers ?? []) {
    if (lc.controlsLength && !boundedKeys.has(lc.controlsLength)) {
      out.set(lc.controlsLength, lc);
    }
  }
  for (const f of mirror.fields) {
    if (f.controlsLength && !boundedKeys.has(f.controlsLength)) {
      // Prefer an explicit lengthController surface if one already mapped the id.
      if (!out.has(f.controlsLength)) out.set(f.controlsLength, f);
    }
  }
  return [...out].map(([id, field]) => ({ id, field }));
}

// Build the layout env exactly as PacketViewer does, optionally applying the
// production direct-length clamp. `clamp=false` reproduces the pre-fix path.
function cellCount(
  src: PsdlPacket,
  mirror: RendererPacket,
  ids: string[],
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
    for (const seed of br.innerScopeSeeds ?? []) {
      if (!env.get(seed.key)) env.set(seed.key, seed.value);
    }
    const budget = evalExprOr(br.bytesExpr, env, 0);
    const forRecords = Math.max(0, budget - br.prefixBytes);
    // Charge the live overage of each surfaced per-record length above its seed
    // (mirrors PacketViewer.buildLayoutEnv) so a maxed flat-TLV inner-length
    // controller shrinks the derived count instead of over-consuming the scope.
    const overage = (br.innerScopeSeeds ?? []).reduce(
      (sum, seed) =>
        sum +
        Math.max(0, Number(env.get(seed.key) ?? 0) - seed.value) *
          (seed.bytesPerUnit ?? 1),
      0,
    );
    env.set(
      br.countKey,
      Math.min(1024, Math.floor(forRecords / (br.perRecordBytes + overage))),
    );
  }
  if (clamp) {
    for (const id of ids) {
      const v = env.get(id);
      if (typeof v === "number" && v > MAX_LENGTH_CONTROLLER_BYTES) {
        env.set(id, MAX_LENGTH_CONTROLLER_BYTES);
      }
    }
  }
  return resolveLayout(base, { env }).cells.length;
}

describe("direct length-controller slider cell-count cap", () => {
  it("clamps every direct length controller's layout env to MAX_LENGTH_CONTROLLER_BYTES at the slider max, across all presets", () => {
    for (const [key, src] of Object.entries(PRESETS)) {
      const mirror = psdlToRenderer(src);
      const controllers = directLengthControllers(mirror);
      if (controllers.length === 0) continue;
      // Drive EVERY direct length controller to its slider max simultaneously —
      // the worst case a user can request through the UI.
      const overrides: Record<string, number> = {};
      for (const { id, field } of controllers) overrides[id] = sliderMax(field);
      const ids = controllers.map((c) => c.id);

      // The clamped diagram must stay renderable. Each capped payload emits at
      // most ~2 cells/byte; the bound is generous against the whole packet.
      const clamped = cellCount(src, mirror, ids, overrides, true);
      expect(
        clamped,
        `${key}: clamped cell count must stay bounded (got ${clamped})`,
      ).toBeLessThanOrEqual(
        MAX_LENGTH_CONTROLLER_BYTES * 4 * controllers.length + 2048,
      );
    }
  });

  it("reproduces the pre-fix explosion and confirms the clamp tames it on documented probes", () => {
    // Audit probes: a maxed direct length slider explodes the diagram.
    //   oncRpc credLength / verfLength (32-bit), diameter avpLength (24-bit),
    //   sflow sflowSampleLen (32-bit), dnsResponse dnsRdLength (16-bit).
    // `extra` selects the message arm the probed length field lives in: oncRpc's
    // `credLength` sizes the CALL credential, but `initialState` now seeds the
    // REPLY arm (rpcMsgType=1) so the surfaced reply pickers render on load — so
    // the probe pins rpcMsgType=0 to render the CALL arm where credLength is live.
    const probes: {
      key: string;
      id: string;
      extra?: Record<string, number>;
    }[] = [
      { key: "oncRpc", id: "credLength", extra: { rpcMsgType: 0 } },
      { key: "diameter", id: "avpLength" },
    ];
    for (const { key, id, extra } of probes) {
      const src = PRESETS[key];
      expect(src, `preset ${key} should exist`).toBeTruthy();
      const mirror = psdlToRenderer(src!);
      const controllers = directLengthControllers(mirror);
      const match = controllers.find((c) => c.id === id);
      expect(
        match,
        `${key}/${id} should be a direct length controller`,
      ).toBeTruthy();

      const ids = controllers.map((c) => c.id);
      // A modest length (50000) already over-explodes; the full slider max would
      // OOM the worker, so probe at 50000 for the unclamped path.
      const unclamped = cellCount(
        src!,
        mirror,
        ids,
        { ...extra, [id]: 50000 },
        false,
      );
      expect(
        unclamped,
        `${key}/${id} unclamped should explode`,
      ).toBeGreaterThan(5000);

      // The clamp keeps it bounded even when the user requests the full int max.
      const clamped = cellCount(
        src!,
        mirror,
        ids,
        { ...extra, [id]: sliderMax(match!.field) },
        true,
      );
      expect(
        clamped,
        `${key}/${id} clamped must stay far below the explosion`,
      ).toBeLessThan(unclamped);
      expect(
        clamped,
        `${key}/${id} clamped must be renderable`,
      ).toBeLessThanOrEqual(MAX_LENGTH_CONTROLLER_BYTES * 4 + 2048);
    }
  });

  it("OverrideSlider max math caps a direct controller to MAX_LENGTH_CONTROLLER_BYTES but keeps boundedRepeat controllers at full range", () => {
    // Mirror OverridePanel's max computation for both categories.
    const sliderMaxFor = (field: Field, maxBytes?: number): number => {
      const fullMax = sliderMax(field);
      return typeof maxBytes === "number"
        ? Math.min(fullMax, maxBytes)
        : fullMax;
    };
    // A 32-bit direct length controller (oncRpc credLength) must be capped.
    const oncRpc = psdlToRenderer(PRESETS.oncRpc!);
    const cred = directLengthControllers(oncRpc).find(
      (c) => c.id === "credLength",
    );
    expect(cred).toBeTruthy();
    expect(sliderMaxFor(cred!.field, MAX_LENGTH_CONTROLLER_BYTES)).toBe(
      MAX_LENGTH_CONTROLLER_BYTES,
    );
    // A boundedRepeat-driven length slider keeps the full int range (no cap).
    const bgp = psdlToRenderer(PRESETS.bgpUpdateFull!);
    const br = (bgp.boundedRepeats ?? [])[0];
    expect(br, "bgpUpdateFull should expose a boundedRepeat").toBeTruthy();
    const lcField =
      (bgp.lengthControllers ?? []).find((f) => f.id === br!.lengthKey) ??
      bgp.fields.find((f) => f.controlsLength === br!.lengthKey);
    if (lcField) {
      expect(sliderMaxFor(lcField, undefined)).toBe(sliderMax(lcField));
    }
  });
});
