// override-subsystem: ocspRequest `requests` list was see-but-cannot-edit.
//
// The `requests` eos repeat lives inside `bounded(reqListLength)` and its record
// wraps a PER-RECORD `bounded(requestSeqLength)` whose inner scope is a plain
// group of leaf fields (the CertID), NOT a switch. `tlvExtensionInnerSeeds`
// excludes that no-switch shape and returns null, so the repeat landed in
// NEITHER freeRepeats NOR boundedRepeats and got no count/variant control: the
// `reqListLength` slider was surfaced but raising it instantiated ZERO request
// records, so every OCSP CertID the diagram is shaped to show could never be
// made visible or edited.
//
// `nestedGroupBoundedSeeds` now probes a crash-free per-record inner length and
// outer budget so the `requests` repeat becomes a budget-derived boundedRepeat:
// one representative CertID record renders at load and the list grows as the
// user raises the length slider, exactly like every other bounded list.

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
import { seedDynamicWidthDefaults } from "@/lib/psdl/dynamic-width-defaults";
import { evalExprOr } from "@/lib/psdl/expr";
import { initialState } from "@/lib/psdl/renderer-helpers";
import type { Packet as RendererPacket } from "@/lib/psdl/renderer";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

// Mirror PacketViewer's layout env build (the bounded-repeat derive + the
// initialState seeding of innerScopeSeeds / defaultLength).
function layoutWith(
  src: PsdlPacket,
  mirror: RendererPacket,
  overrides: Record<string, number>,
) {
  const ctrl = { ...initialState(mirror), ...overrides };
  const base = applyChainInstances(applyTlvInstances(src, mirror, {}), mirror);
  const env = new Map<string, number>(
    Object.entries(ctrl).map(([k, v]) => [k, Number(v)]),
  );
  for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
  // PacketViewer seeds dynamic-width leaves (varint / delimited / berLength) to a
  // visible default before deriving bounded-repeat counts; mirror that so the
  // berLength octets occupy their 8-bit default exactly as the live diagram.
  seedDynamicWidthDefaults(src, env);
  for (const br of mirror.boundedRepeats ?? []) {
    for (const seed of br.innerScopeSeeds ?? []) {
      if (!env.get(seed.key)) env.set(seed.key, seed.value);
    }
    const budget = evalExprOr(br.bytesExpr, env, 0);
    const forRecords = Math.max(0, budget - br.prefixBytes);
    env.set(br.countKey, Math.floor(forRecords / br.perRecordBytes));
  }
  return resolveLayout(base, { env });
}

const RECORD_FIELD_IDS = [
  "requestSeqTag",
  "requestSeqLength",
  "certIdGroup",
  "hashAlgGroup",
  "issuerNameHashGroup",
  "issuerKeyHashGroup",
  "serialNumberGroup",
];

function recordCellCount(
  src: PsdlPacket,
  mirror: RendererPacket,
  overrides: Record<string, number>,
): number {
  const { cells } = layoutWith(src, mirror, overrides);
  return cells.filter((c) => {
    const base = c.field.id.split("#")[0];
    return RECORD_FIELD_IDS.includes(base);
  }).length;
}

describe("ocspRequest requests list is editable", () => {
  it("surfaces the requests repeat as a budget-derived boundedRepeat", () => {
    const mirror = psdlToRenderer(PRESETS.ocspRequest!);
    const br = (mirror.boundedRepeats ?? []).find(
      (b) => b.countKey === "requests",
    );
    expect(br, "requests must be a boundedRepeat").toBeDefined();
    expect(br!.lengthKey).toBe("reqListLength");
    expect(br!.defaultLength).toBeGreaterThan(0);
    expect(br!.perRecordBytes).toBeGreaterThan(0);
    // The per-record inner CertID length must be seeded so the record renders.
    expect(
      (br!.innerScopeSeeds ?? []).some((s) => s.key === "requestSeqLength"),
    ).toBe(true);
  });

  it("renders a representative request record at the seeded length (load)", () => {
    const src = PRESETS.ocspRequest!;
    const mirror = psdlToRenderer(src);
    // At the default load env (no overrides) the defaultLength seed must make
    // one CertID record appear — the surface was previously empty here.
    const recordCells = recordCellCount(src, mirror, {});
    expect(recordCells).toBeGreaterThan(0);
  });

  it("raising the requestList length slider grows the records", () => {
    const src = PRESETS.ocspRequest!;
    const mirror = psdlToRenderer(src);
    // Start at the seeded defaultLength (one record fits) — a smaller budget
    // legitimately renders zero records now that each CertID record charges its
    // berLength octets at the visible 8-bit default. Raising the slider must add
    // records.
    const br = (mirror.boundedRepeats ?? []).find(
      (b) => b.countKey === "requests",
    )!;
    expect(br.defaultLength).toBeDefined();
    const small = recordCellCount(src, mirror, {
      reqListLength: br.defaultLength!,
    });
    const large = recordCellCount(src, mirror, { reqListLength: 400 });
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small);
  });

  it("never throws across a full reqListLength sweep (no frozen diagram)", () => {
    const src = PRESETS.ocspRequest!;
    const mirror = psdlToRenderer(src);
    const bad: number[] = [];
    for (let len = 0; len <= 1000; len++) {
      try {
        layoutWith(src, mirror, { reqListLength: len });
      } catch {
        bad.push(len);
      }
    }
    expect(bad).toEqual([]);
  }, 120000);
});
