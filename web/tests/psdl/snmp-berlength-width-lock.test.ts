// override-subsystem: snmpV2c / snmpv3 BER-length width pickers were INERT.
//
// snmpV2c / snmpv3 encode TLV-style length-prefixed scalars WITHOUT a `bounded`
// wrapper, so their berLength prefix octets escape the structural
// `bounded(ref length)` lock (collectBerLengthWidthLocked, which matches only
// ocspRequest). Yet widening many of those octets produces NO diagram change:
// the grown prefix only resizes the octet's OWN cell, every other cell stays
// byte-for-byte identical, and the picker is a control the user can move with
// zero meaningful effect on the diagram — exactly the inert / misleading surface
// the bar forbids.
//
// psdlToRenderer now adds a build-time resolveLayout probe
// (collectBerLengthWidthLockedByProbe) that, for each berLength leaf under a
// representative env, compares the layout at width 8 vs 16/24 and locks the leaf
// when only its own cell grows (or the layout throws — the ocsp over-consume).
// This test pins:
//   - snmpV2c locks exactly the 16 inert prefix octets (requestId* + errorIndex*
//     + maxRepetitions* across every PDU variant), and NOT the octets whose
//     widening DOES reshape the diagram (errorStatus* / varBinds* / pduLength* /
//     nonRepeaters*, which wrap into a new row segment / add a cell);
//   - snmpv3 locks exactly ctxEngineIdLength (whose own cell grows but nothing
//     else moves), and NOT scopedPduLength / ctxNameLength / encryptedPduLength /
//     unknownPduLength (which change the cell count at 24-bit);
//   - the diagram still resolves cleanly with every locked octet at its valid
//     8-bit default, so each lock still has a visible click target.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv, berLenEnvKey } from "@/lib/psdl/normalize";
import { peekEnvKey } from "@/lib/psdl/expr";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { seedDynamicWidthDefaults } from "@/lib/psdl/dynamic-width-defaults";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

// The 16 inert prefix octets across snmpV2c's 8 PDU variants (GetRequest GR,
// GetNextRequest GN, GetResponse RS, SetRequest ST, GetBulk GB, Inform IF,
// Trap TP, Report RP). GetBulk has maxRepetitions where the others have
// errorIndex.
const SNMP_V2C_INERT = [
  "requestIdLengthGR",
  "errorIndexLengthGR",
  "requestIdLengthGN",
  "errorIndexLengthGN",
  "requestIdLengthRS",
  "errorIndexLengthRS",
  "requestIdLengthST",
  "errorIndexLengthST",
  "requestIdLengthGB",
  "maxRepetitionsLengthGB",
  "requestIdLengthIF",
  "errorIndexLengthIF",
  "requestIdLengthTP",
  "errorIndexLengthTP",
  "requestIdLengthRP",
  "errorIndexLengthRP",
];

// Octets whose widening DOES reshape the diagram — must stay editable.
const SNMP_V2C_EDITABLE = [
  "errorStatusLengthGR",
  "varBindsLengthGR",
  "pduLengthGetRequest",
  "nonRepeatersLengthGB",
];

function baseEnv(src: PsdlPacket): Map<string, number> {
  const env = new Map<string, number>(initialEnv(src));
  for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
  seedDynamicWidthDefaults(src, env);
  return env;
}

describe("snmpV2c / snmpv3 berLength width pickers (no inert width dropdowns)", () => {
  it("snmpV2c locks exactly the 16 TLV-style inert prefix octets", () => {
    const mirror = psdlToRenderer(PRESETS.snmpV2c!);
    expect([...(mirror.berLengthWidthLocked ?? [])].sort()).toEqual(
      [...SNMP_V2C_INERT].sort(),
    );
  });

  it("snmpV2c keeps editable every octet that reshapes the diagram", () => {
    const mirror = psdlToRenderer(PRESETS.snmpV2c!);
    const locked = new Set(mirror.berLengthWidthLocked ?? []);
    for (const id of SNMP_V2C_EDITABLE) {
      expect(locked.has(id), `${id} must remain an editable width picker`).toBe(
        false,
      );
    }
  });

  it("snmpv3 locks exactly ctxEngineIdLength", () => {
    const mirror = psdlToRenderer(PRESETS.snmpv3!);
    expect([...(mirror.berLengthWidthLocked ?? [])].sort()).toEqual([
      "ctxEngineIdLength",
    ]);
  });

  it("each snmpV2c inert octet really is inert: widening 8->16->24 leaves the layout unchanged", () => {
    const src = PRESETS.snmpV2c!;
    // PDU tag under which each leaf renders (the discriminator at offset 0,
    // bits 8). GR=160, GN=161, RS=162, ST=163, GB=165, IF=166, TP=167, RP=168.
    const tagOf: Record<string, number> = {
      GR: 160,
      GN: 161,
      RS: 162,
      ST: 163,
      GB: 165,
      IF: 166,
      TP: 167,
      RP: 168,
    };
    const peekKey = peekEnvKey(0, 8);
    const base = baseEnv(src);
    for (const leaf of SNMP_V2C_INERT) {
      const suffix = leaf.slice(-2);
      const tag = tagOf[suffix];
      expect(tag, `unknown PDU suffix for ${leaf}`).toBeDefined();
      const sigAt = (w: number): string => {
        const env = new Map(base);
        env.set(peekKey, tag);
        env.set(berLenEnvKey(leaf), w);
        const { cells } = resolveLayout(src, { env });
        // Whole-layout signature EXCLUDING the leaf's own cell, plus the cell
        // count — the exact inertness condition the lock encodes.
        const others = cells
          .filter((c) => c.field.id !== leaf)
          .map((c) => `${c.field.id}:${c.bitsTotal}:${c.segmentIndex}`)
          .join("|");
        return `${cells.length}#${others}`;
      };
      const s8 = sigAt(8);
      expect(sigAt(16), `${leaf} 8->16 must not reshape the diagram`).toBe(s8);
      expect(sigAt(24), `${leaf} 8->24 must not reshape the diagram`).toBe(s8);
    }
  });

  it("snmpV2c editable octets DO reshape the diagram (the lock did not over-fire)", () => {
    const src = PRESETS.snmpV2c!;
    const tagOf: Record<string, number> = {
      errorStatusLengthGR: 160,
      varBindsLengthGR: 160,
      pduLengthGetRequest: 160,
      nonRepeatersLengthGB: 165,
    };
    const peekKey = peekEnvKey(0, 8);
    const base = baseEnv(src);
    for (const leaf of SNMP_V2C_EDITABLE) {
      const countAt = (w: number): number => {
        const env = new Map(base);
        env.set(peekKey, tagOf[leaf]!);
        env.set(berLenEnvKey(leaf), w);
        return resolveLayout(src, { env }).cells.length;
      };
      expect(
        countAt(16) !== countAt(8) || countAt(24) !== countAt(8),
        `${leaf} must change the diagram so its width picker is meaningful`,
      ).toBe(true);
    }
  });

  it("still resolves cleanly with every locked snmpV2c octet at its 8-bit default", () => {
    const src = PRESETS.snmpV2c!;
    const env = baseEnv(src);
    env.set(peekEnvKey(0, 8), 160); // GetRequest arm
    const { cells } = resolveLayout(src, { env });
    // A locked octet renders, so the suppressed picker still had a click target.
    expect(
      cells.some((c) => c.field.id === "requestIdLengthGR"),
      "a locked berLength octet must render as a visible cell",
    ).toBe(true);
  });
});
