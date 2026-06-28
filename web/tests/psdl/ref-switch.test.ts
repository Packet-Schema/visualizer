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
 * Cell ids derived the way the live app does it: PacketViewer layers the
 * renderer's `initialState` seeds (refSwitch discriminator + per-record
 * `lengthSeeds`) under the explicit overrides, then `initialEnv` + `psdlRefs`
 * 0-fill + `seedDynamicWidthDefaults` + the `boundedRepeats` count-derivation
 * (count = floor((budget - prefix) / perRecord)), then
 * `resolveLayout({ viewMode: "semantic" })`. The `initialState` layer is what
 * makes a ref-sized TLV Value non-zero-width (it seeds `tlvLength`), so this is
 * what the diagram actually renders at load.
 */
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
    // Mirror PacketViewer.buildLayoutEnv: seed each per-record inner-scope length
    // so the representative record fits its own value (a switch-arm value sized by
    // a sibling length, e.g. bgpFlowSpec prefixValue / isisLsp tlvValue).
    for (const seed of br.innerScopeSeeds ?? []) {
      if (!env.get(seed.key)) env.set(seed.key, seed.value);
    }
    const budgetSeedOf = (key: string): number =>
      (br.innerScopeSeeds ?? []).find(
        (s) => s.key === key && !s.derivesBudgetKey,
      )?.value ?? 0;
    for (const seed of br.innerScopeSeeds ?? []) {
      if (!seed.derivesBudgetKey) continue;
      const overage =
        Math.max(0, Number(env.get(seed.key) ?? 0) - seed.value) *
        (seed.bytesPerUnit ?? 1);
      if (overage <= 0) continue;
      const required = budgetSeedOf(seed.derivesBudgetKey) + overage;
      if (required > Number(env.get(seed.derivesBudgetKey) ?? 0)) {
        env.set(seed.derivesBudgetKey, required);
      }
    }
    const budget = evalExprOr(br.bytesExpr, env, 0);
    const forRecords = Math.max(0, budget - br.prefixBytes);
    const innerOverage = (br.innerScopeSeeds ?? []).reduce(
      (sum, seed) =>
        seed.derivesBudgetKey
          ? sum
          : sum +
            Math.max(0, Number(env.get(seed.key) ?? 0) - seed.value) *
              (seed.bytesPerUnit ?? 1),
      0,
    );
    env.set(
      br.countKey,
      Math.floor(forRecords / (br.perRecordBytes + innerOverage)),
    );
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

  it("surfaces sub-byte VARIANT-SELECTOR discriminators but not length encoders", () => {
    // override-audit (lwm2mRegister): the `tlvRecords` element's compound Type
    // byte carries two sub-byte (< 8-bit) discriminators that genuinely pick
    // WHICH cells render — `tlvIdLen` (1-bit, 8- vs 16-bit Identifier via
    // `byIdLen`) and `tlvTypeOfLength` (2-bit, Length-field width / short-value
    // layout via `byTypeOfLength`). Both were force-classed as length-extension
    // ENCODERS by the blanket `discBits < 8` rule and suppressed, leaving the
    // visible Identifier / Length / Value cells with NO picker — a
    // see-but-cannot-edit gap. They must now be surfaced as refSwitch pickers.
    const lwm2m = psdlToRenderer(PRESETS.lwm2mRegister!);
    const refKeys = (lwm2m.refSwitches ?? []).map((r) => r.refKey);
    expect(refKeys).toContain("tlvIdLen");
    expect(refKeys).toContain("tlvTypeOfLength");

    // A TRUE sub-byte length-extension encoder whose nibble SIZES a value scope
    // (CoAP's `optLength` 13/14 sentinels re-encode the option-value byte count)
    // must STAY suppressed — driving it would desync the encoded option length
    // (`optLength` is reachable instead via its length controller). `optDelta`,
    // the sibling nibble whose 13/14 sentinels only toggle a distinct-width Delta
    // extension cell and size NOTHING, is surfaced (coap-opt-delta-extension.test.ts).
    const coap = psdlToRenderer(PRESETS.coap!);
    const coapKeys = (coap.refSwitches ?? []).map((r) => r.refKey);
    expect(coapKeys).not.toContain("optLength");
    // BGP's Extended-Length flag (`attrExtLen`) is a 1-bit `flags` discriminator
    // whose arms are all length ints at distinct widths (case 1 → 16-bit, default
    // → 8-bit) inside the instantiable bgpPathAttributes repeat — the same
    // Extended-Length class as the top-level coap/websocket nibbles, so it IS
    // surfaced (see bgp-attr-ext-len-editable.test.ts).
    const bgp = psdlToRenderer(PRESETS.bgpUpdateFull!);
    const bgpKeys = (bgp.refSwitches ?? []).map((r) => r.refKey);
    expect(bgpKeys).toContain("attrExtLen");
  });

  it("lwm2mRegister tlvIdLen picker flips tlvIdentifier8 <-> tlvIdentifier16", () => {
    // Selecting the variant must change the rendered layout (not an inert
    // dropdown): tlvIdLen=0 emits the 8-bit Identifier, tlvIdLen=1 the 16-bit
    // one. The app pipeline (initialState seeds + bounded derivation) is used so
    // this matches what the diagram renders at load.
    const src = PRESETS.lwm2mRegister!;
    const as8 = appCellIdsSeeded(src, { tlvRecords: 1, tlvIdLen: 0 });
    const as16 = appCellIdsSeeded(src, { tlvRecords: 1, tlvIdLen: 1 });
    expect(as8).toContain("tlvIdentifier8#0");
    expect(as8).not.toContain("tlvIdentifier16#0");
    expect(as16).toContain("tlvIdentifier16#0");
    expect(as16).not.toContain("tlvIdentifier8#0");
    expect(as16).not.toEqual(as8);
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

  it("surfaces the `_` operator-list arm of bgpFlowSpec's component picker", () => {
    // override-design-audit (high): flowSpecCompValue switches on
    // flowSpecCompType with key "1,2" -> prefix form, key "_" -> the
    // numeric-operator list (RFC 8955 component types 3–13: port, dscp,
    // fragment, …). The `_` arm is the DOMINANT component shape, but its key has
    // no numeric value, so the picker offered ONLY value 1 ('Prefix Value') and
    // the operator-list body was unreachable — every imported non-prefix
    // component was misrepresented as a prefix.
    const bgp = psdlToRenderer(PRESETS.bgpFlowSpec!);
    const rs = (bgp.refSwitches ?? []).find(
      (r) => r.refKey === "flowSpecCompType",
    );
    expect(rs, "flowSpecCompType picker must be surfaced").toBeTruthy();
    const values = rs!.cases.map((c) => c.value);
    // The prefix arm (1) AND a synthetic value that selects the `_` arm.
    expect(values).toContain(1);
    // The synthetic `_` value must be a real component-type code outside the
    // "1,2" prefix arm (3 = IP Protocol is the smallest such enum variant).
    const otherValue = values.find((v) => v !== 1 && v !== 2);
    expect(otherValue, "operator-list `_` arm must be selectable").toBe(3);

    // Selecting each arm must render a STRUCTURALLY DIFFERENT diagram — the
    // prefix arm shows prefixLength, the operator-list arm does not (proving the
    // picker is not inert and the `_` arm is genuinely reachable).
    const src = PRESETS.bgpFlowSpec!;
    // Ample budget so a record renders in either arm (the prefix arm's value
    // `prefixValue = bytes(ref prefixLength)` is now seeded to a representative
    // width, so perRecordBytes — and thus the budget one record needs — is larger
    // than the old empty-value estimate).
    const prefix = appCellIdsSeeded(src, {
      flowSpecLength: 40,
      flowSpecCompType: 1,
    });
    const opList = appCellIdsSeeded(src, {
      flowSpecLength: 40,
      flowSpecCompType: otherValue!,
    });
    expect(prefix).toContain("prefixLength#0");
    expect(opList).not.toContain("prefixLength#0");
    expect(opList).not.toEqual(prefix);
  });

  it("excludes length/format-encoder switches, keeping only record-type codes", () => {
    // BGP's Extended-Length flag (`attrExtLen`) IS surfaced: it is a 1-bit
    // `flags` discriminator whose arms are all length ints at distinct widths
    // (case 1 → 16-bit, default → 8-bit) inside the instantiable
    // bgpPathAttributes repeat — the same Extended-Length class as the top-level
    // coap/websocket nibbles. Toggling it cleanly swaps the rendered Attribute
    // Length cell (8-bit ⇄ 16-bit) rather than over-consuming a scope, so it must
    // be editable (see bgp-attr-ext-len-editable.test.ts).
    const bgp = psdlToRenderer(PRESETS.bgpUpdateFull!);
    const bgpKeys = (bgp.refSwitches ?? []).map((r) => r.refKey);
    expect(bgpKeys).toContain("attrExtLen");

    // CoAP's optDelta/optLength are 4-bit extended-encoding nibbles. `optLength`
    // sizes `optValue` and is editable via its surfaced length controller, so it
    // is NOT also offered as a refSwitch (a redundant, length-desyncing control).
    // `optDelta` sizes nothing — its nibble only toggles a distinct-width Delta
    // extension cell (13 → 8-bit, 14 → 16-bit) — so it IS surfaced (see the
    // dedicated coap-opt-delta-extension.test.ts).
    const coap = psdlToRenderer(PRESETS.coap!);
    const coapKeys = (coap.refSwitches ?? []).map((r) => r.refKey);
    expect(coapKeys).not.toContain("optLength");

    // dnsResponse's dnsRrType is an 8-bit record-type code whose dnsAnswers
    // repeat IS instantiable (count: ref(dnsAnCount)) — it stays surfaced.
    const dns = psdlToRenderer(PRESETS.dnsResponse!);
    const dnsKeys = (dns.refSwitches ?? []).map((r) => r.refKey);
    expect(dnsKeys).toContain("dnsRrType");
  });

  it("surfaces the coapSignaling Extended-Length nibble (coapSigLen) picker", () => {
    // high (see-but-cannot-edit): coapSignaling's top-level `coapSigExtLen`
    // switches on the 4-bit `coapSigLen` nibble (group-nested in `coapSigLenTkl`)
    // and inserts a DISTINCT-width Extended Length cell per arm (13 → 8-bit,
    // 14 → 16-bit, 15 → 32-bit). The blanket sub-byte length-encoder heuristic
    // suppressed it, so an imported Len=13/14/15 message rendered an Extended
    // Length field with NO control to reach it. A TOP-LEVEL (`!insideRepeat`)
    // length-extension switch with distinct-width arms is now surfaced.
    const coapSig = psdlToRenderer(PRESETS.coapSignaling!);
    const rs = (coapSig.refSwitches ?? []).find(
      (r) => r.refKey === "coapSigLen",
    );
    expect(
      rs,
      "coapSigLen Extended-Length picker must be surfaced",
    ).toBeTruthy();
    expect(rs!.cases.map((c) => c.value)).toEqual(
      expect.arrayContaining([13, 14, 15]),
    );

    // websocketFrame shares the exact class: top-level `byPayloadLength7` on the
    // 7-bit group-nested `payloadLength7` inserts a 16-bit (126) or 64-bit (127)
    // Extended Payload Length cell. It is surfaced via the same code path.
    const ws = psdlToRenderer(PRESETS.websocketFrame!);
    const wsRs = (ws.refSwitches ?? []).find(
      (r) => r.refKey === "payloadLength7",
    );
    expect(
      wsRs,
      "payloadLength7 Extended-Length picker must be surfaced",
    ).toBeTruthy();
    expect(wsRs!.cases.map((c) => c.value)).toEqual(
      expect.arrayContaining([126, 127]),
    );

    // This top-level (`!insideRepeat`) relaxation does not surface CoAP's
    // repeat-nested `optLength` — it sizes `optValue` (a length controller already
    // covers it), so a refSwitch would be a redundant, length-desyncing control.
    // (`optDelta`, which sizes nothing, IS surfaced by a separate, narrower
    // repeat-nested relaxation — see coap-opt-delta-extension.test.ts.)
    const coap = psdlToRenderer(PRESETS.coap!);
    const coapKeys = (coap.refSwitches ?? []).map((r) => r.refKey);
    expect(coapKeys).not.toContain("optLength");
  });

  it("coapSigLen picker makes the distinct-width Extended Length cell appear", () => {
    // Selecting 13/14/15 must visibly change the diagram (the control is not
    // inert): each value inserts a DIFFERENT Extended Length field. base = no
    // extension; 13 → 8-bit byte; 14 → 16-bit word; 15 → 32-bit dword.
    const src = PRESETS.coapSignaling!;
    const base = appCellIdsSeeded(src, { coapSigLen: 0 });
    const len13 = appCellIdsSeeded(src, { coapSigLen: 13 });
    const len14 = appCellIdsSeeded(src, { coapSigLen: 14 });
    const len15 = appCellIdsSeeded(src, { coapSigLen: 15 });
    expect(base).not.toContain("coapSigExtLenByte");
    expect(len13).toContain("coapSigExtLenByte");
    expect(len14).toContain("coapSigExtLenWord");
    expect(len15).toContain("coapSigExtLenDword");
    // Distinct selections render distinct diagrams (not an inert dropdown).
    expect(len13).not.toEqual(base);
    expect(len14).not.toEqual(len13);
    expect(len15).not.toEqual(len14);
  });

  it("surfaces the bgpUpdateFull attrTypeCode picker on its budget-derived repeat", () => {
    // critical: bgpUpdateFull's `bgpPathAttributes` eos repeat lives inside
    // `bounded(bgpTotalPathAttributeLength)` and each record wraps a PER-RECORD
    // nested `bounded bgpAttrValueScope` whose budget is a `cond` selecting
    // between `bgpAttrLength16` / `bgpAttrLength8` (the BGP Extended-Length
    // idiom). collectFreeRepeats now recognises that cond-of-sibling-refs budget
    // as a TLV-extension inner scope, so the repeat becomes a budget-derived
    // boundedRepeat (instantiable) and its attrTypeCode "Record variants" picker
    // is surfaced. Previously the entire path-attributes payload — the defining
    // body of a BGP UPDATE — was see-but-cannot-edit (in neither freeRepeats nor
    // boundedRepeats, with no variant picker and an inert length slider).
    const bgp = psdlToRenderer(PRESETS.bgpUpdateFull!);
    const br = (bgp.boundedRepeats ?? []).find(
      (r) => r.countKey === "bgpPathAttributes",
    );
    expect(br).toBeTruthy();
    expect(br!.lengthKey).toBe("bgpTotalPathAttributeLength");
    // Both Extended-Length branches are seeded so whichever the attrExtLen flag
    // selects fits the representative arm.
    const seedKeys = new Set((br!.innerScopeSeeds ?? []).map((s) => s.key));
    expect(seedKeys.has("bgpAttrLength8")).toBe(true);
    expect(seedKeys.has("bgpAttrLength16")).toBe(true);
    // A representative outer length seed so >=1 record renders at load.
    expect(br!.defaultLength).toBeGreaterThan(0);
    const bgpKeys = (bgp.refSwitches ?? []).map((r) => r.refKey);
    expect(bgpKeys).toContain("attrTypeCode");

    // Sanity: a refSwitch on an instantiable repeat is NOT suppressed
    // (dnsResponse's dnsRrType stays).
    const dns = psdlToRenderer(PRESETS.dnsResponse!);
    expect((dns.refSwitches ?? []).map((r) => r.refKey)).toContain("dnsRrType");

    // tlsClientHello's `extType` shares the same eos-in-bounded-with-nested-scope
    // shape — its single-ref-to-sibling `extData(ref extLen)` is the plain
    // TLV-extension idiom — and stays surfaced too.
    const tls = psdlToRenderer(PRESETS.tlsClientHello!);
    const tlsRepeatIds = new Set([
      ...(tls.freeRepeats ?? []).map((r) => r.countKey),
      ...(tls.boundedRepeats ?? []).map((r) => r.countKey),
    ]);
    expect(tlsRepeatIds.has("extensions")).toBe(true);
    expect((tls.refSwitches ?? []).map((r) => r.refKey)).toContain("extType");
  });

  it("surfaces the isisLsp tlvType picker with a per-record length seed (#7/#8)", () => {
    // high: isisLsp's `byType` picker is on tlvType, and the `tlvs` repeat DOES
    // derive a count from its pduLength budget (so the instantiable-count gate
    // passes). Every case arm is a single `bytes(ref tlvLength)` value, and
    // tlvLength has no top-level/lengthController/freeRepeat control — it lives
    // INSIDE the repeat element. Previously the picker was suppressed: the slider
    // manufactured empty TLV skeletons (tlvType#/tlvLength# with NO Value cell)
    // the user could SEE but never type into — a see-but-cannot-edit gap. The fix
    // surfaces the picker AND attaches a per-record `lengthSeeds` entry on
    // `tlvLength`, so the chosen arm's Value becomes visible/editable.
    const isis = psdlToRenderer(PRESETS.isisLsp!);
    const rs = (isis.refSwitches ?? []).find((r) => r.refKey === "tlvType");
    expect(rs, "tlvType variant picker must be surfaced").toBeTruthy();
    expect(rs!.cases.map((c) => c.value)).toEqual(
      expect.arrayContaining([1, 10, 22, 129, 132, 137]),
    );
    // The rescue seeds the per-record length so the arm's `bytes(ref tlvLength)`
    // is non-zero-width. The seed equals the per-record byte charge the
    // boundedRepeat already books (REF_SIZED_FIELD_BYTE_ALLOWANCE = 1), so the
    // budget-derived count stays exact and the bounded scope is never
    // over-consumed.
    expect(rs!.lengthSeeds).toEqual([{ key: "tlvLength", value: 1 }]);
  });

  it("renders an editable, non-zero-width TLV Value at the seeded app env", () => {
    // The picker is now LIVE: at the app-realistic env (initialState seeds the
    // tlvType discriminator AND the tlvLength rescue length), a TLV Value cell
    // appears, and choosing tlvType=129 renders the `nlpidList` payload — exactly
    // the region the suppressed picker left permanently empty.
    const src = PRESETS.isisLsp!;
    const t129 = appCellIdsSeeded(src, { pduLength: 60, tlvType: 129 });
    expect(t129).toContain("tlvType#0");
    expect(t129).toContain("tlvLength#0");
    // The Value cell (the previously-missing payload) is present and non-empty.
    expect(t129).toContain("nlpidList#0");
    // And the discriminator genuinely drives the variant: a different tlvType
    // renders a DIFFERENT value field id (areaAddresses for type 1).
    const t1 = appCellIdsSeeded(src, { pduLength: 60, tlvType: 1 });
    expect(t1).toContain("areaAddressesValue#0");
    expect(t1).not.toContain("nlpidList#0");
    // Seeding never over-consumes the bounded scope (no frozen/empty fallback):
    // records actually render.
    expect(t129.filter((id) => id === "tlvType#0").length).toBe(1);
  });

  it("keeps a record-variant picker whose arms have visible (fixed-width) content", () => {
    // The positive counterpart of the zero-width gate: dnsResponse's dnsRrType
    // arms carry fixed-width records (A = 4-byte address, AAAA = 16-byte), so
    // the picker DOES change the diagram and must stay surfaced — the gate only
    // suppresses pickers whose arms are all uncontrolled ref-sized bytes.
    const dns = psdlToRenderer(PRESETS.dnsResponse!);
    expect((dns.refSwitches ?? []).map((r) => r.refKey)).toContain("dnsRrType");
  });

  it("does NOT surface quicLong/quicShort frameType (opaque encrypted payload)", () => {
    // high: QUIC's `payload`/`frames` is an `encrypted` node with a fixed
    // `wireBits` footprint, so `resolveLayout` renders it as an OPAQUE ciphertext
    // blob in the default (wire) view — the plaintext `frameByType` switch is
    // never instantiated, so the CRYPTO/ACK/STREAM frame-body cells never appear
    // and EVERY frameType value yields a byte-identical diagram. A `frameType`
    // refSwitch picker would therefore be permanently inert: a visible
    // Stream/Crypto/Ack control with no possible effect, its label contradicting
    // the opaque payload the diagram shows. It must NOT be surfaced.
    for (const name of ["quicLong", "quicShort"] as const) {
      const m = psdlToRenderer(PRESETS[name]!);
      const refKeys = (m.refSwitches ?? []).map((r) => r.refKey);
      expect(
        refKeys,
        `${name} must expose no frameType refSwitch`,
      ).not.toContain("frameType");
      // The peek path never carried it (frameByType is ref-discriminated), but
      // assert no surface leaks it either.
      const peekKeys = (m.peekSwitches ?? []).map((p) => p.peekKey);
      expect(peekKeys.some((k) => k.includes("frameType"))).toBe(false);
    }
  });

  it("the QUIC frame switch is genuinely inert in the rendered (wire) diagram", () => {
    // Justifies the suppression: in the default (wire) view the diagram renders
    // five opaque `payload` ciphertext cells and ZERO frame-body cells, identical
    // for every frameType — so no picker over frameType could ever change it.
    for (const name of ["quicLong", "quicShort"] as const) {
      const src = PRESETS[name]!;
      const layouts = [2, 6, 8].map((ft) => cellIds(src, { frameType: ft }));
      // No frame-body cell (CRYPTO/ACK/STREAM/default) ever renders in wire view.
      for (const ids of layouts) {
        expect(
          ids.some((id) =>
            /crypto_body|ack_body|stream_body|frame_body/.test(id),
          ),
        ).toBe(false);
      }
      // Every frameType yields a byte-identical layout — the control is inert.
      expect(layouts[1]).toEqual(layouts[0]);
      expect(layouts[2]).toEqual(layouts[0]);
    }
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

  it("every dnsRrType RDATA case is either visible or sized by a user-editable length", () => {
    // The bug: the dnsRrType picker offers 9 cases, but NS(2)/CNAME(5)/PTR(12)/
    // TXT(16) are each a single `bytes(ref dnsRdLength)` arm; dnsRdLength defaults
    // to 0 so they collapse to width 0. dnsRdLength lives INSIDE the dnsAnswers
    // repeat, so collectSiblingLengthControllers skipped it (insideRepeat) and it
    // was NOT a user-exposed override key — selecting those 4 cases was a silent
    // no-op AND the visible RDLENGTH cell could not be edited to reveal the RDATA.
    const src = PRESETS.dnsResponse!;
    const dns = psdlToRenderer(src);

    // dnsRdLength must now be a user-exposed override key (a length controller).
    const exposed = new Set<string>();
    for (const f of dns.fields ?? []) {
      exposed.add(f.id);
      if (f.controlsLength) exposed.add(f.controlsLength);
    }
    for (const lc of dns.lengthControllers ?? []) exposed.add(lc.id);
    for (const fr of dns.freeRepeats ?? []) exposed.add(fr.countKey);
    for (const rs of dns.refSwitches ?? []) exposed.add(rs.refKey);
    expect(exposed.has("dnsRdLength")).toBe(true);

    const has = (ids: string[], base: string): boolean =>
      ids.some((id) => id === base || id.startsWith(`${base}#`));
    // The body field each numeric case should render. The 4 width-0-collapsing
    // arms are revealed only once dnsRdLength is raised (the new length control).
    const cases: { type: number; body: string }[] = [
      { type: 1, body: "dnsRdataAAddr" }, // A — fixed 32-bit
      { type: 2, body: "dnsRdataNsName" }, // NS — bytes(ref dnsRdLength)
      { type: 5, body: "dnsRdataCnameName" }, // CNAME
      { type: 6, body: "dnsRdataSoaSerial" }, // SOA — fixed fields
      { type: 12, body: "dnsRdataPtrName" }, // PTR
      { type: 15, body: "dnsRdataMxPref" }, // MX — 16-bit + bytes
      { type: 16, body: "dnsRdataTxtData" }, // TXT
      { type: 28, body: "dnsRdataAaaaAddr" }, // AAAA — fixed 128-bit
      { type: 33, body: "dnsRdataSrvPriority" }, // SRV — fixed + bytes
    ];
    for (const { type, body } of cases) {
      // dnsRdLength=4 is a representative RDATA length the user can now set.
      const ids = appCellIds(src, { dnsRrType: type, dnsRdLength: 4 });
      expect(
        has(ids, body),
        `dnsRrType=${type} RDATA body ${body} must render once dnsRdLength is set`,
      ).toBe(true);
    }
  });

  it("setting dnsRdLength reveals a previously-collapsed RDATA arm (NS)", () => {
    // Concretely proves the new control is effective: with dnsRdLength at its
    // default the NS arm is width 0 (no body cell); raising dnsRdLength makes the
    // RDATA appear — the once-dead picker option now changes the diagram.
    const src = PRESETS.dnsResponse!;
    const has = (ids: string[], base: string): boolean =>
      ids.some((id) => id === base || id.startsWith(`${base}#`));
    const collapsed = appCellIds(src, { dnsRrType: 2, dnsRdLength: 0 });
    const revealed = appCellIds(src, { dnsRrType: 2, dnsRdLength: 8 });
    expect(has(collapsed, "dnsRdataNsName")).toBe(false);
    expect(has(revealed, "dnsRdataNsName")).toBe(true);
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

  it("seeds dnsRdLength so the MIXED-width dnsRdata picker's collapsed arms render at default load (#11/#12)", () => {
    // The bug: dnsRdata's arms are MIXED width — A(32b)/AAAA(128b)/MX/SRV/SOA are
    // fixed-width and visible, but NS(2)/CNAME(5)/PTR(12)/TXT(16) and the `_` raw
    // arm are each `bytes(ref dnsRdLength)` and collapse to width 0 at the default
    // dnsRdLength=0. Because at least one arm is fixed-width, switchArmsAllZeroWidth
    // returns false, so the all-zero-width lengthSeeds rescue never fired — picking
    // NS/CNAME/PTR/TXT showed an EMPTY record, the picker contradicting the diagram.
    const dns = psdlToRenderer(PRESETS.dnsResponse!);
    const rs = (dns.refSwitches ?? []).find((r) => r.refKey === "dnsRrType");
    expect(rs, "dnsRrType variant picker must be surfaced").toBeTruthy();
    // The mixed-width rescue attaches a per-record length seed on dnsRdLength.
    expect(rs!.lengthSeeds).toEqual([{ key: "dnsRdLength", value: 1 }]);

    // At the app-realistic env (initialState seeds the discriminator AND
    // dnsRdLength) with NO manual dnsRdLength raise, EVERY selectable arm renders
    // its body — including the four previously-empty collapsing arms.
    const src = PRESETS.dnsResponse!;
    const has = (ids: string[], base: string): boolean =>
      ids.some((id) => id === base || id.startsWith(`${base}#`));
    const collapsing: { type: number; body: string }[] = [
      { type: 2, body: "dnsRdataNsName" }, // NS
      { type: 5, body: "dnsRdataCnameName" }, // CNAME
      { type: 12, body: "dnsRdataPtrName" }, // PTR
      { type: 16, body: "dnsRdataTxtData" }, // TXT
    ];
    for (const { type, body } of collapsing) {
      const ids = appCellIds(src, { dnsRrType: type });
      expect(
        has(ids, body),
        `dnsRrType=${type} RDATA body ${body} must render at default load (seeded dnsRdLength)`,
      ).toBe(true);
    }
    // The `_` raw arm (an out-of-list rrType) likewise renders its RDATA cell.
    expect(has(appCellIds(src, { dnsRrType: 99 }), "dnsRdataBytes")).toBe(true);

    // The seed is NON-DESTRUCTIVE: a user width still wins (initialState only
    // fills unset/0), so dnsRdLength remains a live, editable length control.
    const exposed = new Set<string>();
    for (const lc of dns.lengthControllers ?? []) exposed.add(lc.id);
    expect(exposed.has("dnsRdLength")).toBe(true);
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
