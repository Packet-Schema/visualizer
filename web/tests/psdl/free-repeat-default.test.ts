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

  it("never surfaces a freeRepeat stepper that over-consumes its bounded scope", () => {
    // override-design-audit: a bounded-nested eos/until repeat used to get a
    // naked stepper (insideBounded only gated defaultCount, not surfacing), so
    // bumping it pushed the count past the scope's 0-default budget → normalize
    // throws "bounded scope over-consumed" → the layout guard freezes the
    // diagram. No SURFACED stepper may do that, across all presets.
    for (const key of Object.keys(PRESETS)) {
      const src = PRESETS[key]!;
      const mirror = psdlToRenderer(src);
      const controllers = initialState(mirror);
      for (const fr of mirror.freeRepeats ?? []) {
        const env = new Map<string, number>(
          Object.entries(controllers).map(([k, v]) => [k, Number(v)]),
        );
        for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
        for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
        env.set(fr.countKey, 3);
        const base = applyChainInstances(
          applyTlvInstances(src, mirror, {}),
          mirror,
        );
        expect(
          () => resolveLayout(base, { env }),
          `${key} stepper ${fr.countKey}=3 must not over-consume`,
        ).not.toThrow();
      }
    }
  });

  it("does not crash a bounded-nested preset on load (over-consume stays guarded)", () => {
    // Must not throw — bgpUpdateFull renders its base header + the safe NLRI
    // record without tripping the bounded budget.
    expect(() => loadCellCount("bgpUpdateFull")).not.toThrow();
  });

  it("does not surface inert freeRepeat steppers nested in a non-instantiable parent", () => {
    // bgpUpdateFull's bgpAsPathSegments (AS_PATH) and bgpCommunities are eos
    // repeats that live inside bgpPathAttributes — a bounded-nested repeat
    // deliberately left NON-instantiated (it is in NEITHER freeRepeats NOR
    // boundedRepeats and over-consumes its bounded scope when forced). With no
    // surfaced parent count control, driving the child steppers can never make
    // a record appear, so they used to render as two steppers that do nothing
    // (inert/misleading — exactly what the bar forbids). They must NOT be
    // surfaced as packet-level freeRepeats.
    const bgp = psdlToRenderer(PRESETS.bgpUpdateFull!);
    const keys = (bgp.freeRepeats ?? []).map((r) => r.countKey);
    expect(keys).not.toContain("bgpAsPathSegments");
    expect(keys).not.toContain("bgpCommunities");
    // The genuinely-drivable top-level NLRI repeat is kept.
    expect(keys).toContain("bgpNlri");
  });

  it("bgpUpdateFull surfaces only freeRepeat steppers that move the diagram", () => {
    // The inert-stepper bug: bgpAsPathSegments/bgpCommunities used to be
    // surfaced but left the diagram byte-identical (a fixed 14 cells) for every
    // value 0/1/2/3 because no control could instantiate their parent record.
    // Every freeRepeat bgpUpdateFull NOW surfaces must move the cell count
    // somewhere across {0,1,2,3} — proving none is inert.
    const src = PRESETS.bgpUpdateFull!;
    const mirror = psdlToRenderer(src);
    const controllers = initialState(mirror);
    const base = applyChainInstances(
      applyTlvInstances(src, mirror, {}),
      mirror,
    );
    for (const fr of mirror.freeRepeats ?? []) {
      const counts = new Set<number>();
      for (const value of [0, 1, 2, 3]) {
        const env = new Map<string, number>(
          Object.entries(controllers).map(([k, v]) => [k, Number(v)]),
        );
        for (const [k, v] of initialEnv(base)) if (!env.has(k)) env.set(k, v);
        for (const r of collectPsdlRefs(base)) if (!env.has(r)) env.set(r, 0);
        // Account for a count↔ref affine transform (op-count repeats): the
        // stepper DISPLAYS `value` but WRITES the inverted ref value.
        const t = fr.transform;
        env.set(fr.countKey, t ? value * t.mul + t.add : value);
        counts.add(resolveLayout(base, { env }).cells.length);
      }
      expect(
        counts.size,
        `bgpUpdateFull freeRepeat ${fr.countKey} is inert: same diagram for 0/1/2/3`,
      ).toBeGreaterThan(1);
    }
  });

  it("does not surface an inert freeRepeat whose count ref points at a virtual field", () => {
    // kerberosAsReq: padataList.count = ref(padataCount), but padataCount is a
    // `virtual` field with expr lit(1). core normalize walkVirtual does
    // `env.set(v.id, eval(expr))` BEFORE the repeat is walked, so it always
    // CLOBBERS any seeded env value — the diagram is frozen at exactly one
    // PA-DATA record for every stepper value. A stepper on padataCount can
    // never move the diagram (see-but-cannot-edit / inert control), so the
    // freeRepeat must NOT be surfaced.
    const krb = psdlToRenderer(PRESETS.kerberosAsReq!);
    const keys = (krb.freeRepeats ?? []).map((r) => r.countKey);
    expect(keys).not.toContain("padataCount");

    // Prove the inertness the suppression avoids: stepping padataCount over
    // {0,1,2,3} leaves the diagram byte-identical (a single record set),
    // confirming a surfaced stepper would have been dead.
    const src = PRESETS.kerberosAsReq!;
    const base = applyChainInstances(applyTlvInstances(src, krb, {}), krb);
    const counts = new Set<number>();
    for (const value of [0, 1, 2, 3]) {
      const env = new Map<string, number>();
      for (const [k, v] of initialEnv(base)) env.set(k, v);
      for (const r of collectPsdlRefs(base)) if (!env.has(r)) env.set(r, 0);
      env.set("padataCount", value);
      counts.add(resolveLayout(base, { env }).cells.length);
    }
    expect(counts.size).toBe(1);
  });

  it("keeps free eos/until steppers for children of an INSTANTIABLE parent repeat", () => {
    // The suppression must be scoped: dnsResponse's dnsQNameLabels (inside the
    // instantiable ref-count dnsQuestions) and dnsRdataSoaMname/Rname (inside
    // the instantiable ref-count dnsAnswers) are free eos/until repeats nested
    // in a parent that DOES have a surfaced count control, so their steppers are
    // real and must stay.
    const dns = psdlToRenderer(PRESETS.dnsResponse!);
    const keys = (dns.freeRepeats ?? []).map((r) => r.countKey);
    expect(keys).toContain("dnsQNameLabels");
    expect(keys).toContain("dnsRdataSoaMname");
    expect(keys).toContain("dnsRdataSoaRname");
  });
});
