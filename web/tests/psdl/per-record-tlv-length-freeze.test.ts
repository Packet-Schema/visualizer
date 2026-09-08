// FREEZE regression: a bounded `eos` repeat whose per-record VALUE is sized by a
// length ref that lives INSIDE a switch arm or a deeper group — NOT a flat record
// sibling — used to carry NO byte-overage accounting, so when that length grew
// past its representative seed (reachable via import / share-URL / JSON
// round-trip of any real packet carrying a non-trivial value length) each record
// over-filled the enclosing `bounded` scope, core's normalize threw `bounded
// scope over-consumed`, and PacketViewer's try/catch fell back to the last-good
// layout — the diagram FROZE and the env no longer matched it.
//
//   - isisLsp `tlvLength` sizes `tlvValue = bytes(ref tlvLength)` inside the
//     `byType` switch arm; the flat scan skipped switch arms → no innerScopeSeeds
//     → the outer count over-consumed `tlvsRegion`. Fixed by descending the flat
//     scan into switch cases.
//   - tlsClientHello `nameLen` sizes `serverName = bytes(ref nameLen)` inside the
//     SNI arm of a PER-RECORD nested `bounded extData(ref extLen)`; the inner
//     budget `extLen` was seeded for the EMPTY value, so a real SNI name overran
//     it. Fixed by linking nameLen → extLen (`derivesBudgetKey`) so PacketViewer
//     grows the inner budget with the live length.
//   - ocspRequest `hashAlgLength` / `serialNumberLength` / … size `bytes(ref X)`
//     CertID values inside `requestContentScope(ref requestSeqLength)`; same inner
//     budget growth via `derivesBudgetKey`.
//
// This asserts `resolveLayout` never throws across the full length range, using a
// faithful copy of PacketViewer.buildLayoutEnv's bounded-repeat derivation
// (inner-scope seeding, inner-budget growth, live-overage outer count).

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { evalExprOr } from "@/lib/psdl/expr";
import { initialState } from "@/lib/psdl/renderer-helpers";
import { seedDynamicWidthDefaults } from "@/lib/psdl/dynamic-width-defaults";
import type { Packet as RendererPacket } from "@/lib/psdl/renderer";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

// Faithful copy of PacketViewer.buildLayoutEnv's bounded-repeat derivation,
// INCLUDING the inner-budget growth (`derivesBudgetKey`) and the double-count
// exclusion. Returns the resolved layout (throws iff the real diagram would).
function deriveLayout(
  src: PsdlPacket,
  mirror: RendererPacket,
  overrides: Record<string, number>,
) {
  const ctrl = { ...initialState(mirror), ...overrides };
  const env = new Map<string, number>(
    Object.entries(ctrl).map(([k, v]) => [k, Number(v)]),
  );
  for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
  seedDynamicWidthDefaults(src, env);
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
    const livePerRecordBytes = br.perRecordBytes + innerOverage;
    env.set(
      br.countKey,
      Math.min(1024, Math.floor(forRecords / livePerRecordBytes)),
    );
  }
  return resolveLayout(src, { env });
}

describe("per-record TLV value length never freezes the diagram", () => {
  it("isisLsp: resolveLayout does not throw for tlvLength in [1..255]", () => {
    const src = PRESETS.isisLsp!;
    const mirror = psdlToRenderer(src);
    for (let v = 1; v <= 255; v++) {
      expect(
        () => deriveLayout(src, mirror, { tlvLength: v }),
        `isisLsp tlvLength=${v}`,
      ).not.toThrow();
    }
  });

  it("tlsClientHello: resolveLayout does not throw for nameLen in [0..255]", () => {
    const src = PRESETS.tlsClientHello!;
    const mirror = psdlToRenderer(src);
    for (let v = 0; v <= 255; v++) {
      expect(
        () => deriveLayout(src, mirror, { nameLen: v }),
        `tlsClientHello nameLen=${v}`,
      ).not.toThrow();
    }
  });

  it("ocspRequest: resolveLayout does not throw for any per-record CertID length in [0..255]", () => {
    const src = PRESETS.ocspRequest!;
    const mirror = psdlToRenderer(src);
    for (const field of [
      "hashAlgLength",
      "issuerNameHashLength",
      "issuerKeyHashLength",
      "serialNumberLength",
    ]) {
      for (let v = 0; v <= 255; v++) {
        expect(
          () => deriveLayout(src, mirror, { [field]: v }),
          `ocspRequest ${field}=${v}`,
        ).not.toThrow();
      }
    }
  });

  it("the per-record value length actually grows the diagram (tlvLength) and stays consistent", () => {
    // Not just crash-free: raising the length must MAKE the value bigger, proving
    // the control is live (no see-but-cannot-edit) and the env matches the
    // diagram rather than the frozen last-good layout.
    const src = PRESETS.isisLsp!;
    const mirror = psdlToRenderer(src);
    // The default discriminator selects the areaAddresses arm, whose value
    // `areaAddressesValue = bytes(ref tlvLength)` tracks the length field. Give
    // pduLength ample budget so a record still fits as the value grows (raising a
    // record's value otherwise shrinks the budget-derived count — correct, but it
    // would squeeze the single record out before we can compare widths).
    const widthOf = (v: number): number => {
      const cells = deriveLayout(src, mirror, {
        tlvLength: v,
        pduLength: 600,
      }).cells;
      const cell = cells.find((c) =>
        c.field.id.startsWith("areaAddressesValue"),
      );
      return cell ? cell.bitsTotal : -1;
    };
    const small = widthOf(4);
    const large = widthOf(20);
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small);
  });

  it("tlsClientHello: the SNI extData inner budget is linked to nameLen", () => {
    const mirror = psdlToRenderer(PRESETS.tlsClientHello!);
    const br = (mirror.boundedRepeats ?? []).find(
      (b) => b.countKey === "extensions",
    );
    const link = br?.innerScopeSeeds?.find((s) => s.key === "nameLen");
    expect(link).toBeDefined();
    expect(link!.derivesBudgetKey).toBe("extLen");
  });
});
