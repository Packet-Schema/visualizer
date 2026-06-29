// medium (two surfaces fighting one key): in the msdp preset's Source-Active
// (Type=1) arm, `msdpSAEntryCount` is BOTH a repeat-count ref
// (`repeat msdpSAEntries count:ref(msdpSAEntryCount)`) AND referenced inside
// `msdpSAEncapData = bytes(msdpLength-8-12*msdpSAEntryCount)`. The second use made
// collectSiblingLengthControllers nominate it as a sibling length controller, so
// psdlToRenderer surfaced it BOTH as a freeRepeat ('Source-Active → SA Entries',
// countKey=msdpSAEntryCount) AND as a lengthController ('Entry Count',
// controlsLength=msdpSAEntryCount) — two independent panel controls in two
// sections writing the SAME env key, fighting over it. Worse, the single
// 'length' slider would simultaneously ADD 12-byte SA-entry records and SHRINK
// the encap byte region. The freeRepeat add/remove stepper is the correct single
// control; the encap width follows the count like any budget-derived length.
//
// psdlToRenderer now excludes any length-field id that is also a repeat-count ref
// surfaced as a freeRepeat. msdp is the only such collision across the 184
// presets.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

/** Number of diagram cells whose id starts with `prefix`, for an override set. */
function cellCount(
  psdl: PsdlPacket,
  overrides: Record<string, number>,
  prefix: string,
): number {
  const env = new Map<string, number>(Object.entries(overrides));
  for (const [k, v] of initialEnv(psdl)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  return resolveLayout(psdl, { env }).cells.filter((c) =>
    (c.field.id ?? "").startsWith(prefix),
  ).length;
}

describe("msdp count-vs-length collision", () => {
  it("surfaces msdpSAEntryCount as a freeRepeat countKey, NOT a lengthController", () => {
    const mirror = psdlToRenderer(PRESETS.msdp!);

    // The 'SA Entries' add/remove stepper owns msdpSAEntryCount.
    const fr = (mirror.freeRepeats ?? []).find(
      (r) => r.countKey === "msdpSAEntryCount",
    );
    expect(fr).toBeDefined();
    expect(fr!.gate).toEqual({ key: "msdpType", value: 1 });

    // It is NOT ALSO surfaced as a length controller fighting the stepper.
    expect(
      (mirror.lengthControllers ?? []).some((l) => l.id === "msdpSAEntryCount"),
    ).toBe(false);

    // It is not a top-level cell either, so the freeRepeat stepper is its sole
    // surfaced control.
    expect(mirror.fields.some((f) => f.id === "msdpSAEntryCount")).toBe(false);
  });

  it("still lets the SA-entry stepper drive the diagram", () => {
    const psdl = PRESETS.msdp!;
    // msdpType=1 (Source-Active) activates the SA-entry repeat. Raising the
    // stepper key must add SA-entry record cells.
    const base = { msdpType: 1, msdpLength: 200 };
    const zero = cellCount(
      psdl,
      { ...base, msdpSAEntryCount: 0 },
      "msdpEntryReserved",
    );
    const three = cellCount(
      psdl,
      { ...base, msdpSAEntryCount: 3 },
      "msdpEntryReserved",
    );
    expect(three).toBeGreaterThan(zero);
  });
});
