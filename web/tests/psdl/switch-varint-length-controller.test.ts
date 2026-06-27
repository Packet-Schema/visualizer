// high (see-but-cannot-edit): a dynamic-width `length` field (a `varint` /
// `berLength`) declared INSIDE a Switch case sizes a VISIBLE sibling
// `bytes(ref X)` region but got NO editable surface. `collectSiblingLengthControllers`
// only nominated `int`/`bits` length cells as controller candidates, so a
// `varint`/`berLength` sizer was dropped; WidgetPicker (OverridePanel) only
// attaches to top-level fields / Group subfields, never a switch arm. The
// result: `env[X]` (the decoded byte count) genuinely drove the layout, yet the
// override panel exposed no slider for it.
//
//   quicLong: `tokenLength` (varint quic) in switch(longTail)[case 0] sizes
//             `token` = bytes(ref tokenLength).
//   snmpV2c:  `pduLengthUnknown` (berLength) in the peek-switch `_` default arm
//             sizes `pduDataUnknown` = bytes(ref pduLengthUnknown).
//
// The fix adds `varint`/`berLength` to the sibling-length controller candidate
// guard. Because the length field lives in a Switch case (neither a top-level
// cell nor a Group subfield), it surfaces as a packet-level `lengthController`
// keyed on `env[X]` — the same slider an `int`/`bits` length-in-switch gets.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

/**
 * Wire bits of the laid-out field whose id matches, for an env. A field wider
 * than a row is split into several cell fragments that each report the field's
 * FULL `bitsTotal`, so the field width is any one fragment's `bitsTotal` (0 when
 * the field is zero-width / not laid out at all).
 */
function regionBits(
  psdl: PsdlPacket,
  fieldId: string,
  overrides: Record<string, number>,
): number {
  const env = new Map<string, number>(Object.entries(overrides));
  for (const [k, v] of initialEnv(psdl)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  const cell = resolveLayout(psdl, { env }).cells.find(
    (c) => c.field?.id === fieldId,
  );
  return cell?.bitsTotal ?? 0;
}

describe("varint/berLength length field inside a Switch case is editable", () => {
  it("quicLong tokenLength surfaces as a length controller keyed on env[tokenLength]", () => {
    const mirror = psdlToRenderer(PRESETS.quicLong!);
    // It is NOT a top-level cell (lives in switch(longTail)[case 0]) nor a Group
    // subfield, so it surfaces as a packet-level lengthController, not a stamped
    // top-level cell.
    expect(mirror.fields.some((f) => f.id === "tokenLength")).toBe(false);
    const lc = (mirror.lengthControllers ?? []).find(
      (l) => l.id === "tokenLength",
    );
    expect(
      lc,
      "tokenLength should be a packet-level length controller",
    ).toBeDefined();
    expect(lc!.controlsLength).toBe("tokenLength");
  });

  it("moving tokenLength resizes the visible token region", () => {
    const psdl = PRESETS.quicLong!;
    // Default env: longPacketType=0 selects case 0; tokenLength unseeded → 0 →
    // token is zero-width (invisible). Raising env[tokenLength] grows token by
    // that many bytes — the slider drives the diagram.
    expect(regionBits(psdl, "token", {})).toBe(0);
    expect(regionBits(psdl, "token", { tokenLength: 4 })).toBe(32);
    expect(regionBits(psdl, "token", { tokenLength: 7 })).toBe(56);
  });

  it("snmpV2c pduLengthUnknown surfaces as a length controller keyed on env[pduLengthUnknown]", () => {
    const mirror = psdlToRenderer(PRESETS.snmpV2c!);
    expect(mirror.fields.some((f) => f.id === "pduLengthUnknown")).toBe(false);
    const lc = (mirror.lengthControllers ?? []).find(
      (l) => l.id === "pduLengthUnknown",
    );
    expect(
      lc,
      "pduLengthUnknown should be a packet-level length controller",
    ).toBeDefined();
    expect(lc!.controlsLength).toBe("pduLengthUnknown");
  });

  it("moving pduLengthUnknown resizes the visible pduDataUnknown region", () => {
    const psdl = PRESETS.snmpV2c!;
    expect(regionBits(psdl, "pduDataUnknown", {})).toBe(0);
    expect(regionBits(psdl, "pduDataUnknown", { pduLengthUnknown: 8 })).toBe(
      64,
    );
  });

  it("every surfaced length controller is keyed on its own controlsLength id", () => {
    // Guard against a controller whose slider key (`controlsLength`) drifts from
    // its own id — the OverrideSlider drives `env[controlsLength]`, so a mismatch
    // would move the wrong region.
    for (const [, psdl] of Object.entries(PRESETS)) {
      const mirror = psdlToRenderer(psdl);
      for (const lc of mirror.lengthControllers ?? []) {
        expect(lc.controlsLength).toBe(lc.id);
      }
    }
  });
});
