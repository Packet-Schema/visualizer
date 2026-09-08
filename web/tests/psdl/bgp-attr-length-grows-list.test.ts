// medium: in bgpUpdateFull, raising a Path-Attribute's OWN length cell
// (bgpAttrLength8 at default; bgpAttrLength16 under the Extended-Length flag) -
// the natural way to grow that attribute's AS_PATH (type 2) / COMMUNITIES (type
// 8) record list - used to do the OPPOSITE: the whole Path-Attribute record
// (flags, type code, the length cell itself, every AS-segment / community cell)
// VANISHED from the diagram. The outer `bgpPathAttributes` boundedRepeat charged
// the per-attribute length overage into `livePerRecordBytes`, so
// `floor((bgpTotalPathAttributeLength - prefix) / livePerRecordBytes)` dropped to
// 0 records; the attribute was recoverable only by ALSO raising
// `bgpTotalPathAttributeLength` far beyond what a user would expect - a
// panel-vs-diagram contradiction on the defining payload of a BGP UPDATE.
//
// Fix: the per-attribute length fields (bgpAttrLength8 / bgpAttrLength16) are
// themselves the BUDGET of the nested bgpAsPathSegments / bgpCommunities repeats,
// so the mirror now stamps them with `derivesBudgetKey:
// bgpTotalPathAttributeLength`. PacketViewer grows the enclosing total by the
// live overage (keeping the record present) AND - because the outer budget is the
// repeat's own lengthKey, with no inner-seed overage entry to carry the cost -
// charges that overage into `livePerRecordBytes`, so the grown record fits the
// grown budget exactly. Raising the length now GROWS the inner AS_PATH /
// COMMUNITIES list instead of collapsing the attribute.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { evalExprOr } from "@/lib/psdl/expr";
import { initialState } from "@/lib/psdl/renderer-helpers";
import { seedDynamicWidthDefaults } from "@/lib/psdl/dynamic-width-defaults";
import type { Packet as RendererPacket } from "@/lib/psdl/renderer";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

// Faithful copy of PacketViewer.buildLayoutEnv's bounded-repeat derivation,
// INCLUDING the inner-budget growth (`derivesBudgetKey`, with the OUTER-budget
// base fallback) and the outer-budget-driver overage charge. Returns the resolved
// layout cell ids (throws iff the real diagram would).
function layoutCellIds(
  src: PsdlPacket,
  mirror: RendererPacket,
  overrides: Record<string, number> = {},
): string[] {
  const ctrl = { ...initialState(mirror), ...overrides };
  const env = new Map<string, number>(
    Object.entries(ctrl).map(([k, v]) => [k, Number(v)]),
  );
  for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
  seedDynamicWidthDefaults(src, env);
  for (const br of mirror.boundedRepeats ?? []) {
    for (const seed of br.innerScopeSeeds ?? []) {
      if (!env.get(seed.key)) env.set(seed.key, seed.value);
    }
    const budgetBaseOf = (key: string): number => {
      const seed = (br.innerScopeSeeds ?? []).find(
        (s) => s.key === key && !s.derivesBudgetKey,
      );
      if (seed) return seed.value;
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
    const budget = evalExprOr(br.bytesExpr, env, 0);
    const forRecords = Math.max(0, budget - br.prefixBytes);
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
    env.set(
      br.countKey,
      Math.min(1024, Math.floor(forRecords / livePerRecordBytes)),
    );
  }
  return resolveLayout(src, { env }).cells.map((c) => c.field.id);
}

describe("bgpUpdateFull: per-attribute length grows its record list, not collapses it", () => {
  it("tags the per-attribute length seeds as drivers of the outer total budget", () => {
    const mirror = psdlToRenderer(PRESETS.bgpUpdateFull!);
    const br = (mirror.boundedRepeats ?? []).find(
      (b) => b.countKey === "bgpPathAttributes",
    );
    expect(br, "bgpPathAttributes boundedRepeat must exist").toBeDefined();
    const byKey = new Map((br!.innerScopeSeeds ?? []).map((s) => [s.key, s]));
    // Both Extended-Length branches drive the enclosing total budget.
    expect(byKey.get("bgpAttrLength8")?.derivesBudgetKey).toBe(
      "bgpTotalPathAttributeLength",
    );
    expect(byKey.get("bgpAttrLength16")?.derivesBudgetKey).toBe(
      "bgpTotalPathAttributeLength",
    );
  });

  it("raising bgpAttrLength8 (attrTypeCode=2) GROWS the AS_PATH segments, keeping the attribute present", () => {
    const src = PRESETS.bgpUpdateFull!;
    const mirror = psdlToRenderer(src);

    const seg = (ids: string[]) =>
      ids.filter((i) => i.startsWith("bgpAsSeg")).length;

    const base = layoutCellIds(src, mirror, { attrTypeCode: 2 });
    expect(base).toContain("attrTypeCode#0");
    const baseSeg = seg(base);
    expect(baseSeg).toBeGreaterThan(0);

    // The defining regression: raising the attribute's OWN length must keep the
    // record present (attrTypeCode#0) AND grow the AS_PATH list - not vanish it.
    const raised = layoutCellIds(src, mirror, {
      attrTypeCode: 2,
      bgpAttrLength8: 20,
    });
    expect(
      raised,
      "the Path-Attribute record must stay on the diagram after raising its length",
    ).toContain("attrTypeCode#0");
    expect(
      seg(raised),
      "raising bgpAttrLength8 must GROW the AS_PATH segment list",
    ).toBeGreaterThan(baseSeg);

    // Monotone: a larger length yields at least as many segments.
    const more = layoutCellIds(src, mirror, {
      attrTypeCode: 2,
      bgpAttrLength8: 30,
    });
    expect(more).toContain("attrTypeCode#0");
    expect(seg(more)).toBeGreaterThanOrEqual(seg(raised));
  });

  it("raising bgpAttrLength8 (attrTypeCode=8) GROWS the COMMUNITIES list, keeping the attribute present", () => {
    const src = PRESETS.bgpUpdateFull!;
    const mirror = psdlToRenderer(src);
    const com = (ids: string[]) =>
      ids.filter((i) => i.startsWith("bgpCommunity")).length;

    const base = com(layoutCellIds(src, mirror, { attrTypeCode: 8 }));
    const raised = layoutCellIds(src, mirror, {
      attrTypeCode: 8,
      bgpAttrLength8: 24,
    });
    expect(raised).toContain("attrTypeCode#0");
    expect(com(raised)).toBeGreaterThan(base);
  });

  it("the Extended-Length branch (bgpAttrLength16) grows the list too", () => {
    const src = PRESETS.bgpUpdateFull!;
    const mirror = psdlToRenderer(src);
    const seg = (ids: string[]) =>
      ids.filter((i) => i.startsWith("bgpAsSeg")).length;

    const base = seg(
      layoutCellIds(src, mirror, { attrTypeCode: 2, attrExtLen: 1 }),
    );
    const raised = layoutCellIds(src, mirror, {
      attrTypeCode: 2,
      attrExtLen: 1,
      bgpAttrLength16: 40,
    });
    expect(raised).toContain("attrTypeCode#0");
    expect(seg(raised)).toBeGreaterThan(base);
  });

  it("never over-consumes the scope for any per-attribute length in [0..255]", () => {
    const src = PRESETS.bgpUpdateFull!;
    const mirror = psdlToRenderer(src);
    for (const [type, key, ext] of [
      [2, "bgpAttrLength8", 0],
      [8, "bgpAttrLength8", 0],
      [2, "bgpAttrLength16", 1],
    ] as const) {
      for (let v = 0; v <= 255; v++) {
        expect(
          () =>
            layoutCellIds(src, mirror, {
              attrTypeCode: type,
              attrExtLen: ext,
              [key]: v,
            }),
          `attrTypeCode=${type} ${key}=${v} must not freeze`,
        ).not.toThrow();
      }
    }
  });
});
