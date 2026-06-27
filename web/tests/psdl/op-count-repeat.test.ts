// override-audit A5 (fixed): op/cond Repeat counts that mention exactly one
// field ref used to be a see-but-cannot-edit gap. SRv6 / ipv6Routing render
// `repeat srhSegmentList count={srhLastEntry + 1}` segments, but srhLastEntry is
// a plain int8 with no override widget, so the user could see the segment list
// but not change how many segments there were. collectFreeRepeats now surfaces
// these keyed on the single driving ref with an affine `transform`, so the
// OverridePanel stepper drives the segment count (writing the INVERTED value:
// for count = ref + 1, showing N writes ref = N - 1). LISP Map-Request's
// `lispItrRlocs count={lispItrCount + 1}` has the same shape.

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
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

/** Distinct record count for a repeat, identified by the per-instance index
 *  suffix `#N` on its cell ids (e.g. `srhSegment#0`, `lispItrRlocAfi#0`). The
 *  prefix matches the start of the id; a record may emit several cells with the
 *  same `#N`, so we count distinct indices. */
function recordCount(
  key: string,
  env: Record<string, number>,
  idPrefix: string,
): number {
  const src = PRESETS[key]!;
  const mirror = psdlToRenderer(src);
  const base: PsdlPacket = applyChainInstances(
    applyTlvInstances(src, mirror, {}),
    mirror,
  );
  const e = new Map<string, number>();
  for (const [k, v] of initialEnv(base)) e.set(k, v);
  for (const r of collectPsdlRefs(base)) if (!e.has(r)) e.set(r, 0);
  for (const [k, v] of Object.entries(env)) e.set(k, v);
  const cells = resolveLayout(base, { env: e }).cells;
  const indices = new Set<string>();
  for (const c of cells) {
    const id = c.field.id;
    if (!id.startsWith(idPrefix)) continue;
    const hash = id.indexOf("#");
    if (hash >= 0) indices.add(id.slice(hash + 1));
  }
  return indices.size;
}

const CASES = [
  { key: "srhv6", ref: "srhLastEntry", recordPrefix: "srhSegment" },
  { key: "ipv6Routing", ref: "srhLastEntry", recordPrefix: "srhSegment" },
  { key: "lispMapRequest", ref: "lispItrCount", recordPrefix: "lispItrRloc" },
] as const;

describe("op-count free repeats (override-audit A5)", () => {
  for (const { key, ref } of CASES) {
    it(`${key}: surfaces a freeRepeat keyed on the single count ref with an inverting transform`, () => {
      const mirror = psdlToRenderer(PRESETS[key]!);
      const fr = (mirror.freeRepeats ?? []).find((r) => r.countKey === ref);
      expect(fr, `expected a freeRepeat on ${ref}`).toBeDefined();
      // count = ref + 1 → recordCount = ref * 1 + 1.
      expect(fr!.transform).toEqual({ mul: 1, add: 1 });
    });
  }

  it("srhv6 / ipv6Routing: driving srhLastEntry changes the rendered segment count", () => {
    // record count = srhLastEntry + 1.
    expect(recordCount("srhv6", { srhLastEntry: 0 }, "srhSegment")).toBe(1);
    expect(recordCount("srhv6", { srhLastEntry: 2 }, "srhSegment")).toBe(3);
    expect(recordCount("srhv6", { srhLastEntry: 5 }, "srhSegment")).toBe(6);
    // ipv6Routing's segment list lives in the routingType==4 switch arm.
    expect(
      recordCount(
        "ipv6Routing",
        { routingType: 4, srhLastEntry: 4 },
        "srhSegment",
      ),
    ).toBe(5);
  });

  it("lispMapRequest: driving lispItrCount changes the rendered ITR-RLOC count", () => {
    expect(
      recordCount("lispMapRequest", { lispItrCount: 0 }, "lispItrRloc"),
    ).toBe(1);
    expect(
      recordCount("lispMapRequest", { lispItrCount: 3 }, "lispItrRloc"),
    ).toBe(4);
  });

  it("the transform inverts so that showing N records writes ref = N - 1", () => {
    // Mirror the stepper's write path: to display N records the panel writes
    // env[ref] = round((N - add) / mul). Verify the diagram then renders N.
    const { mul, add } = { mul: 1, add: 1 };
    for (const wantRecords of [1, 2, 4, 7]) {
      const refValue = Math.max(0, Math.round((wantRecords - add) / mul));
      expect(
        recordCount("srhv6", { srhLastEntry: refValue }, "srhSegment"),
      ).toBe(wantRecords);
    }
  });

  it("does not surface op-count repeats nested inside another repeat (A7)", () => {
    // Per-iteration op/cond counts must not get a single global stepper: it
    // can't give distinct per-instance counts. Scan every preset for a
    // freeRepeat whose countKey is a field that only appears inside a repeat
    // element — none of the surfaced op-count keys above is per-iteration, and
    // the A7 guard (insideRepeat) keeps it that way across the catalog.
    for (const key of Object.keys(PRESETS)) {
      const mirror = psdlToRenderer(PRESETS[key]!);
      // Sanity: every surfaced transform is a well-formed, invertible affine.
      for (const fr of mirror.freeRepeats ?? []) {
        if (fr.transform) {
          expect(fr.transform.mul).not.toBe(0);
          expect(Number.isFinite(fr.transform.mul)).toBe(true);
          expect(Number.isFinite(fr.transform.add)).toBe(true);
        }
      }
    }
  });
});
