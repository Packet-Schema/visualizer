// critical: bgpUpdateFull's entire Path-Attributes payload was see-but-cannot-edit.
//
// The `bgpPathAttributes` eos repeat sits inside `bounded(bgpTotalPathAttribute
// Length)` and each record wraps a PER-RECORD nested `bounded bgpAttrValueScope`
// whose budget is a `cond` selecting between `bgpAttrLength16` / `bgpAttrLength8`
// (the BGP Extended-Length idiom). collectFreeRepeats hit the
// `bounded && containsBounded` path, and tlvExtensionInnerSeeds returned null for
// the cond budget — so the repeat landed in NEITHER freeRepeats NOR
// boundedRepeats. psdlToRenderer did not lift it to a TLV field (its element is
// not a single switch), attachOverrideMetadata stamped nothing, and
// collectRefSwitches suppressed the attrTypeCode picker (the repeat was not
// instantiable). Net result: the defining body of a BGP UPDATE (origin / as-path
// / next-hop / MED / communities / MP-REACH …) rendered ZERO cells with no count
// control, no variant picker, and an inert bgpTotalPathAttributeLength slider.
//
// Fix: tlvExtensionInnerSeeds now recognises a `cond ? ref(A) : ref(B)` budget
// that selects between two sibling length fields, seeding BOTH so whichever the
// Extended-Length flag picks fits the LARGEST selectable arm. The repeat becomes
// a budget-derived boundedRepeat (instantiable, defaultLength-seeded so >=1
// record shows at load) and its attrTypeCode "Record variants" picker is live.

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

// Mirror PacketViewer's at-load layout env build: initialState seeds the
// boundedRepeat innerScopeSeeds + defaultLength, then the bounded-repeat count is
// derived from the budget. `overrides` simulate driving a control after load.
function layoutCellIds(
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
    for (const seed of br.innerScopeSeeds ?? []) {
      if (!env.get(seed.key)) env.set(seed.key, seed.value);
    }
    const budget = evalExprOr(br.bytesExpr, env, 0);
    env.set(
      br.countKey,
      Math.floor(Math.max(0, budget - br.prefixBytes) / br.perRecordBytes),
    );
  }
  return resolveLayout(base, { env }).cells.map((c) => c.field.id);
}

describe("bgpUpdateFull Path-Attributes payload is editable", () => {
  it("surfaces a budget-derived boundedRepeat + attrTypeCode picker, seeding both Extended-Length branches", () => {
    const mirror = psdlToRenderer(PRESETS.bgpUpdateFull!);

    const br = (mirror.boundedRepeats ?? []).find(
      (b) => b.countKey === "bgpPathAttributes",
    );
    expect(
      br,
      "bgpPathAttributes must be a budget-derived boundedRepeat",
    ).toBeDefined();
    expect(br!.lengthKey).toBe("bgpTotalPathAttributeLength");
    // The cond budget selects between the 1-byte and 2-byte length fields; both
    // are seeded so either Extended-Length encoding fits the representative arm.
    const seedKeys = new Set((br!.innerScopeSeeds ?? []).map((s) => s.key));
    expect(seedKeys).toEqual(new Set(["bgpAttrLength8", "bgpAttrLength16"]));
    // A representative outer length seed so the budget derives >=1 record at load.
    expect(br!.defaultLength).toBeGreaterThan(0);

    const refKeys = (mirror.refSwitches ?? []).map((r) => r.refKey);
    expect(refKeys).toContain("attrTypeCode");
  });

  it("renders >=1 path-attribute cell at load (no longer see-but-cannot-edit)", () => {
    const src = PRESETS.bgpUpdateFull!;
    const mirror = psdlToRenderer(src);
    const ids = layoutCellIds(src, mirror);
    // The defining payload — a path-attribute record — now renders at load.
    expect(ids).toContain("attrTypeCode#0");
    expect(ids).toContain("bgpAttrFlags#0");
    // cases[0] of attrTypeCode is ORIGIN (1) → its value cell renders.
    expect(ids).toContain("bgpOrigin#0");
  });

  it("the attrTypeCode picker actually changes the diagram (not inert) without freezing it", () => {
    const src = PRESETS.bgpUpdateFull!;
    const mirror = psdlToRenderer(src);
    const rs = (mirror.refSwitches ?? []).find(
      (r) => r.refKey === "attrTypeCode",
    );
    expect(rs).toBeDefined();

    const atLoad = layoutCellIds(src, mirror);
    // NEXT_HOP (3) and MED (4) are distinct fixed-width arms.
    const nextHop = layoutCellIds(src, mirror, { attrTypeCode: 3 });
    const med = layoutCellIds(src, mirror, { attrTypeCode: 4 });
    expect(nextHop).toContain("bgpNextHop#0");
    expect(med).toContain("bgpMed#0");
    // The picker moves the diagram — each selected variant differs from the
    // default ORIGIN arm (proving the control is not inert).
    expect(nextHop).not.toEqual(atLoad);
    expect(med).not.toEqual(atLoad);

    // No selectable variant — at either Extended-Length encoding — over-consumes
    // the seeded inner bounded scope (which would throw and freeze the diagram).
    for (const c of rs!.cases) {
      for (const ext of [0, 1]) {
        const ids = layoutCellIds(src, mirror, {
          attrTypeCode: c.value,
          attrExtLen: ext,
        });
        expect(
          ids.length,
          `attrTypeCode=${c.value} attrExtLen=${ext} must render a record without freezing`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
