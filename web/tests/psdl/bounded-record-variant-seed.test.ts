// #11/#12 discoverability/contradiction class — plain-bounded branch.
//
// For a TLV-shaped repeat in a PLAIN bounded scope (record count DERIVED from a
// length budget, e.g. isisLsp `tlvs` under `pduLength - 27`, bgpFlowSpec
// `flowSpecComponents` under `flowSpecLength`, babel `babelTlvs` under
// `babelBodyLength`), psdlToRenderer surfaces a refSwitch "Record variants"
// picker for the per-record variant switch. At default load the budget length
// field is 0, so `floor((budget - prefix) / perRecordBytes) = 0` records render
// and the populated picker sits over an EMPTY TLV region — contradicting the
// diagram and doing nothing until the user discovers the length slider.
//
// Fix: psdlToRenderer seeds a `defaultLength` on the plain-bounded boundedRepeat
// (ONLY when the record is variant-bearing) so the budget yields >=1 record at
// load; the picker is then immediately effective. Scalar-list bounded repeats
// (no variant switch) get NO seed and stay empty.

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

// Mirror PacketViewer's at-load layout env build (initialState seeds the
// boundedRepeat defaultLength; the bounded-repeat count is derived from the
// budget). `overrides` simulate driving a control after load.
function valueCellIds(
  src: PsdlPacket,
  mirror: RendererPacket,
  overrides: Record<string, number> = {},
): string[] {
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
  return resolveLayout(base, { env })
    .cells.map((c) => c.field.id)
    .filter((id) => /Value/.test(id));
}

// All rendered cell ids (a per-record instance carries a `#<n>` suffix).
function recordInstanceIds(
  src: PsdlPacket,
  mirror: RendererPacket,
  overrides: Record<string, number> = {},
): string[] {
  const ctrl = { ...initialState(mirror), ...overrides };
  const base = applyChainInstances(applyTlvInstances(src, mirror, {}), mirror);
  const env = new Map<string, number>(
    Object.entries(ctrl).map(([k, v]) => [k, Number(v)]),
  );
  for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
  for (const br of mirror.boundedRepeats ?? []) {
    const budget = evalExprOr(br.bytesExpr, env, 0);
    env.set(
      br.countKey,
      Math.floor(Math.max(0, budget - br.prefixBytes) / br.perRecordBytes),
    );
  }
  return resolveLayout(base, { env })
    .cells.map((c) => c.field.id)
    .filter((id) => /#\d+$/.test(id));
}

describe("plain-bounded record-bearing repeat seeds a defaultLength", () => {
  it("isisLsp renders >=1 TLV value cell at load and the byType picker changes it", () => {
    const src = PRESETS.isisLsp!;
    const mirror = psdlToRenderer(src);

    const br = mirror.boundedRepeats?.find((b) => b.countKey === "tlvs");
    expect(br, "isisLsp tlvs boundedRepeat missing").toBeDefined();
    // Seeded so `floor((pduLength - 27 - prefix) / perRecord) >= 1`.
    expect(br!.defaultLength).toBeGreaterThanOrEqual(
      27 + br!.prefixBytes + br!.perRecordBytes,
    );

    const rs = mirror.refSwitches?.find((s) => s.refKey === "tlvType");
    expect(rs, "isisLsp tlvType refSwitch missing").toBeDefined();

    // At load (no overrides) a representative record renders: cases[0] is
    // tlvType 1 = Area Addresses, so its value cell is present.
    const atLoad = valueCellIds(src, mirror);
    expect(
      atLoad.length,
      "isisLsp should render >=1 value cell at load",
    ).toBeGreaterThanOrEqual(1);
    expect(atLoad).toContain("areaAddressesValue#0");

    // The byType picker is immediately effective at the seeded length: each of
    // several variants yields a DISTINCT value cell (not byte-identical, not
    // empty).
    const seen = new Map<number, string[]>();
    for (const c of rs!.cases) {
      seen.set(c.value, valueCellIds(src, mirror, { [rs!.refKey]: c.value }));
    }
    expect(seen.get(10), "byType=10 (Authentication)").toContain("authValue#0");
    expect(seen.get(22), "byType=22 (Extended IS Reachability)").toContain(
      "extIsReachValue#0",
    );
    // Distinct from the default arm — the picker actually changes the diagram.
    expect(seen.get(10)).not.toEqual(atLoad);
  });

  it("bgpFlowSpec / babel also render >=1 record at load via the seed", () => {
    for (const [key, countKey] of [
      ["bgpFlowSpec", "flowSpecComponents"],
      ["babel", "babelTlvs"],
    ] as const) {
      const src = PRESETS[key]!;
      const mirror = psdlToRenderer(src);
      const br = mirror.boundedRepeats?.find((b) => b.countKey === countKey);
      expect(br, `${key} ${countKey} boundedRepeat missing`).toBeDefined();
      // Plain `ref` budget → seed = prefix + perRecordBytes.
      expect(br!.defaultLength).toBe(br!.prefixBytes + br!.perRecordBytes);
      // A representative per-record instance (`…#0`) renders at load — the
      // variant picker is no longer over an empty region. (The cases[0] arm of
      // babel is Pad1, a value-less record, so assert the record instance, not
      // a `…Value` cell specifically.)
      expect(
        recordInstanceIds(src, mirror).length,
        `${key} should render >=1 record instance at load`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("only record-bearing plain-bounded repeats are seeded (no scalar-list seeds)", () => {
    // A defaultLength on a plain-bounded boundedRepeat must only appear when the
    // record carries a ref/peek-discriminated variant switch. Across every
    // preset, every boundedRepeat that gained a defaultLength must surface a
    // matching refSwitch or peekSwitch over its records (i.e. be variant-bearing),
    // so no scalar-list bounded repeat is force-seeded into showing bytes.
    for (const [key, src] of Object.entries(PRESETS)) {
      const mirror = psdlToRenderer(src);
      for (const br of mirror.boundedRepeats ?? []) {
        if (br.defaultLength === undefined) continue;
        const hasVariantPicker =
          (mirror.refSwitches ?? []).length > 0 ||
          (mirror.peekSwitches ?? []).length > 0 ||
          // tlvExt seeds (tlsClientHello) are variant-bearing by construction.
          (br.innerScopeSeeds?.length ?? 0) > 0;
        expect(
          hasVariantPicker,
          `${key}/${br.countKey} was seeded but has no variant picker`,
        ).toBe(true);
      }
    }
  });
});
