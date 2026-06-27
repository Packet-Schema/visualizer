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

    // Contrast: tlsClientHello's `extType` IS surfaced. Its `extensions` repeat
    // has the same eos-in-bounded-with-nested-scope shape, but UNLIKE bgp the
    // nested scope is a single-ref-to-sibling `bounded extData(ref extLen)` with
    // a Switch body (the TLV-extension idiom), so collectFreeRepeats derives a
    // budget-driven boundedRepeat (seeding `extLen` so the default record fits).
    // The repeat is therefore instantiable and the variant picker is live.
    const tls = psdlToRenderer(PRESETS.tlsClientHello!);
    const tlsRepeatIds = new Set([
      ...(tls.freeRepeats ?? []).map((r) => r.countKey),
      ...(tls.boundedRepeats ?? []).map((r) => r.countKey),
    ]);
    expect(tlsRepeatIds.has("extensions")).toBe(true);
    expect((tls.refSwitches ?? []).map((r) => r.refKey)).toContain("extType");
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

describe("record-bearing ref-count repeats seed one record (#11/#12)", () => {
  // The app-realistic env: controllers START as initialState(renderer) (which
  // applies freeRepeat.defaultCount and seeds refSwitch discriminators to their
  // first case), layered over packet defaults and 0-fallbacks — mirroring
  // PacketViewer's layout memo. This is what the diagram actually renders at
  // load, BEFORE the user touches any control.
  function appEnv(
    psdl: PsdlPacket,
    overrides: Record<string, number> = {},
  ): Map<string, number> {
    const env = new Map<string, number>(Object.entries(overrides));
    const state = initialState(psdlToRenderer(psdl));
    for (const [k, v] of Object.entries(state))
      if (!env.has(k)) env.set(k, Number(v));
    for (const [k, v] of initialEnv(psdl)) if (!env.has(k)) env.set(k, v);
    for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
    return env;
  }
  function appCellIds(
    psdl: PsdlPacket,
    overrides: Record<string, number> = {},
  ): string[] {
    return resolveLayout(psdl, { env: appEnv(psdl, overrides) }).cells.flatMap(
      (c) => [c.field.id, ...(c.subCells ?? []).map((s) => s.subfield.id)],
    );
  }

  it("gives the dnsAnswers (dnsRrType) and dnsQuestions repeats a defaultCount", () => {
    // The fix: a ref-count repeat that encloses a surfaced variant Switch
    // (dnsAnswers → dnsRrType) or a nested record Repeat (dnsQuestions →
    // dnsQNameLabels) is seeded to ONE record so its picker / records are not
    // inert at load. Previously these fell back to the 0-seed.
    const dns = psdlToRenderer(PRESETS.dnsResponse!);
    const byKey = new Map(
      (dns.freeRepeats ?? []).map((f) => [f.countKey, f] as const),
    );
    expect(byKey.get("dnsAnCount")?.defaultCount).toBe(1);
    expect(byKey.get("dnsQdCount")?.defaultCount).toBe(1);
  });

  it("renders a representative RR variant at the DEFAULT count (picker is not inert)", () => {
    // The core bug: at load (app-realistic env, NO manual dnsAnCount raise)
    // picking any dnsRrType variant must change the diagram. Before the fix
    // dnsAnCount fell back to 0 → ZERO answer records → choosing AAAA / MX did
    // nothing. We do NOT pass dnsAnCount here: only the seeded default applies.
    const src = PRESETS.dnsResponse!;
    const aaaa = appCellIds(src, { dnsRrType: 28 }); // AAAA
    const mx = appCellIds(src, { dnsRrType: 15 }); // MX
    // The AAAA record body must actually appear (cells carry a per-instance
    // `#0` suffix, so match by prefix)...
    const has = (ids: string[], base: string): boolean =>
      ids.some((id) => id === base || id.startsWith(`${base}#`));
    expect(has(aaaa, "dnsRdataAaaaAddr")).toBe(true);
    // ...and a different variant renders a different body — proving the picker
    // drives the diagram without the user first raising any count stepper.
    expect(has(mx, "dnsRdataMxPref")).toBe(true);
    expect(aaaa).not.toEqual(mx);
  });

  it("does NOT seed plain scalar-list ref-count repeats", () => {
    // The fix is scoped to record-bearing repeats. A plain scalar list whose
    // element is just fixed-width values (vrrp IP addresses, RTP CSRC list)
    // stays at the 0-seed — no spurious record on load.
    for (const [preset, key] of [
      ["vrrp", "vrrpAddrCount"],
      ["rtp", "cc"],
      ["netbiosNs", "ancount"],
    ] as const) {
      const r = psdlToRenderer(PRESETS[preset]!);
      const fr = (r.freeRepeats ?? []).find((f) => f.countKey === key);
      expect(fr, `${preset} ${key} freeRepeat`).toBeTruthy();
      expect(fr!.defaultCount, `${preset} ${key} defaultCount`).toBeUndefined();
    }
  });

  it("lispMapReply records (lispRecEIDAFI picker) also seed one record", () => {
    // Same shape as dnsAnswers: a ref-count repeat enclosing a surfaced
    // refSwitch (lispRecEIDAFI). It must seed one record so the picker is live.
    const lisp = psdlToRenderer(PRESETS.lispMapReply!);
    const fr = (lisp.freeRepeats ?? []).find(
      (f) => f.countKey === "lispReplyRecCount",
    );
    expect(fr?.defaultCount).toBe(1);
    expect((lisp.refSwitches ?? []).map((r) => r.refKey)).toContain(
      "lispRecEIDAFI",
    );
  });
});

describe("eos/until repeat nested under a budget-derived bounded scope", () => {
  // bgpFlowSpec:
  //   bounded flowSpecComponentsScope(bytes=flowSpecLength) {
  //     repeat flowSpecComponents eos {        ← budget-derived boundedRepeat
  //       compType, switch {
  //         '1,2': prefix,
  //         '_': { repeat flowSpecOps until {...} }   ← INNER until repeat
  //       }
  //     }
  //   }
  // The OUTER eos repeat is auto-filled to consume the WHOLE flowSpecLength
  // budget. The INNER until repeat must NOT also be surfaced as a naked free
  // stepper: stepping it past its derived count adds bytes inside the already
  // saturated scope, so normalize throws "bounded scope … over-consumed" and
  // PacketViewer's layout memo freezes on the last good layout. This is the A4
  // destructive-bounded-stepper class, one level below the bounded boundary —
  // the inner `bounded` is reset to null at the outer repeat element, so a
  // persistent `insideBounded` flag (not `bounded`) is what suppresses it.

  it("does NOT surface a flowSpecOps free stepper (would over-consume the scope)", () => {
    const bgp = psdlToRenderer(PRESETS.bgpFlowSpec!);
    const keys = (bgp.freeRepeats ?? []).map((f) => f.countKey);
    expect(keys).not.toContain("flowSpecOps");
    // The outer repeat is still budget-derived (the length slider IS the
    // control), so the user can grow the scope — they just can't over-consume it.
    const bounded = (bgp.boundedRepeats ?? []).map((b) => b.countKey);
    expect(bounded).toContain("flowSpecComponents");
  });

  it("never throws/freezes when the length budget is raised (app env pipeline)", () => {
    // Mirror PacketViewer's layout memo: initialState + initialEnv + 0-fill,
    // then derive each bounded repeat's count from its live budget, then
    // resolveLayout. With the inner stepper suppressed this must hold across the
    // whole budget range — no "over-consumed" throw at any length.
    const psdl = PRESETS.bgpFlowSpec!;
    const m = psdlToRenderer(psdl);
    const base = new Map<string, number>();
    const state = initialState(m);
    for (const [k, v] of Object.entries(state)) base.set(k, Number(v));
    for (const [k, v] of initialEnv(psdl)) if (!base.has(k)) base.set(k, v);
    for (const r of collectPsdlRefs(psdl)) if (!base.has(r)) base.set(r, 0);

    for (const len of [0, 4, 8, 12, 16, 20, 30, 60]) {
      const env = new Map(base);
      env.set("flowSpecLength", len);
      for (const b of m.boundedRepeats ?? []) {
        const budget = evalExprOr(b.bytesExpr, env, 0) as number;
        const cnt = Math.floor((budget - b.prefixBytes) / b.perRecordBytes);
        env.set(b.countKey, Math.max(0, cnt));
      }
      expect(
        () => resolveLayout(psdl, { env }),
        `flowSpecLength=${len} must not over-consume`,
      ).not.toThrow();
    }
  });
});
