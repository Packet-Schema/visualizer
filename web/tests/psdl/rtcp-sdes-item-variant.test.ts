// rtcpSdes regression: the switch `rtcpSdesItemBody` is discriminated on
// `rtcpSdesItemType` (an 8-bit enum: END/CNAME/NAME/EMAIL/…) inside the
// until-repeat `rtcpSdesItems` (count: `until rtcpSdesItemType == 0`).
// `collectLengthDrivingRefs` used to walk the WHOLE repeat-count object, pulling
// the `until`-terminator's `rtcpSdesItemType` ref into `lengthDriving`, so
// `collectRefSwitches`'s `isEncoder` guard wrongly classified the discriminator
// as a length/format encoder and DROPPED the picker. The SDES item body was then
// see-but-cannot-edit: at the default value (0 = END) the `_` arm collapses, and
// there was no control to select the data variant. The fix: a repeat's
// `{ until: Expr }` terminator is a record-terminator predicate, NOT a byte
// length, so its refs must not mark the discriminator as a length encoder.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { initialState } from "@/lib/psdl/renderer-helpers";
import { seedDynamicWidthDefaults } from "@/lib/psdl/dynamic-width-defaults";
import { evalExprOr } from "@/lib/psdl/expr";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

function appCellIdsSeeded(
  psdl: PsdlPacket,
  overrides: Record<string, number>,
): string[] {
  const mirror = psdlToRenderer(psdl);
  const env = new Map<string, number>(Object.entries(overrides));
  const state = initialState(mirror);
  for (const [k, v] of Object.entries(state))
    if (!env.has(k)) env.set(k, Number(v));
  for (const [k, v] of initialEnv(psdl)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  seedDynamicWidthDefaults(psdl, env);
  for (const br of mirror.boundedRepeats ?? []) {
    const budget = evalExprOr(br.bytesExpr, env, 0);
    const forRecords = Math.max(0, budget - br.prefixBytes);
    env.set(br.countKey, Math.floor(forRecords / br.perRecordBytes));
  }
  return resolveLayout(psdl, { env, viewMode: "semantic" }).cells.flatMap(
    (c) => [c.field.id, ...(c.subCells ?? []).map((s) => s.subfield.id)],
  );
}

describe("rtcpSdes SDES item-type variant picker", () => {
  it("surfaces a refSwitch on rtcpSdesItemType (item body becomes editable)", () => {
    const mirror = psdlToRenderer(PRESETS.rtcpSdes!);
    const rs = (mirror.refSwitches ?? []).find(
      (r) => r.refKey === "rtcpSdesItemType",
    );
    expect(
      rs,
      "rtcpSdesItemType variant picker must be surfaced (not dropped as a length encoder)",
    ).toBeTruthy();
    // The discriminator is an 8-bit enum: the END (0) arm and the non-END data
    // arm (`_`, surfaced as the first real enum variant = 1 = CNAME) must both be
    // selectable so the SDES item body can be chosen.
    const values = rs!.cases.map((c) => c.value);
    expect(values).toContain(0);
    expect(values).toContain(1);
  });

  it("selecting the data variant renders the item-length control", () => {
    const src = PRESETS.rtcpSdes!;
    // One source chunk; default item type (0 = END) vs the data variant (1).
    const asEnd = appCellIdsSeeded(src, { sc: 1, rtcpSdesItemType: 0 });
    const asData = appCellIdsSeeded(src, { sc: 1, rtcpSdesItemType: 1 });
    // END selects the empty arm; the data variant reveals the Item Length cell.
    expect(asEnd).not.toContain("rtcpSdesItemLen#0_0");
    expect(asData).toContain("rtcpSdesItemLen#0_0");
    expect(asData).not.toEqual(asEnd);
  });

  it("raising the item-length control reveals the item value", () => {
    const src = PRESETS.rtcpSdes!;
    // rtcpSdesItemValue is bytes(ref rtcpSdesItemLen); it is sized/revealed by the
    // surfaced Item Length length-controller, so the value is NOT see-but-cannot-edit.
    const sized = appCellIdsSeeded(src, {
      sc: 1,
      rtcpSdesItemType: 1,
      rtcpSdesItemLen: 4,
    });
    expect(sized).toContain("rtcpSdesItemValue#0_0");

    // And the Item Length is offered as a length controller in the panel.
    const mirror = psdlToRenderer(src);
    const lc = (mirror.lengthControllers ?? []).find(
      (l) => l.id === "rtcpSdesItemLen",
    );
    expect(
      lc,
      "rtcpSdesItemLen must be surfaced as a length controller",
    ).toBeTruthy();
  });

  it("does not perturb other presets' refSwitches (blast radius contained)", () => {
    // dnsResponse's record-type code stays surfaced; ipv4's TLV options stay out.
    const dns = psdlToRenderer(PRESETS.dnsResponse!);
    expect((dns.refSwitches ?? []).map((r) => r.refKey)).toContain("dnsRrType");
    const ipv4 = psdlToRenderer(PRESETS.ipv4!);
    expect(ipv4.refSwitches ?? []).toHaveLength(0);
  });
});
