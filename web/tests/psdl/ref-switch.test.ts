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
    expect(bgpKeys).toContain("attrTypeCode"); // 8-bit type code — kept
    expect(bgpKeys).not.toContain("attrExtLen"); // 1-bit flag — dropped

    // CoAP's optDelta/optLength are 4-bit nibbles whose cases add
    // length-extension fields — both dropped (no record-variant switch left).
    const coap = psdlToRenderer(PRESETS.coap!);
    expect(coap.refSwitches ?? []).toHaveLength(0);
  });
});
