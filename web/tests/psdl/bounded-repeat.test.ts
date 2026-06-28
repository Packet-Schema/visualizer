// override-design-audit A3: an eos/until repeat nested in a single-ref
// `bounded.bytes` scope (babel/bgpOpen/ospf*/isis/ikev2/…) needs BOTH a count
// (core reads env[repeat.id]) AND a budget. A naked count stepper over-consumes
// the budget; a budget slider alone leaves the count at 0. So the LENGTH slider
// is the single control and the count is DERIVED from the budget at layout time
// (PacketViewer): `floor((evalExpr(bounded.bytes) - prefix) / perRecordBytes)`.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import {
  applyChainInstances,
  applyTlvInstances,
  psdlToRenderer,
} from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { evalExprOr } from "@/lib/psdl/expr";
import { initialState } from "@/lib/psdl/renderer-helpers";
import type { Packet as RendererPacket } from "@/lib/psdl/renderer";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

// Mirror PacketViewer's layout env build (including the bounded-repeat derive).
function cellCount(
  src: PsdlPacket,
  mirror: RendererPacket,
  overrides: Record<string, number>,
): number {
  const ctrl = { ...initialState(mirror), ...overrides };
  const base = applyChainInstances(applyTlvInstances(src, mirror, {}), mirror);
  const env = new Map<string, number>(
    Object.entries(ctrl).map(([k, v]) => [k, Number(v)]),
  );
  for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
  for (const br of mirror.boundedRepeats ?? []) {
    const budget = evalExprOr(br.bytesExpr, env, 0);
    const forRecords = Math.max(0, budget - br.prefixBytes);
    env.set(br.countKey, Math.floor(forRecords / br.perRecordBytes));
  }
  return resolveLayout(base, { env }).cells.length;
}

describe("bounded-repeat length-derived count", () => {
  it("raising the length slider grows the records", () => {
    for (const key of ["babel", "bgpOpen", "ospfHello", "isisLsp", "ikev2"]) {
      const src = PRESETS[key]!;
      const mirror = psdlToRenderer(src);
      const lengthKey = mirror.boundedRepeats?.[0]?.lengthKey;
      if (!lengthKey) throw new Error(`${key} has no boundedRepeat`);
      const grown = cellCount(src, mirror, { [lengthKey]: 400 });
      const empty = cellCount(src, mirror, { [lengthKey]: 0 });
      expect(grown, `${key} should grow`).toBeGreaterThan(empty);
    }
  });

  it("never over-consumes the scope at any slider value, across all presets", () => {
    const bad: string[] = [];
    for (const [key, src] of Object.entries(PRESETS)) {
      const mirror = psdlToRenderer(src);
      for (const br of mirror.boundedRepeats ?? []) {
        for (const len of [1, 8, 32, 128, 1000]) {
          try {
            cellCount(src, mirror, { [br.lengthKey]: len });
          } catch {
            bad.push(`${key}/${br.countKey}=${len}`);
            break;
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

// override-audit #5/#7/#8: a "TLV-style" record — [typeField, lengthField,
// switch on ref(typeField)] whose value is `bytes(ref lengthField)` — was NOT
// matched by isTlvRepeat (which needs element = a SINGLE switch), so it fell
// into the bounded-count derive. estimateElementBytes charged the full 64-byte
// allowance for that ref-to-sibling value, inflating perRecordBytes to ~67B: the
// length slider had to climb to 66-97B before ONE record appeared and records
// then grew in ~66-byte plateaus. estimateElementBytes now charges only a small
// structural size for a value sized by a SIBLING length, so perRecordBytes
// reflects the smallest legal record.
describe("bounded-repeat ref-sized record estimate (TLV-style)", () => {
  it("isisLsp: small perRecordBytes, record by ~31 bytes, monotonic growth", () => {
    const src = PRESETS.isisLsp!;
    const mirror = psdlToRenderer(src);
    const br = mirror.boundedRepeats?.find((b) => b.countKey === "tlvs");
    if (!br) throw new Error("isisLsp tlvs boundedRepeat missing");

    // The TLV record is type(1) + length(1) + value(ref length). Its value is
    // empty in the smallest legal record, so the estimate must be a few bytes —
    // NOT the ~67B that the variable-field allowance used to charge.
    expect(br.perRecordBytes).toBeLessThanOrEqual(8);

    // tlvsRegion budget is `pduLength - 27`, prefix 1; one record needs only a
    // few bytes of budget. The fixed header (27B) ends at pduLength 27, so a
    // record appears within a handful of bytes past it. perRecordBytes now also
    // charges the seeded switch-arm value `tlvValue = bytes(ref tlvLength)` (the
    // switch-nested per-record value freeze fix), so the first record appears a
    // few bytes later — around pduLength 34.
    const baseline = cellCount(src, mirror, { pduLength: 27 });
    const small = cellCount(src, mirror, { pduLength: 40 });
    expect(small, "a record should appear by pduLength ~34").toBeGreaterThan(
      baseline,
    );

    // Growth is monotonically non-decreasing as the length climbs.
    let prev = -1;
    for (let pduLength = 27; pduLength <= 300; pduLength += 1) {
      const cells = cellCount(src, mirror, { pduLength });
      expect(
        cells,
        `pduLength=${pduLength} must not shrink`,
      ).toBeGreaterThanOrEqual(prev);
      prev = cells;
    }
  });

  it("never over-consumes the scope across a 1..1000 sweep of every boundedRepeat", () => {
    const bad: string[] = [];
    for (const [key, src] of Object.entries(PRESETS)) {
      const mirror = psdlToRenderer(src);
      for (const br of mirror.boundedRepeats ?? []) {
        for (let len = 1; len <= 1000; len++) {
          try {
            cellCount(src, mirror, { [br.lengthKey]: len });
          } catch {
            bad.push(`${key}/${br.countKey}=${len}`);
            break;
          }
        }
      }
    }
    expect(bad).toEqual([]);
  }, 120000);
});
