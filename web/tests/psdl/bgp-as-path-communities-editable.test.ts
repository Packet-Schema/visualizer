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
    const budget = evalExprOr(br.bytesExpr, env, 0);
    env.set(
      br.countKey,
      Math.floor(Math.max(0, budget - br.prefixBytes) / br.perRecordBytes),
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

  it("never over-consumes the per-attribute scope for any attrTypeCode/attrExtLen", () => {
    const src = PRESETS.bgpUpdateFull!;
    const mirror = psdlToRenderer(src);
    const rs = (mirror.refSwitches ?? []).find(
      (r) => r.refKey === "attrTypeCode",
    );
    expect(rs).toBeDefined();
    for (const c of rs!.cases) {
      for (const ext of [0, 1]) {
        const ids = layoutCellIds(src, mirror, {
          attrTypeCode: c.value,
          attrExtLen: ext,
        });
        expect(
          ids.length,
          `attrTypeCode=${c.value} attrExtLen=${ext} must render without freezing`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
