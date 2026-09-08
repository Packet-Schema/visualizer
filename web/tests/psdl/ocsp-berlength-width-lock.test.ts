// override-subsystem: ocspRequest BER-length width picker froze the diagram.
//
// All 6 CertID berLength leaves (requestSeqLength / certIdLength / hashAlgLength /
// issuerNameHashLength / issuerKeyHashLength / serialNumberLength) sit inside a
// bounded scope whose budget is `bytes(ref <siblingLength>)`:
//   requestListScope    = bytes(ref reqListLength)     ⊃ requestSeqLength
//   requestContentScope = bytes(ref requestSeqLength)  ⊃ certIdLength, hashAlgLength,
//                                                        issuerNameHashLength,
//                                                        issuerKeyHashLength,
//                                                        serialNumberLength
// That byte budget was computed assuming every berLength prefix octet is at its
// 8-bit (1-byte) default. Picking any other width on the BER-length WidthPicker
// widens the prefix, overflows the fixed budget, and core's `normalize` throws
// `bounded scope over-consumed`. PacketViewer's layout try/catch swallows the
// throw, so the picker's active option visibly moves while the diagram does NOT
// change — an inert / misleading control.
//
// psdlToRenderer now flags these leaves on `berLengthWidthLocked` so OverridePanel
// suppresses the width picker (the octet still renders at its valid 8-bit default).
// This test asserts (a) the lock set is exactly ocspRequest's 6 leaves and no
// other preset locks any berLength leaf, and (b) every width that used to throw
// is now unreachable: with all 6 octets at their 8-bit default the diagram still
// resolves cleanly.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import {
  applyChainInstances,
  applyTlvInstances,
  psdlToRenderer,
} from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv, berLenEnvKey } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { seedDynamicWidthDefaults } from "@/lib/psdl/dynamic-width-defaults";
import { evalExprOr } from "@/lib/psdl/expr";
import { initialState } from "@/lib/psdl/renderer-helpers";
import type { Packet as RendererPacket } from "@/lib/psdl/renderer";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

const OCSP_BER_LEAVES = [
  "requestSeqLength",
  "certIdLength",
  "hashAlgLength",
  "issuerNameHashLength",
  "issuerKeyHashLength",
  "serialNumberLength",
];

// Mirror PacketViewer's layout env build, including the innerScopeSeeds budget
// grow-path, so we drive resolveLayout exactly as the live diagram would.
function buildEnv(
  src: PsdlPacket,
  mirror: RendererPacket,
  overrides: Record<string, number>,
): Map<string, number> {
  const ctrl = { ...initialState(mirror), ...overrides };
  const env = new Map<string, number>(
    Object.entries(ctrl).map(([k, v]) => [k, Number(v)]),
  );
  for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
  seedDynamicWidthDefaults(src, env);
  for (const [k, v] of Object.entries(overrides)) env.set(k, Number(v));
  for (const br of mirror.boundedRepeats ?? []) {
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
  return env;
}

describe("ocspRequest berLength width picker is locked (no frozen diagram)", () => {
  it("flags exactly the 6 CertID berLength leaves as width-locked", () => {
    const mirror = psdlToRenderer(PRESETS.ocspRequest!);
    expect([...(mirror.berLengthWidthLocked ?? [])].sort()).toEqual(
      [...OCSP_BER_LEAVES].sort(),
    );
  });

  // The width-lock is also produced by a faithful resolveLayout probe (see
  // snmp-berlength-width-lock.test.ts), which catches the SAME inert-picker
  // defect in the TLV-style length-prefixed presets snmpV2c / snmpv3 /
  // kerberosAsReq. Every OTHER preset must still lock nothing — a stray lock
  // there would silently hide a working width picker.
  const KNOWN_LOCKED_PRESETS = new Set([
    "ocspRequest",
    "snmpV2c",
    "snmpv3",
    "kerberosAsReq",
  ]);
  it("locks NO berLength leaf outside the known inert-picker presets", () => {
    for (const [name, src] of Object.entries(PRESETS)) {
      if (!src || KNOWN_LOCKED_PRESETS.has(name)) continue;
      const mirror = psdlToRenderer(src);
      expect(
        mirror.berLengthWidthLocked ?? [],
        `${name} must not lock any berLength width picker`,
      ).toEqual([]);
    }
  });

  it("still resolves cleanly with every locked octet at its 8-bit default", () => {
    const src = PRESETS.ocspRequest!;
    const mirror = psdlToRenderer(src);
    const base = applyChainInstances(
      applyTlvInstances(src, mirror, {}),
      mirror,
    );
    // A representative request record renders, and at least one locked octet is
    // a visible cell (the surface the user would have clicked to open the picker).
    const env = buildEnv(src, mirror, {});
    const { cells } = resolveLayout(base, { env });
    expect(
      cells.some((c) => c.field.id.split("#")[0] === "requestSeqLength"),
      "a locked berLength octet must render so the lock has a click target",
    ).toBe(true);
  });

  it("would otherwise throw at every non-default width the picker offered", () => {
    // Documents the bug the lock prevents: had the picker stayed live, driving
    // __berLen__<leaf> to any non-8-bit width overflows the value-budgeted scope
    // and core throws — exactly what froze the diagram. The lock removes the
    // control entirely so these widths are no longer reachable.
    const src = PRESETS.ocspRequest!;
    const mirror = psdlToRenderer(src);
    const base = applyChainInstances(
      applyTlvInstances(src, mirror, {}),
      mirror,
    );
    for (const leaf of OCSP_BER_LEAVES) {
      const env = buildEnv(src, mirror, { [berLenEnvKey(leaf)]: 16 });
      expect(
        () => resolveLayout(base, { env }),
        `${leaf} at 2 bytes must over-consume its bounded scope`,
      ).toThrow();
    }
  });
});
