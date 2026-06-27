// override-audit A2: a Switch inside a plain (non-TLV/non-chain) repeat —
// e.g. dnsResponse's `dnsRdata` on `dnsRrType` — is dropped from the renderer
// mirror along with its repeat, so the per-record variant had no picker and was
// stuck at its default. `collectRefSwitches` surfaces a packet-level variant
// picker keyed on the discriminator's env id; selecting a case drives the
// rendered variant via core normalize.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { initialState } from "@/lib/psdl/renderer-helpers";
import { evalExprOr } from "@/lib/psdl/expr";
import { seedDynamicWidthDefaults } from "@/lib/psdl/dynamic-width-defaults";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

function cellIds(
  psdl: PsdlPacket,
  overrides: Record<string, number>,
): string[] {
  const env = new Map<string, number>(Object.entries(overrides));
  for (const [k, v] of initialEnv(psdl)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  return resolveLayout(psdl, { env }).cells.flatMap((c) => [
    c.field.id,
    ...(c.subCells ?? []).map((s) => s.subfield.id),
  ]);
}

/**
 * Cell ids derived the way the live app does it: `initialEnv` + `psdlRefs`
 * 0-fill + `seedDynamicWidthDefaults` + the PacketViewer `boundedRepeats`
 * count-derivation (count = floor((budget - prefix) / perRecord)), then
 * `resolveLayout({ viewMode: "semantic" })`. Used to assert whether a
 * refSwitch's discriminator can actually change the diagram at app-realistic
 * env.
 */
function appCellIds(
  psdl: PsdlPacket,
  overrides: Record<string, number>,
): string[] {
  const mirror = psdlToRenderer(psdl);
  const env = new Map<string, number>(Object.entries(overrides));
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

describe("collectRefSwitches", () => {
  it("surfaces the dnsRrType discriminator for the dnsAnswers repeat", () => {
    const dns = psdlToRenderer(PRESETS.dnsResponse!);
    const rrType = dns.refSwitches?.find((r) => r.refKey === "dnsRrType");
    expect(rrType, "dnsRrType variant picker must be surfaced").toBeTruthy();
    // A (1), AAAA (28), etc.
    expect(rrType!.cases.map((c) => c.value)).toContain(28);
  });

  it("selecting a variant changes the rendered record fields", () => {
    const src = PRESETS.dnsResponse!;
    // One answer record; default RR type vs explicitly AAAA (28).
    const asDefault = cellIds(src, { dnsAnCount: 1 });
    const asAaaa = cellIds(src, { dnsAnCount: 1, dnsRrType: 28 });
    // The two renders must differ — proving the discriminator actually drives
    // the variant (otherwise the picker would be inert).
    expect(asAaaa).not.toEqual(asDefault);
  });

  it("does not surface a ref-switch whose discriminator already has a widget", () => {
    // ipv4's options is a TLV repeat (handled by TlvEditor), not a plain repeat,
    // so it must not leak into refSwitches.
    const ipv4 = psdlToRenderer(PRESETS.ipv4!);
    expect(ipv4.refSwitches ?? []).toHaveLength(0);
  });

  it("seeds the refSwitch discriminator to its first case so picker matches diagram", () => {
    // override-design-audit: the discriminator 0-filled to 0 (the `_`/default
    // arm) while the picker showed cases[0] — a label/diagram contradiction.
    // initialState now seeds the discriminator to the first case.
    const dns = psdlToRenderer(PRESETS.dnsResponse!);
    const rs = (dns.refSwitches ?? []).find((r) => r.refKey === "dnsRrType");
    expect(rs).toBeTruthy();
    const state = initialState(dns);
    expect(state.dnsRrType).toBe(rs!.cases[0]!.value);
  });

  it("surfaces a switch whose case key is a comma-list (bgpFlowSpec)", () => {
    // override-design-audit: a case key like "1,2" was Number()-dropped to NaN,
    // so the whole switch lost its picker. bgpFlowSpec's flowSpecCompType has a
    // single numeric case keyed "1,2" — it must still surface a variant picker.
    const bgp = psdlToRenderer(PRESETS.bgpFlowSpec!);
    const keys = (bgp.refSwitches ?? []).map((r) => r.refKey);
    expect(keys).toContain("flowSpecCompType");
  });

  it("excludes length/format-encoder switches, keeping only record-type codes", () => {
    // review HIGH: driving a length encoder (BGP Extended-Length flag,
    // CoAP option nibbles) over-consumes a scope / explodes the render instead
    // of choosing a record variant — they must NOT be surfaced.
    const bgp = psdlToRenderer(PRESETS.bgpUpdateFull!);
    const bgpKeys = (bgp.refSwitches ?? []).map((r) => r.refKey);
    expect(bgpKeys).not.toContain("attrExtLen"); // 1-bit flag — dropped

    // CoAP's optDelta/optLength are 4-bit nibbles whose cases add
    // length-extension fields — both dropped (no record-variant switch left).
    const coap = psdlToRenderer(PRESETS.coap!);
    expect(coap.refSwitches ?? []).toHaveLength(0);

    // dnsResponse's dnsRrType is an 8-bit record-type code whose dnsAnswers
    // repeat IS instantiable (count: ref(dnsAnCount)) — it stays surfaced.
    const dns = psdlToRenderer(PRESETS.dnsResponse!);
    const dnsKeys = (dns.refSwitches ?? []).map((r) => r.refKey);
    expect(dnsKeys).toContain("dnsRrType");
  });

  it("suppresses a refSwitch whose enclosing repeat has no count control", () => {
    // critical: bgpUpdateFull's bgpPathAttributes repeat wraps a PER-RECORD
    // nested bounded scope, so collectFreeRepeats deliberately leaves it
    // non-derived — it appears in NEITHER freeRepeats NOR boundedRepeats. With
    // no control able to instantiate even one path-attribute record, its
    // attrTypeCode "Record variants" picker could never change the diagram at
    // any value of bgpTotalPathAttributeLength or attrTypeCode. A visible
    // control with no possible effect must not be shown, so it is suppressed.
    const bgp = psdlToRenderer(PRESETS.bgpUpdateFull!);
    const repeatIds = new Set([
      ...(bgp.freeRepeats ?? []).map((r) => r.countKey),
      ...(bgp.boundedRepeats ?? []).map((r) => r.countKey),
    ]);
    expect(repeatIds.has("bgpPathAttributes")).toBe(false);
    const bgpKeys = (bgp.refSwitches ?? []).map((r) => r.refKey);
    expect(bgpKeys).not.toContain("attrTypeCode");

    // Sanity: a refSwitch on an instantiable repeat is NOT suppressed, so the
    // suppression is specific to the inert case (dnsResponse's dnsRrType stays).
    const dns = psdlToRenderer(PRESETS.dnsResponse!);
    expect((dns.refSwitches ?? []).map((r) => r.refKey)).toContain("dnsRrType");

    // The same suppression applies to tlsClientHello's `extType`, whose
    // `extensions` repeat is the identical eos-in-bounded-with-nested-scope
    // shape — its records are likewise never instantiable.
    const tls = psdlToRenderer(PRESETS.tlsClientHello!);
    expect((tls.refSwitches ?? []).map((r) => r.refKey)).not.toContain(
      "extType",
    );
  });

  it("suppresses a refSwitch whose every case arm collapses to width 0", () => {
    // high: isisLsp's `byType` picker is on tlvType, and the `tlvs` repeat DOES
    // derive a count from its pduLength budget (so the instantiable-count gate
    // passes). But every case arm is a single `bytes(ref tlvLength)` value, and
    // tlvLength has NO surfaced control anywhere (not a lengthController, not a
    // freeRepeat, not a top-level field — it lives inside the repeat element).
    // With tlvLength defaulting to 0 the variant value renders at width 0, so
    // selecting any tlvType (1/10/22/129/132/137) yields a byte-identical
    // diagram. A visible control with no possible effect must be suppressed.
    const isis = psdlToRenderer(PRESETS.isisLsp!);
    const keys = (isis.refSwitches ?? []).map((r) => r.refKey);
    expect(keys).not.toContain("tlvType");
  });

  it("the suppressed isisLsp tlvType picker is genuinely inert at app env", () => {
    // Justifies the suppression above: drive tlvType across every case through
    // the PacketViewer-style env derivation (boundedRepeats count-derive +
    // dynamic-width seed). The discriminator can't change the diagram because
    // each arm is `bytes(ref tlvLength)` and tlvLength has no control — so all
    // renders are byte-identical. (Had the picker been able to change anything,
    // suppressing it would be wrong; this asserts it cannot.)
    const src = PRESETS.isisLsp!;
    const baseline = appCellIds(src, { pduLength: 60, tlvType: 1 });
    for (const t of [10, 22, 129, 132, 137]) {
      expect(
        appCellIds(src, { pduLength: 60, tlvType: t }),
        `tlvType=${t} must not change the diagram (inert picker)`,
      ).toEqual(baseline);
    }
    // Sanity: the baseline never contains any per-variant value cell — proof
    // the arms collapse to width 0 (no areaAddressesValue/extIsReachValue/…).
    expect(baseline).not.toContain("extIsReachValue");
    expect(baseline).not.toContain("areaAddressesValue");
  });

  it("keeps a record-variant picker whose arms have visible (fixed-width) content", () => {
    // The positive counterpart of the zero-width gate: dnsResponse's dnsRrType
    // arms carry fixed-width records (A = 4-byte address, AAAA = 16-byte), so
    // the picker DOES change the diagram and must stay surfaced — the gate only
    // suppresses pickers whose arms are all uncontrolled ref-sized bytes.
    const dns = psdlToRenderer(PRESETS.dnsResponse!);
    expect((dns.refSwitches ?? []).map((r) => r.refKey)).toContain("dnsRrType");
  });
});
