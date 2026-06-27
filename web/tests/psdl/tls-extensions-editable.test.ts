// tlsClientHello's extensions block used to be fully see-but-cannot-edit: the
// `extensions` eos repeat lives inside the single-ref bounded `extensionsScope`
// (bytes = ref extensionsLen) but each record is
// `[extType, extLen, bounded extData(ref extLen){ switch on extType }]` — NOT a
// single Switch, so it is not isTlvRepeat and was never TLV-promoted; and
// because each record wraps a nested bounded, the plain bounded-count derive was
// skipped (`!containsBounded` guard). Result: NO count control, NO type picker —
// raising extensionsLen left the diagram byte-identical (17 cells).
//
// Fix: collectFreeRepeats now recognises the TLV-EXTENSION idiom (eos repeat in
// a single-ref bounded whose record wraps a single-ref-to-sibling nested bounded
// holding a Switch) and emits a budget-derived boundedRepeat, seeding each
// per-record inner length (extLen) so the representative record fits its own
// nested scope. The extType variant picker is surfaced as a refSwitch.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { evalExprOr } from "@/lib/psdl/expr";
import { initialState } from "@/lib/psdl/renderer-helpers";
import type { Packet as RendererPacket } from "@/lib/psdl/renderer";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

// Mirror PacketViewer's layout env build (including the bounded-repeat derive
// and the per-record inner-scope seeding).
function cellIds(
  src: PsdlPacket,
  mirror: RendererPacket,
  overrides: Record<string, number>,
): string[] {
  const ctrl = { ...initialState(mirror), ...overrides };
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
    env.set(br.countKey, Math.floor(forRecords / br.perRecordBytes));
  }
  return resolveLayout(src, { env }).cells.map((c) => c.field.id);
}

describe("tlsClientHello extensions are editable", () => {
  const src = PRESETS.tlsClientHello!;
  const mirror = psdlToRenderer(src);

  it("surfaces a budget-derived count control for the extensions repeat", () => {
    const br = (mirror.boundedRepeats ?? []).find(
      (b) => b.countKey === "extensions",
    );
    expect(br, "extensions must surface a boundedRepeat").toBeDefined();
    expect(br!.lengthKey).toBe("extensionsLen");
    // The per-record inner length (extLen) is seeded so the representative
    // record fits its nested extData scope.
    expect(br!.innerScopeSeeds?.some((s) => s.key === "extLen")).toBe(true);
    // The estimate reflects the representative (cases[0]) arm, NOT the
    // 64-byte opaque `_`/remaining arm — so records appear at a reasonable
    // length rather than hiding behind a huge plateau.
    expect(br!.perRecordBytes).toBeLessThanOrEqual(16);
  });

  it("raising the extensions length grows real extension records", () => {
    const empty = cellIds(src, mirror, { extensionsLen: 0 });
    expect(empty).not.toContain("extType#0");

    const grown = cellIds(src, mirror, { extensionsLen: 40 });
    // The extension Type/Length prefix of at least one record now renders.
    expect(grown).toContain("extType#0");
    expect(grown).toContain("extLen#0");
    expect(grown.length).toBeGreaterThan(empty.length);

    // More budget → strictly more records.
    const bigger = cellIds(src, mirror, { extensionsLen: 200 });
    expect(bigger.length).toBeGreaterThan(grown.length);
  });

  it("exposes the 5-arm extension type switch as a selectable picker", () => {
    const rs = (mirror.refSwitches ?? []).find((r) => r.refKey === "extType");
    expect(rs, "extType variant picker must be surfaced").toBeDefined();
    // server_name / supported_groups / ALPN / supported_versions / key_share.
    expect(rs!.cases.map((c) => c.value).sort((a, b) => a - b)).toEqual([
      0, 10, 16, 43, 51,
    ]);
  });

  it("renders the selected extension variant (supported_versions)", () => {
    // Pick supported_versions (43): its arm carries a `Versions Len` field that
    // only appears when that arm is selected.
    const ids = cellIds(src, mirror, { extensionsLen: 40, extType: 43 });
    expect(ids).toContain("extType#0");
    expect(ids).toContain("vListLen#0");
  });

  it("never over-consumes the extensions scope across a length sweep", () => {
    for (let len = 0; len <= 1000; len++) {
      expect(
        () => cellIds(src, mirror, { extensionsLen: len }),
        `extensionsLen=${len} must not over-consume`,
      ).not.toThrow();
    }
  });
});
