// see-but-cannot-edit (inner per-record ref-count): a `repeat{ count: ref X }`
// nested INSIDE an enclosing repeat record used to get ZERO override surface.
// The count-driver X (igmpv3Report igmpv3SrcCount, mldv2Report mldv2SrcCount,
// pimJoinPrune grpNumJoined/grpNumPruned, lispMapReply lispRecLocCount,
// pimBootstrap gsFragRpCount) lives inside the record, so it is not a top-level
// mirror field, not a freeRepeat/boundedRepeat/lengthController — clicking its
// diagram cell hit OverridePanel's "no runtime override. Read-only display."
// terminal branch even though env[X] DOES change the diagram. collectFreeRepeats
// now surfaces these as packet-level steppers (labelled "(per record)") whenever
// the enclosing repeat is instantiable and the scope is not a budget-derived
// bounded one — a single env key drives every record's count identically, so the
// global stepper is consistent with the rendered value.
//
// The bgpUpdateFull bgpAsSegValue (count: ref bgpAsSegLength) inner repeat is the
// one exception: it is `insideBounded` (lives under the bgpPathAttributes byte
// budget), so a stepper there would over-consume and is inert at load — it stays
// suppressed (covered by free-repeat-default.test.ts).

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

/** Cell count at app-realistic env (initialState controllers + initialEnv +
 *  0-fill) with the given overrides applied on top. */
function cellCount(
  src: PsdlPacket,
  controllers: Record<string, string | number | boolean>,
  overrides: Record<string, number>,
): number {
  const base: PsdlPacket = applyChainInstances(
    applyTlvInstances(src, psdlToRenderer(src), {}),
    psdlToRenderer(src),
  );
  const env = new Map<string, number>(
    Object.entries(controllers).map(([k, v]) => [k, Number(v)]),
  );
  for (const [k, v] of Object.entries(overrides)) env.set(k, v);
  for (const [k, v] of initialEnv(base)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(base)) if (!env.has(r)) env.set(r, 0);
  return resolveLayout(base, { env }).cells.length;
}

describe("inner per-record ref-count repeat", () => {
  // Each preset's inner ref-count driver and the surfaced freeRepeat label tag.
  const surfaced: { preset: string; driver: string }[] = [
    { preset: "igmpv3Report", driver: "igmpv3SrcCount" },
    { preset: "mldv2Report", driver: "mldv2SrcCount" },
    { preset: "pimJoinPrune", driver: "grpNumJoined" },
    { preset: "pimJoinPrune", driver: "grpNumPruned" },
    { preset: "lispMapReply", driver: "lispRecLocCount" },
    { preset: "pimBootstrap", driver: "gsFragRpCount" },
  ];

  it("surfaces each inner ref-count driver as a packet-level freeRepeat stepper", () => {
    for (const { preset, driver } of surfaced) {
      const mirror = psdlToRenderer(PRESETS[preset]!);
      const fr = (mirror.freeRepeats ?? []).find((r) => r.countKey === driver);
      expect(
        fr,
        `${preset}: ${driver} must be surfaced as a freeRepeat (was see-but-cannot-edit)`,
      ).toBeDefined();
      // Labelled so the user knows it applies uniformly to every record.
      expect(fr!.name).toContain("per record");
      // Scalar-list inner ref-count repeats carry no representative-record seed.
      // A RECORD-BEARING inner repeat (lispMapReply's locators wrap the
      // `lispLocAddrByAFI` AFI switch) IS seeded to one record so that nested
      // picker is live on load instead of inert over an empty region (#11/#12).
      if (preset === "lispMapReply") {
        expect(fr!.defaultCount).toBe(1);
      } else {
        expect(fr!.defaultCount).toBeUndefined();
      }
    }
  });

  it("raising the surfaced inner ref-count stepper adds cells to the diagram", () => {
    for (const { preset, driver } of surfaced) {
      const src = PRESETS[preset]!;
      const mirror = psdlToRenderer(src);
      const controllers = initialState(mirror);
      const counts = [0, 1, 2, 3].map((n) =>
        cellCount(src, controllers, { [driver]: n }),
      );
      // The stepper genuinely moves the diagram (not inert): the cell count
      // strictly increases as the per-record count grows.
      for (let i = 1; i < counts.length; i++) {
        expect(
          counts[i],
          `${preset}: raising ${driver} to ${i} must add cells (got ${counts.join(",")})`,
        ).toBeGreaterThan(counts[i - 1]!);
      }
    }
  });

  it("igmpv3Report: raising igmpv3SrcCount adds Source Address cells", () => {
    const src = PRESETS.igmpv3Report!;
    const mirror = psdlToRenderer(src);
    const controllers = initialState(mirror);
    const base: PsdlPacket = applyChainInstances(
      applyTlvInstances(src, mirror, {}),
      mirror,
    );
    const sourceCells = (srcCount: number) => {
      const env = new Map<string, number>(
        Object.entries(controllers).map(([k, v]) => [k, Number(v)]),
      );
      env.set("igmpv3SrcCount", srcCount);
      for (const [k, v] of initialEnv(base)) if (!env.has(k)) env.set(k, v);
      for (const r of collectPsdlRefs(base)) if (!env.has(r)) env.set(r, 0);
      return resolveLayout(base, { env }).cells.filter((c) =>
        c.field.id.startsWith("igmpv3SourceAddress"),
      ).length;
    };
    // One Group Record is seeded on load (record-bearing parent), so each unit
    // of igmpv3SrcCount adds exactly one Source Address cell to that record.
    expect(sourceCells(0)).toBe(0);
    expect(sourceCells(3)).toBe(3);
  });

  it("does not introduce a freeRepeat that over-consumes or freezes on load", () => {
    // The new inner steppers must obey the same bounded-scope safety as every
    // other surfaced control: no preset may throw at load or when its inner
    // stepper is bumped.
    for (const { preset, driver } of surfaced) {
      const src = PRESETS[preset]!;
      const mirror = psdlToRenderer(src);
      const controllers = initialState(mirror);
      expect(() => cellCount(src, controllers, {})).not.toThrow();
      expect(() => cellCount(src, controllers, { [driver]: 3 })).not.toThrow();
    }
  });
});
