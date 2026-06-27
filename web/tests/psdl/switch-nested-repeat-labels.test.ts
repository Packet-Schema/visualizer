// override-design-audit: a repeat surfaced as a packet-level freeRepeat stepper
// from INSIDE a switch case used to carry only the repeat's own name. When
// several such repeats live in DIFFERENT cases of a top-level message-type
// switch they collided into N identically-labelled steppers, only one of which
// (the currently-selected variant's) actually drives the diagram — the others
// were inert and the duplicate labels gave the user no way to tell which was
// live. The fix qualifies each surfaced stepper's name with its enclosing case
// label (the discriminator enum variant, or the discriminator field name +
// value), so the labels become distinct and case-attributed.
//
//   icmpv6Ndp: rsOptions/raOptions/nsOptions/naOptions/rdOptions all named
//     'Options', one per Type case (133..137) of a plain-int `type` switch →
//     "Type=133 → Options (eos)", … (distinct).
//   msdp: msdpSAEntries (msdpType case 1) and msdpRespSAEntries (case 3) both
//     named 'SA Entries' under an ENUM-typed `msdpType` switch →
//     "Source-Active → SA Entries", "SA-Response → SA Entries".

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";

describe("switch-case-nested freeRepeat labels are disambiguated", () => {
  it("icmpv6Ndp's 5 Options steppers get distinct, case-qualified names", () => {
    const mirror = psdlToRenderer(PRESETS.icmpv6Ndp!);
    const free = mirror.freeRepeats ?? [];
    const names = free.map((r) => r.name);

    // All five names are distinct (no collision).
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(5);

    // The plain-int `type` discriminator has no enum table, so each label uses
    // the discriminator field's display name ("Type") and the case value.
    const byKey = new Map(free.map((r) => [r.countKey, r.name]));
    expect(byKey.get("rsOptions")).toBe("Type=133 → Options (eos)");
    expect(byKey.get("raOptions")).toBe("Type=134 → Options (eos)");
    expect(byKey.get("nsOptions")).toBe("Type=135 → Options (eos)");
    expect(byKey.get("naOptions")).toBe("Type=136 → Options (eos)");
    expect(byKey.get("rdOptions")).toBe("Type=137 → Options (eos)");

    // The disambiguation is label-only: keys/defaults are unchanged so the
    // controls keep driving the same env state (nested-tlv fix intact).
    for (const r of free) expect(r.defaultCount).toBe(1);
  });

  it("msdp's two SA Entries steppers use the enum variant labels", () => {
    const mirror = psdlToRenderer(PRESETS.msdp!);
    const free = mirror.freeRepeats ?? [];
    const names = free.map((r) => r.name);

    expect(new Set(names).size).toBe(names.length);
    const byKey = new Map(free.map((r) => [r.countKey, r.name]));
    // msdp's SA-entry repeats use a ref count, so the stepper keys are the
    // count fields. msdpType is an enum: case 1 → "Source-Active" (the SA
    // message), case 3 → "SA-Response".
    expect(byKey.get("msdpSAEntryCount")).toBe("Source-Active → SA Entries");
    expect(byKey.get("msdpRespEntryCount")).toBe("SA-Response → SA Entries");
  });

  it("no built-in preset surfaces duplicate-named freeRepeat steppers", () => {
    // The bar: "no inert/misleading controls". Identically-labelled packet-level
    // steppers under "Repeats in this packet" are exactly such a surface. After
    // the fix, NO preset has two freeRepeats sharing a name.
    const offenders: string[] = [];
    for (const key of Object.keys(PRESETS)) {
      const names = (psdlToRenderer(PRESETS[key]!).freeRepeats ?? []).map(
        (r) => r.name,
      );
      if (new Set(names).size !== names.length) offenders.push(key);
    }
    expect(offenders).toEqual([]);
  });

  it("top-level (non-case) repeats keep their plain, unqualified names", () => {
    // A repeat that is NOT inside a switch case must not gain a "→" prefix.
    // coap's option list is a top-level until-count freeRepeat.
    const mirror = psdlToRenderer(PRESETS.coap!);
    const free = mirror.freeRepeats ?? [];
    expect(free.length).toBeGreaterThan(0);
    for (const r of free) {
      expect(r.name).not.toContain("→");
    }
  });
});
