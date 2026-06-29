// Regression — a TLV-style "Record variants" refSwitch must be able to SELECT
// the `_` opaque / unknown-record arm.
//
// `collectRefSwitches` only appended a synthetic default-arm option when the
// `_` arm's structural fingerprint DIFFERED from every listed case. A TLV-style
// record switch whose `_` arm is the canonical opaque/unknown shape (a lone
// `bytes(ref <perRecordLen>)` value) fingerprints identically to any listed arm
// that is also a lone `bytes(ref …)`, so the synthetic option was suppressed —
// even though selecting an UNLISTED discriminator value is a real, RFC-defined
// reachable state (an unknown record type decoded opaquely). The picker then
// offered only the modelled types: the unknown-record state was unrepresentable
// and an imported packet carrying an unknown record type could not
// round-trip-select.
//
// Confirmed against three shipping presets whose `_` arm is an opaque
// ref-length-sized value structurally identical to ≥1 listed arm:
//   * dnsResponse `dnsRdata` (`dnsRrType` → `dnsRdataBytes` = bytes(ref
//     dnsRdLength); collides with the NS/CNAME/PTR/TXT arms).
//   * isisLsp `byType` (`tlvType` → `tlvValue` = bytes(ref tlvLength); EVERY
//     listed arm is also bytes(ref tlvLength)).
//   * pimHelloOptions `pimHelloOptValue` (`pimHelloOptType` → `unknownOptData` =
//     bytes(ref pimHelloOptLen); collides with the Address-List arm).
//
// Each refSwitch must now offer an extra option at an UNLISTED discriminator
// value, and resolving the switch at that value must render the opaque arm's
// own field (non-zero width, thanks to the seeded per-record length) — i.e. the
// unknown-record state is selectable and visible.

import { describe, expect, it } from "vitest";
import { PRESETS } from "../../lib/psdl/presets.server";
import { psdlToRenderer } from "../../lib/psdl/psdl-to-renderer";
import { normalize } from "../../lib/psdl/normalize";
import { isField } from "../../lib/psdl/utils";
import type { Container, Packet, Switch } from "../../lib/psdl/types";

/** Depth-first search for a Switch with the given id anywhere in the body. */
function findSwitch(containers: Container[], id: string): Switch | null {
  for (const c of containers) {
    if (isField(c)) continue;
    if (c.kind === "switch") {
      if (c.id === id) return c;
      for (const arm of Object.values(c.cases)) {
        const hit = findSwitch(arm.fields, id);
        if (hit) return hit;
      }
      continue;
    }
    if (c.kind === "repeat") {
      const hit = findSwitch(c.element.fields, id);
      if (hit) return hit;
    } else if (c.kind === "group") {
      const hit = findSwitch(c.children, id);
      if (hit) return hit;
    } else if (c.kind === "optional") {
      const hit = findSwitch([c.container], id);
      if (hit) return hit;
    } else if (c.kind === "bounded") {
      const hit = findSwitch(c.fields, id);
      if (hit) return hit;
    } else if (c.kind === "encrypted") {
      const hit = findSwitch(c.plaintext.fields, id);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Normalize a ref-discriminated Switch in isolation: a discriminator field, a
 * per-record length field (seeded from the refSwitch `lengthSeeds`), and the
 * switch — under `env[refKey] = value`, with the seeded lengths applied. Return
 * the resolved field ids and their byte widths.
 */
function resolveArm(
  sw: Switch,
  refKey: string,
  value: number,
  lengthSeeds: { key: string; value: number }[],
): { id: string; bytes: number }[] {
  const env = new Map<string, number>([[refKey, value]]);
  for (const s of lengthSeeds) env.set(s.key, s.value);
  const body: Container[] = [
    { id: refKey, name: refKey, type: { kind: "int", bits: 8 } },
    ...lengthSeeds.map((s) => ({
      id: s.key,
      name: s.key,
      type: { kind: "int" as const, bits: 16 },
    })),
    sw,
  ];
  const pkt: Packet = { name: "probe", rowBits: 32, body };
  return normalize(pkt, env).fields.map((f) => ({
    id: f.id,
    bytes: f.bits / 8,
  }));
}

const CASES = [
  {
    preset: "dnsResponse",
    switchId: "dnsRdata",
    refKey: "dnsRrType",
    listed: 1, // A record
    opaqueFieldId: "dnsRdataBytes",
  },
  {
    preset: "isisLsp",
    switchId: "byType",
    refKey: "tlvType",
    listed: 1, // Area Addresses
    opaqueFieldId: "tlvValue",
  },
  {
    preset: "pimHelloOptions",
    switchId: "pimHelloOptValue",
    refKey: "pimHelloOptType",
    listed: 1, // Holdtime
    opaqueFieldId: "unknownOptData",
  },
] as const;

describe("unknown-record `_` arm is selectable in a TLV refSwitch", () => {
  for (const t of CASES) {
    it(`${t.preset} ${t.switchId} exposes an unknown / other option that renders the opaque arm`, () => {
      const pkt = PRESETS[t.preset];
      expect(pkt, `${t.preset} preset`).toBeDefined();

      const r = psdlToRenderer(pkt);
      const rs = (r.refSwitches ?? []).find((s) => s.id === t.switchId);
      expect(rs, `${t.switchId} refSwitch`).toBeDefined();
      expect(rs!.refKey).toBe(t.refKey);

      const values = rs!.cases.map((c) => c.value);
      // The listed type is present, plus the synthetic unknown / other option.
      expect(values).toContain(t.listed);

      // The synthetic option is annotated as the unknown / other state.
      const sentinelCase = rs!.cases.find((c) =>
        c.label.toLowerCase().includes("unknown"),
      );
      expect(sentinelCase, "an 'unknown / other' option").toBeDefined();
      const sentinel = sentinelCase!.value;

      // The sentinel value is genuinely UNLISTED: resolving the switch at it
      // selects the `_` arm, surfacing the opaque field — not any modelled one.
      const sw = findSwitch(pkt.body, t.switchId)!;
      const seeds = rs!.lengthSeeds ?? [];
      expect(seeds.length, "a per-record length seed").toBeGreaterThan(0);

      const opaque = resolveArm(sw, t.refKey, sentinel!, seeds).find(
        (f) => f.id === t.opaqueFieldId,
      );
      expect(
        opaque,
        `opaque ${t.opaqueFieldId} field at sentinel`,
      ).toBeDefined();
      // Seeded per-record length makes the opaque value non-zero width — visible
      // and editable, not a width-0 phantom.
      expect(opaque!.bytes).toBeGreaterThan(0);

      // The listed type does NOT render the opaque arm (so the picker truly
      // distinguishes the unknown state from a modelled one).
      const listedFields = resolveArm(sw, t.refKey, t.listed, seeds).map(
        (f) => f.id,
      );
      expect(listedFields).not.toContain(t.opaqueFieldId);
    });
  }
});
