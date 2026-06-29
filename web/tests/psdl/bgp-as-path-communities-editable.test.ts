// high: bgpUpdateFull's AS_PATH (type 2) and COMMUNITIES (type 8) path-attribute
// arms were see-but-cannot-edit.
//
// The surfaced `attrTypeCode` refSwitch lets the user pick the path-attribute
// variant, but cases 2 (AS_PATH → repeat `bgpAsPathSegments` {eos}) and 8
// (COMMUNITIES → repeat `bgpCommunities` {eos}) are eos repeats nested inside the
// switch arm, inside the per-attribute `bounded(cond attrExtLen ?
// bgpAttrLength16 : bgpAttrLength8)` scope. That budget is a multi-ref `cond`, so
// it never became the single-ref `bounded` and those repeats were registered in
// NEITHER freeRepeats, boundedRepeats, lengthControllers, nor peekSwitches — they
// got ZERO count control. Picking AS_PATH / Communities rendered only the flags +
// length cells over an EMPTY body.
//
// Fix: a `count: eos` repeat sitting in a switch case inside such a multi-ref
// per-record bounded scope is registered as a budget-derived boundedRepeat keyed
// on that bounded's budget (`bgpAsPathSegments` / `bgpCommunities`). The count
// then follows the attribute-length budget — whose length fields are seeded by
// the enclosing `bgpPathAttributes` boundedRepeat — so a representative >=1
// segment / community renders at load and stays editable, without freezing the
// scope for any selectable attrTypeCode / attrExtLen combination.

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
// boundedRepeat innerScopeSeeds + defaultLength, then each boundedRepeat's count
// is derived from its budget IN ARRAY ORDER (so the outer bgpPathAttributes seeds
// the per-attribute length before the inner AS_PATH / COMMUNITIES budgets read
// it). `overrides` simulate driving a control after load.
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
    // Mirror PacketViewer: a `derivesBudgetKey` seed grows its inner budget by the
    // live overage; an un-tagged inner length seed (bgpAsSegLength sizing the
    // per-segment AS list) charges its overage into the per-record byte cost so
    // the budget-derived count SHRINKS to stay within scope (no over-consume).
    const budgetBaseOf = (key: string): number => {
      const s = (br.innerScopeSeeds ?? []).find(
        (x) => x.key === key && !x.derivesBudgetKey,
      );
      if (s) return s.value;
      if (key === br.lengthKey) return Number(env.get(key) ?? 0);
      return 0;
    };
    for (const seed of br.innerScopeSeeds ?? []) {
      if (!seed.derivesBudgetKey) continue;
      const overage =
        Math.max(0, Number(env.get(seed.key) ?? 0) - seed.value) *
        (seed.bytesPerUnit ?? 1);
      if (overage <= 0) continue;
      const required = budgetBaseOf(seed.derivesBudgetKey) + overage;
      if (required > Number(env.get(seed.derivesBudgetKey) ?? 0)) {
        env.set(seed.derivesBudgetKey, required);
      }
    }
    const innerOverage = (br.innerScopeSeeds ?? []).reduce(
      (sum, seed) =>
        seed.derivesBudgetKey && seed.derivesBudgetKey !== br.lengthKey
          ? sum
          : sum +
            Math.max(0, Number(env.get(seed.key) ?? 0) - seed.value) *
              (seed.bytesPerUnit ?? 1),
      0,
    );
    const livePerRecordBytes = br.perRecordBytes + innerOverage;
    const budget = evalExprOr(br.bytesExpr, env, 0);
    env.set(
      br.countKey,
      Math.floor(Math.max(0, budget - br.prefixBytes) / livePerRecordBytes),
    );
  }
  return resolveLayout(base, { env }).cells.map((c) => c.field.id);
}

describe("bgpUpdateFull AS_PATH / COMMUNITIES arms are editable", () => {
  it("surfaces budget-derived boundedRepeats for the arm-nested eos repeats", () => {
    const mirror = psdlToRenderer(PRESETS.bgpUpdateFull!);

    const asPath = (mirror.boundedRepeats ?? []).find(
      (b) => b.countKey === "bgpAsPathSegments",
    );
    const communities = (mirror.boundedRepeats ?? []).find(
      (b) => b.countKey === "bgpCommunities",
    );
    expect(
      asPath,
      "bgpAsPathSegments must be a budget-derived boundedRepeat",
    ).toBeDefined();
    expect(
      communities,
      "bgpCommunities must be a budget-derived boundedRepeat",
    ).toBeDefined();
    // The arm is the whole content of its switch case, so no prefix is charged.
    expect(asPath!.prefixBytes).toBe(0);
    expect(communities!.prefixBytes).toBe(0);
    // The budget is the per-attribute Extended-Length cond, whose value branches
    // are the two length fields seeded by the enclosing bgpPathAttributes record.
    expect(asPath!.bytesExpr.kind).toBe("cond");
    expect(communities!.bytesExpr.kind).toBe("cond");
    expect(["bgpAttrLength8", "bgpAttrLength16"]).toContain(asPath!.lengthKey);
  });

  it("renders the AS_PATH segments when attrTypeCode picks 2 (no longer empty)", () => {
    const src = PRESETS.bgpUpdateFull!;
    const mirror = psdlToRenderer(src);

    // Before the fix this rendered only attrTypeCode#0 with an empty body.
    const ids = layoutCellIds(src, mirror, { attrTypeCode: 2 });
    expect(ids).toContain("attrTypeCode#0");
    expect(ids).toContain("bgpAsSegType#0_0");
    expect(ids).toContain("bgpAsSegLength#0_0");

    // The same arm under the Extended-Length encoding also populates.
    const ext = layoutCellIds(src, mirror, { attrTypeCode: 2, attrExtLen: 1 });
    expect(ext).toContain("bgpAsSegType#0_0");
  });

  it("renders the Communities list when attrTypeCode picks 8 (no longer empty)", () => {
    const src = PRESETS.bgpUpdateFull!;
    const mirror = psdlToRenderer(src);

    const ids = layoutCellIds(src, mirror, { attrTypeCode: 8 });
    expect(ids).toContain("attrTypeCode#0");
    expect(ids).toContain("bgpCommunity#0_0");
  });

  it("surfaces bgpAsSegLength as a length controller so the AS-number list is editable", () => {
    const src = PRESETS.bgpUpdateFull!;
    const mirror = psdlToRenderer(src);

    // The AS_PATH segment's per-segment AS count (`bgpAsSegLength`, sizing the
    // inner `bgpAsSegValue = repeat count:ref(bgpAsSegLength)`) was previously
    // absent from the whole mirror: the user saw AS-number cells appear/grow with
    // env[bgpAsSegLength] but had NO control to drive them (see-but-cannot-edit).
    // It is now a length-style controller, surfaced off the AS_PATH boundedRepeat's
    // innerScopeSeeds (the segment record wraps no nested bounded, so it qualifies).
    const segLenCtrl = (mirror.lengthControllers ?? []).find(
      (lc) => lc.id === "bgpAsSegLength",
    );
    expect(
      segLenCtrl,
      "bgpAsSegLength must be a surfaced length controller",
    ).toBeDefined();
    expect(segLenCtrl!.controlsLength).toBe("bgpAsSegLength");

    const asPath = (mirror.boundedRepeats ?? []).find(
      (b) => b.countKey === "bgpAsPathSegments",
    )!;
    const seed = (asPath.innerScopeSeeds ?? []).find(
      (s) => s.key === "bgpAsSegLength",
    );
    expect(
      seed,
      "bgpAsSegLength must seed the AS_PATH segment per-record byte cost",
    ).toBeDefined();
    // Each AS number is a 2-octet ASN, so one +1 unit of the count charges 2B
    // against the per-attribute budget (the count shrinks to keep scope safe).
    expect(seed!.bytesPerUnit).toBe(2);
    // No derivesBudgetKey: growing the cond per-attribute budget can't enlarge the
    // outer total in the same memo pass, so it would over-consume and freeze — the
    // seed must charge into per-record bytes (shrink), never grow a budget.
    expect(seed!.derivesBudgetKey).toBeUndefined();
  });

  it("renders AS numbers when bgpAsSegLength is raised (the control changes the diagram)", () => {
    const src = PRESETS.bgpUpdateFull!;
    const mirror = psdlToRenderer(src);

    const asCells = (overrides: Record<string, number>): number =>
      layoutCellIds(src, mirror, overrides).filter((id) =>
        id.startsWith("bgpAsNumber"),
      ).length;

    // At the default AS count the segments carry no AS numbers...
    expect(asCells({ attrTypeCode: 2 })).toBe(0);
    // ...and raising bgpAsSegLength adds AS-number cells to the rendered segment —
    // the control is live, not inert. (The budget-derived segment count shrinks to
    // keep the per-attribute scope within budget; it never over-consumes / freezes,
    // verified across every attrTypeCode/attrExtLen below.)
    expect(asCells({ attrTypeCode: 2, bgpAsSegLength: 1 })).toBeGreaterThan(0);
    expect(asCells({ attrTypeCode: 2, attrExtLen: 1, bgpAsSegLength: 1 })).toBe(
      asCells({ attrTypeCode: 2, bgpAsSegLength: 1 }),
    );
  });

  it("never over-consumes the per-attribute scope for any attrTypeCode/attrExtLen/bgpAsSegLength", () => {
    const src = PRESETS.bgpUpdateFull!;
    const mirror = psdlToRenderer(src);
    const rs = (mirror.refSwitches ?? []).find(
      (r) => r.refKey === "attrTypeCode",
    );
    expect(rs).toBeDefined();
    for (const c of rs!.cases) {
      for (const ext of [0, 1]) {
        // Sweep bgpAsSegLength across its full int8 range: the new length control
        // must never push the AS_PATH segment record past the per-attribute budget
        // in a way that throws `bounded scope over-consumed` (which freezes the
        // diagram on the last good layout). The segment count shrinks instead.
        for (const segLen of [0, 1, 2, 5, 255]) {
          const ids = layoutCellIds(src, mirror, {
            attrTypeCode: c.value,
            attrExtLen: ext,
            bgpAsSegLength: segLen,
          });
          expect(
            ids.length,
            `attrTypeCode=${c.value} attrExtLen=${ext} bgpAsSegLength=${segLen} must render without freezing`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });
});
