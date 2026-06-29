// tlv-variable-record-bytes (high): a TLV catalog record that contains a
// variable-length value (`bytes:ref` / delimited / varint / berLength) collapses
// that payload to `bits: 0` at catalog-build time. Summing the raw catalog field
// bits therefore undercounts the record: a DHCPv4 Router Option (Code 1 B +
// Length 1 B + a `bytes:ref` address list) reported `16 b / 2 B` even though the
// on-wire record with one IPv4 address is 6 B, and that undersized total was fed
// to the TLV-derived length controller via `tlv.drivesController`.
//
// The variable-value fix (see tlv-variable-value.test.ts) attaches a
// `variableBytes` byte-count knob to the catalog entry plus a `fieldsFor`
// closure that sizes each tagged member from `extras` (defaulted via
// `defaultExtras`). `resolveTlvFields` routes through `fieldsFor`, so
// `tlvRecordBits` / `tlvTotalBits` (the editor readout) AND `resolveTlv` (the
// diagram length controller) size the record to its true on-wire width.
//
// This test pins the corrected record byte count so a regression that drops the
// sizing (back to the 0-bit collapse) is caught: dhcpv4 kind=3 = 48 bits (6 B),
// the per-instance override (8 B payload → 80 bits), and that fixed-width
// records (kind=1 Subnet Mask) get no spurious sizing.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import {
  resolveTlvFields,
  tlvRecordBits,
  tlvTotalBits,
} from "@/lib/psdl/renderer-helpers";

describe("TLV record byte count includes variable-length payloads", () => {
  it("sizes the DHCPv4 Router Option (kind=3) to its on-wire 6 B", () => {
    const mirror = psdlToRenderer(PRESETS.dhcpv4!);
    const options = mirror.fields.find((f) => f.id === "options" && f.tlv);
    if (!options?.tlv) throw new Error("dhcpv4 options TLV field missing");

    const router = options.tlv.catalog.find((c) => c.kind === 3);
    if (!router) throw new Error("Router Option (kind=3) missing from catalog");

    // The variable `bytes:ref` payload must carry a per-instance byte-count
    // knob with a representative default seeded into the entry's defaultExtras.
    const vb = router.variableBytes?.find(
      (v) => v.fieldId === "routerAddresses",
    );
    expect(vb, "the routerAddresses payload must carry a knob").toBeDefined();
    expect(router.defaultExtras?.[vb!.key]).toBeGreaterThan(0);

    // The record now reports its true on-wire width: 1 B code + 1 B length +
    // one 4 B address = 6 B (48 bits), not the old 2 B (16 bits).
    const inst = { kind: 3 };
    expect(tlvRecordBits(router, inst)).toBe(48);

    // resolveTlvFields resolves the variable field to 8 * bytes (not 0).
    const sized = resolveTlvFields(router, inst);
    const addr = sized.find((f) => f.id === "routerAddresses");
    expect(addr?.bits).toBe(32);

    // The TLV total (which drives the length controller via bytesPerUnit) picks
    // up the same corrected width instead of an undersized total.
    options.tlv.instances = [inst];
    expect(tlvTotalBits(options).totalBits).toBe(48);
  });

  it("honours a per-instance byte-length override over the default", () => {
    const mirror = psdlToRenderer(PRESETS.dhcpv4!);
    const options = mirror.fields.find((f) => f.id === "options" && f.tlv);
    if (!options?.tlv) throw new Error("dhcpv4 options TLV field missing");
    const router = options.tlv.catalog.find((c) => c.kind === 3)!;
    const vb = router.variableBytes!.find(
      (v) => v.fieldId === "routerAddresses",
    )!;

    // Two IPv4 addresses → 8 B payload → 1 + 1 + 8 = 10 B record.
    const inst = { kind: 3, extras: { [vb.key]: 8 } };
    expect(tlvRecordBits(router, inst)).toBe(80);
  });

  it("leaves fixed-width records untouched (no spurious sizing)", () => {
    const mirror = psdlToRenderer(PRESETS.dhcpv4!);
    const options = mirror.fields.find((f) => f.id === "options" && f.tlv)!;
    // Subnet Mask (kind=1): Code 8 b + Length 8 b + a fixed int(32) = 48 b, all
    // statically sized, so no variableBytes knob is attached.
    const mask = options.tlv!.catalog.find((c) => c.kind === 1)!;
    expect((mask.variableBytes ?? []).length).toBe(0);
    expect(tlvRecordBits(mask, { kind: 1 })).toBe(48);
  });
});
