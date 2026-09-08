// refSwitch / peekSwitch variant pickers must show a readable label even when
// the switch case struct declares only an `id` (no `name`) — the common 0.5
// idiom. Previously both `collectRefSwitches` and `collectPeekSwitches` fell
// back to a bare `case ${key}` label (e.g. "case 1", "case 28"), so the picker
// worked but the user could not tell which variant each value selects. The
// label now mirrors the TLV catalog: `name ?? prettifyId(id) ?? case N`.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";

describe("switch picker labels: prettify id-only case structs", () => {
  it("dnsResponse refSwitch labels use the case id, not 'case N'", () => {
    const dns = psdlToRenderer(PRESETS.dnsResponse!);
    const rrType = dns.refSwitches?.find((r) => r.refKey === "dnsRrType");
    expect(rrType, "dnsRrType variant picker must be surfaced").toBeTruthy();

    const labels = rrType!.cases.map((c) => c.label);
    // No label should degrade to the bare "case N" fallback.
    expect(labels.some((l) => /^case \d/.test(l))).toBe(false);
    // The id-only structs are prettified from their `id`.
    expect(labels).toContain("Dns Rdata Cname"); // 5 => id: dnsRdataCname
    expect(labels).toContain("Dns Rdata Aaaa"); // 28 => id: dnsRdataAaaa
  });

  it("icmpv6Ndp peekSwitch labels use the case id, not 'case N'", () => {
    const mirror = psdlToRenderer(PRESETS.icmpv6Ndp!);
    const optPicker = mirror.peekSwitches?.[0];
    expect(optPicker, "NDP option type picker must be surfaced").toBeTruthy();

    const labels = optPicker!.cases.map((c) => c.label);
    expect(labels.some((l) => /^case \d/.test(l))).toBe(false);
    // 3 => id: ndpOptPrefixInfo, 5 => id: ndpOptMtu.
    expect(labels).toContain("Ndp Opt Prefix Info");
    expect(labels).toContain("Ndp Opt Mtu");
  });
});
