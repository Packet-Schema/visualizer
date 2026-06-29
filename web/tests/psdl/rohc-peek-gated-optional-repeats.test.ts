// rohcUncompressed: peek-gated optional repeats (rohcPadding / rohcFeedback)
// were permanently inert — see-but-cannot-edit.
//
// rohcUncompressed has two `optional{when: peek(N)==lit}` regions, each wrapping
// a `group` holding an `until`-repeat:
//   rohcPadding:  optional(peek(8)==224){ group{ repeat until { paddingByte } } }
//   rohcFeedback: optional(peek(5)==30){  group{ repeat until { feedbackPrefix } } }
// The mirror surfaces BOTH as freeRepeats (defaultCount 1) with a gateFieldId,
// and collectPeekSwitches deliberately SUPPRESSES the entry peek-gate picker for
// them (the count stepper is the live control). But initialState never seeded the
// gate peek to its present value, so at load the optional regions were not
// entered: paddingByte / feedbackPrefix were ABSENT from the diagram, OverridePanel
// disabled BOTH steppers (`fieldRendered(cells, gateFieldId)===false`), and there
// was NO surfaced control to set __peek__0__8 / __peek__0__5 — the regions could
// NEVER be entered from the UI.
//
// The fix carries `peekGate` on the freeRepeat (from the optional's peek `when`)
// and has initialState seed env[key]=value, entering the region on load so the
// stepper is live and gateFieldId renders. Only rohcUncompressed is affected.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { initialState } from "@/lib/psdl/renderer-helpers";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

// Every field id materialised in the diagram, INCLUDING repeat-element subcells:
// a multi-field repeat element (rohcFeedback's feedbackPrefix/feedbackCode/…)
// collapses into one `rohcFeedbackRegion#i` region cell whose inner fields are
// subCells — exactly what OverridePanel's `fieldRendered` gate matches on.
function cellIds(
  psdl: PsdlPacket,
  overrides: Record<string, number>,
): string[] {
  const env = new Map<string, number>(Object.entries(overrides));
  for (const [k, v] of initialEnv(psdl)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  const ids: string[] = [];
  for (const c of resolveLayout(psdl, { env }).cells) {
    ids.push(c.field.id);
    for (const s of c.subCells ?? []) ids.push(s.subfield.id);
  }
  return ids;
}

describe("rohcUncompressed: peek-gated optional repeats", () => {
  it("surfaces a peekGate on the rohcPadding / rohcFeedback freeRepeats", () => {
    const mirror = psdlToRenderer(PRESETS.rohcUncompressed!);
    const byKey = new Map(
      (mirror.freeRepeats ?? []).map((fr) => [fr.countKey, fr]),
    );

    const padding = byKey.get("rohcPadding");
    const feedback = byKey.get("rohcFeedback");
    expect(padding).toBeDefined();
    expect(feedback).toBeDefined();

    // The entry peek-gate present value is carried so initialState can enter the
    // region (the gate picker itself is suppressed for these — the stepper is the
    // live control).
    expect(padding!.peekGate).toEqual({ key: "__peek__0__8", value: 224 });
    expect(feedback!.peekGate).toEqual({ key: "__peek__0__5", value: 30 });
    // The fieldRendered gate anchor stays — the panel still disables the stepper
    // if the user lowers the gate (or count) so the records disappear.
    expect(padding!.gateFieldId).toBe("paddingByte");
    expect(feedback!.gateFieldId).toBe("feedbackPrefix");
  });

  it("seeds the entry peeks so the regions are entered on load", () => {
    const mirror = psdlToRenderer(PRESETS.rohcUncompressed!);
    const seed = initialState(mirror);

    // The previously-missing seeds that enter the two optional regions.
    expect(seed["__peek__0__8"]).toBe(224);
    expect(seed["__peek__0__5"]).toBe(30);
  });

  it("renders paddingByte#0 / feedbackPrefix from the seeded state (no longer inert)", () => {
    const psdl = PRESETS.rohcUncompressed!;
    const mirror = psdlToRenderer(psdl);
    const seed = initialState(mirror);

    const ids = cellIds(psdl, seed);
    // The defaultCount-1 freeRepeats now render one record each because the
    // peek-gate seed entered both optional regions. paddingByte is a single-field
    // repeat element (`paddingByte#0`); feedbackPrefix is a subcell of the
    // collapsed `rohcFeedbackRegion#0` record. Both are the `gateFieldId` anchors
    // OverridePanel's `fieldRendered` checks — so the steppers are now LIVE, not
    // disabled-with-hint.
    expect(ids).toContain("paddingByte#0");
    expect(ids).toContain("feedbackPrefix");
  });

  it("the stepper drives the record count once the region is entered", () => {
    const psdl = PRESETS.rohcUncompressed!;
    const mirror = psdlToRenderer(psdl);
    const seed = initialState(mirror);

    // Raising rohcPadding adds records (region already entered by the seed).
    const three = cellIds(psdl, { ...seed, rohcPadding: 3 }).filter((id) =>
      id.startsWith("paddingByte"),
    );
    expect(three).toEqual(["paddingByte#0", "paddingByte#1", "paddingByte#2"]);

    // Lowering it to 0 still hides the records — the seed only ENTERS the region.
    const none = cellIds(psdl, { ...seed, rohcPadding: 0 }).filter((id) =>
      id.startsWith("paddingByte"),
    );
    expect(none).toEqual([]);
  });
});
