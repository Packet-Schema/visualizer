// Audit gap (critical): `defaultArmSentinel` scanned for the smallest unclaimed
// discriminator value with an unbounded `while` loop, and `peek-switches`
// invoked it for EVERY switch — including ref/plain ones it then discarded.
//
// PSDL 0.5 case keys accept ranges and core's `SWITCH_KEY_RE` accepts
// "0-4294967295", which `validatePsdlPacket` happily passes. Rendering such a
// document made `psdlToRenderer` scan ~4.29e9 values on the browser's main
// thread (~62 minutes), and `caseKeyValues` allocated a Set of the same size.
//
// The fix bounds the search at DEFAULT_ARM_SENTINEL_MAX (matching the cap
// `representativeDefaultArmValue` already used, so the two default-arm paths
// agree), returns null when the listed cases cover it, and gates the
// peek-switch collector on the discriminator kind before doing any case-key
// work. The gate deliberately does NOT `continue` — the recursion into the
// switch's arms still has to run, or a peek switch nested inside a ref
// switch's arm would stop being surfaced.

import { describe, expect, it } from "vitest";

import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import {
  DEFAULT_ARM_SENTINEL_MAX,
  defaultArmSentinel,
} from "@/lib/psdl/psdl-to-renderer/shared";
import { validatePsdlPacket } from "@/lib/psdl/validate";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

const u32 = { kind: "int" as const, bits: 32 };

// A single top-level ref switch — no peek anywhere — whose listed case key is a
// legal wide range, plus a `_` default arm to make the sentinel search run.
function wideRangePacket(hi: number): PsdlPacket {
  return {
    version: "0.5",
    name: "WideRange",
    rowBits: 32,
    byteOrder: "BE",
    body: [
      { id: "tag", name: "Tag", type: u32 },
      {
        kind: "switch",
        id: "sw",
        on: { kind: "ref", field: "tag" },
        cases: {
          [`0-${hi}`]: {
            id: "listed",
            name: "Listed",
            fields: [{ id: "a", name: "A", type: u32 }],
          },
          _: {
            id: "other",
            name: "Other",
            fields: [
              { id: "b", name: "B", type: u32 },
              { id: "c", name: "C", type: u32 },
            ],
          },
        },
      },
    ],
  } as unknown as PsdlPacket;
}

describe("default-arm sentinel is bounded", () => {
  it("returns the first unclaimed value, as before", () => {
    expect(defaultArmSentinel(["0", "1", "2"])).toBe(3);
    expect(defaultArmSentinel(["1", "2"])).toBe(0);
    expect(defaultArmSentinel(["0-9", "11"])).toBe(10);
  });

  it("returns null instead of scanning past the bound", () => {
    expect(defaultArmSentinel([`0-${DEFAULT_ARM_SENTINEL_MAX}`])).toBeNull();
  });

  it("renders a legal 32-bit case range promptly", () => {
    const packet = wideRangePacket(0xffffffff);
    // The document really is valid PSDL — that is what makes this reachable.
    expect(() => validatePsdlPacket(packet)).not.toThrow();

    const started = Date.now();
    const mirror = psdlToRenderer(packet);
    const elapsed = Date.now() - started;

    expect(mirror.fields.length).toBeGreaterThan(0);
    // Pre-fix this was minutes; the bound puts it far below a second. The
    // threshold is deliberately loose so the test measures the algorithm, not
    // the CI runner.
    expect(elapsed).toBeLessThan(2000);
  });

  it("offers no default-arm option when the listed cases cover the range", () => {
    const mirror = psdlToRenderer(wideRangePacket(0xffffffff));
    const tag = mirror.fields.find((f) => f.id === "tag");
    // Every offered value would land in the listed arm, so a "default" entry
    // would be a lie. Better to offer nothing than an option that does nothing.
    for (const c of tag?.switchCases ?? [])
      expect(c.value).toBeLessThanOrEqual(0xffffffff);
  });
});
