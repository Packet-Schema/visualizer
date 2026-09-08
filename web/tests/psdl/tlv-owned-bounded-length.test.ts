// override-design-audit: a top-level `bounded` scope whose inner repeat is
// TLV-shaped (element = single peek/ref Switch) is lifted to a `tlv` field
// (ipv4/tcp `options`, ipv6Destination `ipv6DstOptions`, tlsClientHelloFull
// `extensions`). The TLV editor (add/remove records) is the intended control
// for that region and the byte budget follows the instances. The SAME bounded's
// single-ref length field (ihl / dataOffset / hdrExtLen / extensionsLen) must
// NOT ALSO be stamped as a `controlsLength` length-controller slider: dragging
// it would inflate the diagram's byte counter by tens of bytes while ZERO new
// cells appear (the eos repeat renders through the TLV-instance mechanism, not
// the budget) — a misleading control fighting the TLV editor for one region.
//
// Presets whose bounded repeat is NOT TLV-lifted (isisLsp pduLength,
// tlsClientHello session/cipher/comp/extensions lengths) keep their slider.

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

// Mirror PacketViewer's full layout-env build (initialState + boundedRepeat /
// freeRepeat derivation) so the assertions reflect what the diagram renders.
function layout(
  src: PsdlPacket,
  mirror: RendererPacket,
  overrides: Record<string, number>,
): { totalBits: number; cellCount: number } {
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
    env.set(br.countKey, Math.floor(forRecords / br.perRecordBytes));
  }
  const resolved = resolveLayout(base, { env });
  return { totalBits: resolved.totalBits, cellCount: resolved.cells.length };
}

// Each TLV-owned bounded scope: the preset, its lifted `tlv` field, the
// single-ref length field that drives the bounded budget, and a couple of
// representative slider values from the EVIDENCE that inflate totalBits.
const TLV_OWNED: Array<{
  preset: string;
  tlvField: string;
  lengthKey: string;
  values: number[];
}> = [
  { preset: "ipv4", tlvField: "options", lengthKey: "ihl", values: [5, 6, 8] },
  {
    preset: "tcp",
    tlvField: "options",
    lengthKey: "dataOffset",
    values: [5, 6, 8],
  },
  {
    preset: "ipv6Destination",
    tlvField: "ipv6DstOptions",
    lengthKey: "hdrExtLen",
    values: [0, 8, 16],
  },
  {
    preset: "tlsClientHelloFull",
    tlvField: "extensions",
    lengthKey: "extensionsLen",
    values: [0, 8, 40],
  },
];

describe("TLV-owned bounded length does NOT surface a controlsLength slider", () => {
  it("the 4 affected presets each carry the lifted tlv field but no length slider for it", () => {
    for (const { preset, tlvField, lengthKey } of TLV_OWNED) {
      const src = PRESETS[preset]!;
      const mirror = psdlToRenderer(src);

      // The TLV editor IS present — the region is owned by it.
      expect(
        mirror.fields.some((f) => f.id === tlvField && f.tlv),
        `${preset} should lift ${tlvField} to a tlv field`,
      ).toBe(true);

      // The bounded length field must NOT be stamped as a length controller —
      // neither as a top-level cell nor as a packet-level lengthController.
      const lengthCell = mirror.fields.find((f) => f.id === lengthKey);
      expect(
        lengthCell?.controlsLength,
        `${preset}.${lengthKey} must not be a controlsLength slider`,
      ).toBeUndefined();
      expect(
        (mirror.lengthControllers ?? []).some((lc) => lc.id === lengthKey),
        `${preset}.${lengthKey} must not be a packet-level length controller`,
      ).toBe(false);
    }
  });

  it("dragging the length key WOULD inflate totalBits without adding cells (why the slider is suppressed)", () => {
    for (const { preset, lengthKey, values } of TLV_OWNED) {
      const src = PRESETS[preset]!;
      const mirror = psdlToRenderer(src);
      const base = layout(src, mirror, { [lengthKey]: values[0]! });
      for (const v of values.slice(1)) {
        const grown = layout(src, mirror, { [lengthKey]: v });
        // The byte counter inflates...
        expect(
          grown.totalBits,
          `${preset} ${lengthKey}=${v} should inflate totalBits`,
        ).toBeGreaterThan(base.totalBits);
        // ...but ZERO new cells appear: the region is rendered through the TLV
        // instance mechanism, not the budget. That mismatch is exactly why the
        // slider must be suppressed.
        expect(
          grown.cellCount,
          `${preset} ${lengthKey}=${v} should NOT add cells`,
        ).toBe(base.cellCount);
      }
    }
  });
});

describe("non-TLV bounded length controllers are unaffected", () => {
  it("isisLsp pduLength and tlsClientHello extensionsLen keep their length slider", () => {
    const cases: Array<{ preset: string; lengthKey: string }> = [
      { preset: "isisLsp", lengthKey: "pduLength" },
      { preset: "tlsClientHello", lengthKey: "extensionsLen" },
    ];
    for (const { preset, lengthKey } of cases) {
      const src = PRESETS[preset]!;
      const mirror = psdlToRenderer(src);
      const surfaced =
        mirror.fields.some(
          (f) => f.id === lengthKey && f.controlsLength === lengthKey,
        ) || (mirror.lengthControllers ?? []).some((lc) => lc.id === lengthKey);
      expect(
        surfaced,
        `${preset}.${lengthKey} should still expose a length control`,
      ).toBe(true);

      // And none of these presets lift a tlv field that owns ${lengthKey}'s
      // bounded scope (sanity: they are genuinely not in the affected set).
      expect(
        mirror.fields.some((f) => f.tlv),
        `${preset} should not carry a lifted tlv field`,
      ).toBe(false);
    }
  });
});
