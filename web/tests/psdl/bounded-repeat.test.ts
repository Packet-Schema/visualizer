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
