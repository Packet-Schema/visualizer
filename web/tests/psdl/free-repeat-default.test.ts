// override-audit A4: plain (non-TLV/non-chain) eos/until repeats defaulted to 0
// iterations, so presets whose substance lives in a repeat rendered an empty /
// near-empty diagram on load (lldp's whole body is one until-repeat → blank).
// collectFreeRepeats now marks safe repeats with `defaultCount`, and
// initialState seeds it so a representative record shows on load — EXCEPT for
// repeats nested in a `bounded` byte-scope, where seeding would over-consume.

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
import { initialState } from "@/lib/psdl/renderer-helpers";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

function loadCellCount(key: string): number {
  const src = PRESETS[key]!;
  const mirror = psdlToRenderer(src);
  const controllers = initialState(mirror);
  const base: PsdlPacket = applyChainInstances(
    applyTlvInstances(src, mirror, {}),
    mirror,
  );
  const env = new Map<string, number>(
    Object.entries(controllers).map(([k, v]) => [k, Number(v)]),
  );
  for (const [k, v] of initialEnv(base)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(base)) if (!env.has(r)) env.set(r, 0);
  return resolveLayout(base, { env }).cells.length;
}

describe("free-repeat default count", () => {
  it("renders a representative record on load for top-level eos/until repeats", () => {
    // lldp's entire body is one until-repeat — previously blank (0 cells).
    expect(loadCellCount("lldp")).toBeGreaterThan(0);
    // diameter / coap have a fixed header + an eos repeat — now show a record.
    expect(loadCellCount("diameter")).toBeGreaterThan(0);
    expect(loadCellCount("coap")).toBeGreaterThan(0);
  });

  it("marks top-level eos/until repeats with defaultCount but not bounded-nested ones", () => {
    const lldp = psdlToRenderer(PRESETS.lldp!);
    const lldpRepeat = lldp.freeRepeats?.find((r) => r.countKey === "lldpTlvs");
    expect(lldpRepeat?.defaultCount).toBe(1);

    // bgpUpdateFull: bgpWithdrawnRoutes / bgpPathAttributes live inside bounded
    // scopes (seeding them would over-consume), so they must NOT be seeded; the
    // top-level NLRI repeat is safe to seed.
    const bgp = psdlToRenderer(PRESETS.bgpUpdateFull!);
    const withdrawn = bgp.freeRepeats?.find(
      (r) => r.countKey === "bgpWithdrawnRoutes",
    );
    const pathAttrs = bgp.freeRepeats?.find(
      (r) => r.countKey === "bgpPathAttributes",
    );
    expect(withdrawn?.defaultCount).toBeUndefined();
    expect(pathAttrs?.defaultCount).toBeUndefined();
  });

  it("does not surface a per-iteration ref-count repeat as a global stepper (A7)", () => {
    // bgpUpdateFull's bgpAsSegValue repeat has count: ref(bgpAsSegLength), and
    // bgpAsSegLength is a per-segment field nested inside the bgpAsPathSegments
    // repeat. A single global stepper can't give distinct per-segment counts
    // and would corrupt the rendered Segment Length cell — so it must NOT be
    // surfaced as a freeRepeat.
    const bgp = psdlToRenderer(PRESETS.bgpUpdateFull!);
    const keys = (bgp.freeRepeats ?? []).map((r) => r.countKey);
    expect(keys).not.toContain("bgpAsSegLength");
  });

  it("does not crash a bounded-nested preset on load (over-consume stays guarded)", () => {
    // Must not throw — bgpUpdateFull renders its base header + the safe NLRI
    // record without tripping the bounded budget.
    expect(() => loadCellCount("bgpUpdateFull")).not.toThrow();
  });
});
