// high (inert/misleading + see-but-cannot-edit): a `ref`-discriminated
// "Record variants" picker (dnsResponse `dnsRrType`, pimHelloOptions
// `pimHelloOptType`) offers arms whose only content is a `bytes(ref X)` value
// sized by a per-record `length` field X (`dnsRdLength`, `pimHelloOptLen`)
// declared INSIDE a PLAIN (non-TLV/non-chain) freeRepeat. The `insideRepeat`
// guard in collectSiblingLengthControllers skips such length fields (it assumes
// a TLV/chain/bounded-repeat editor owns the per-record length), but a plain
// freeRepeat has NO such editor — so X had ZERO override surface. At the default
// env X=0 those arms render at width 0, so picking NS/CNAME/PTR/TXT (dns) or
// Address List (pim) showed NOTHING and several arms were byte-identical.
//
// collectPlainRepeatLengthControllers now surfaces X as a packet-level
// lengthController keyed on `env[X]` (an RDLENGTH / Option-Length slider), so
// the arms become reachable and the picker stops contradicting the diagram.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
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

describe("plain-repeat per-record length controllers", () => {
  it("surfaces dnsRdLength as a length controller (dnsResponse)", () => {
    const mirror = psdlToRenderer(PRESETS.dnsResponse!);
    const lc = (mirror.lengthControllers ?? []).find(
      (l) => l.id === "dnsRdLength",
    );
    expect(lc).toBeDefined();
    expect(lc!.controlsLength).toBe("dnsRdLength");
    expect(lc!.bits).toBe(16);
    // RDLENGTH is not a top-level mirror cell (it lives inside the dnsAnswers
    // repeat element), so without this controller it would be uneditable.
    expect(mirror.fields.some((f) => f.id === "dnsRdLength")).toBe(false);
  });

  it("keeps the dnsRrType variant picker offering the byte-sized arms", () => {
    const mirror = psdlToRenderer(PRESETS.dnsResponse!);
    const picker = (mirror.refSwitches ?? []).find(
      (r) => r.refKey === "dnsRrType",
    );
    expect(picker).toBeDefined();
    // NS(2), CNAME(5), PTR(12), TXT(16) are the opaque bytes(ref dnsRdLength)
    // arms that previously rendered empty.
    const values = picker!.cases.map((c) => c.value);
    for (const v of [2, 5, 12, 16]) expect(values).toContain(v);
  });

  it("raising dnsRdLength makes the NS RDATA value visible (dnsResponse)", () => {
    const psdl = PRESETS.dnsResponse!;
    // dnsRrType=2 (NS) with one answer record. At RDLENGTH=0 the NSDNAME value
    // collapses to width 0; raising the now-surfaced controller reveals it.
    const base = { dnsAnCount: 1, dnsRrType: 2 };
    expect(cellIds(psdl, { ...base, dnsRdLength: 0 })).not.toContain(
      "dnsRdataNsName#0",
    );
    expect(cellIds(psdl, { ...base, dnsRdLength: 8 })).toContain(
      "dnsRdataNsName#0",
    );
  });

  it("surfaces pimHelloOptLen as a length controller (pimHelloOptions)", () => {
    const mirror = psdlToRenderer(PRESETS.pimHelloOptions!);
    const lc = (mirror.lengthControllers ?? []).find(
      (l) => l.id === "pimHelloOptLen",
    );
    expect(lc).toBeDefined();
    expect(lc!.controlsLength).toBe("pimHelloOptLen");
    expect(lc!.bits).toBe(16);
    expect(mirror.fields.some((f) => f.id === "pimHelloOptLen")).toBe(false);
  });

  it("raising pimHelloOptLen makes the Address List option value visible", () => {
    const psdl = PRESETS.pimHelloOptions!;
    // pimHelloOptType=24 (Address List), one option record. At Option Length=0
    // the secondary-address bytes collapse to width 0; raising the surfaced
    // controller reveals them.
    const base = { pimHelloOptions: 1, pimHelloOptType: 24 };
    expect(cellIds(psdl, { ...base, pimHelloOptLen: 0 })).not.toContain(
      "addrListData#0",
    );
    expect(cellIds(psdl, { ...base, pimHelloOptLen: 8 })).toContain(
      "addrListData#0",
    );
  });

  it("surfaces a flat-TLV per-record length controller for isisLsp tlvLength (switch-arm value)", () => {
    // isisLsp `tlvs` is inside the `tlvsRegion` bounded scope and each switch arm
    // carries `tlvLength` + `tlvValue = bytes(ref tlvLength)`. The value sits
    // INSIDE the switch arm, so it is surfaced via `flatTlvInnerSeeds` (descending
    // into switch cases) → a `controlsLength` length controller, the SAME way
    // stun/bgpOpen flat-TLV records get one. The PacketViewer bounded derive
    // charges its live overage so raising it shrinks the derived count instead of
    // over-consuming the scope (the per-record TLV value freeze fix). Before the
    // fix this control was suppressed and the value was see-but-cannot-edit AND a
    // raised tlvLength on import froze the diagram.
    const mirror = psdlToRenderer(PRESETS.isisLsp!);
    const lc = (mirror.lengthControllers ?? []).find(
      (l) => l.id === "tlvLength",
    );
    expect(lc).toBeDefined();
    expect(lc!.controlsLength).toBe("tlvLength");
    expect(lc!.defaultValue).toBeGreaterThan(0);
    // The isisLsp tlvType picker is ALSO surfaced (#7/#8) via the refSwitch
    // lengthSeeds rescue.
    const tlvType = (mirror.refSwitches ?? []).find(
      (r) => r.refKey === "tlvType",
    );
    expect(tlvType).toBeDefined();
    expect(tlvType!.lengthSeeds).toEqual([{ key: "tlvLength", value: 1 }]);
  });

  it("does NOT surface per-record TLV lengths (dhcpv4 optionLength)", () => {
    // A TLV repeat's per-record length stays owned by the TLV editor.
    const mirror = psdlToRenderer(PRESETS.dhcpv4!);
    expect(
      (mirror.lengthControllers ?? []).some((l) => l.id === "optionLength"),
    ).toBe(false);
  });
});
