// A flat-TLV bounded repeat (stun stunAttributes, bgpOpen bgpOptParms, pppoe
// pppoeTagList, tlsCertificate tlsCertList, …) shaped `[type, length X, value =
// bytes(<expr over X>)]` inside a single-ref byte budget lowers to a
// boundedRepeat whose per-record length field X is SEEDED (so the value renders
// at a representative width) but carries NO control: the budget (lengthKey)
// slider and the count are the only knobs. The user could SEE a ~4-byte value
// cell but never change its size — clicking the length OR value cell hit
// OverridePanel's read-only EmptyState (see-but-cannot-edit), unlike the PLAIN
// repeat case (dnsResponse dnsRdLength, ocspRequest hashAlgLength) which already
// gets a length controller via collectPlainRepeatLengthControllers.
//
// Fix: collectFlatTlvInnerLengthControllers surfaces each boundedRepeat
// innerScopeSeeds key as a packet-level `controlsLength` controller (the same
// slider IHL gets), so the per-record value's size becomes editable. The
// PacketViewer bounded derive charges the live inner-length overage above the
// seed so raising the controller SHRINKS the derived record count instead of
// over-consuming the bounded scope (which would otherwise throw and freeze the
// diagram). The deliberately-suppressed isisLsp case (value collapses to width
// 0, no innerScopeSeeds) stays without a controller.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { evalExprOr } from "@/lib/psdl/expr";
import { initialState } from "@/lib/psdl/renderer-helpers";
import type { Cell, Packet as RendererPacket } from "@/lib/psdl/renderer";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

// Mirror PacketViewer.buildLayoutEnv's bounded-repeat derive, INCLUDING the
// live inner-length overage that keeps the derived count from over-consuming the
// scope when a per-record length controller is raised. Returns the diagram cells.
function layoutCells(
  src: PsdlPacket,
  mirror: RendererPacket,
  overrides: Record<string, number>,
): Cell[] {
  const ctrl = { ...initialState(mirror), ...overrides };
  const env = new Map<string, number>(
    Object.entries(ctrl).map(([k, v]) => [k, Number(v)]),
  );
  for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
  for (const br of mirror.boundedRepeats ?? []) {
    for (const seed of br.innerScopeSeeds ?? []) {
      if (!env.get(seed.key)) env.set(seed.key, seed.value);
    }
    const budget = evalExprOr(br.bytesExpr, env, 0);
    const forRecords = Math.max(0, budget - br.prefixBytes);
    const overage = (br.innerScopeSeeds ?? []).reduce(
      (sum, seed) =>
        sum +
        Math.max(0, Number(env.get(seed.key) ?? 0) - seed.value) *
          (seed.bytesPerUnit ?? 1),
      0,
    );
    const livePerRecordBytes = br.perRecordBytes + overage;
    // Cap matches PacketViewer's MAX_DERIVED_RECORDS so the test never resolves a
    // pathologically large un-virtualized diagram.
    env.set(
      br.countKey,
      Math.min(2000, Math.floor(forRecords / livePerRecordBytes)),
    );
  }
  return resolveLayout(src, { env }).cells;
}

function fieldBits(cells: readonly Cell[], id: string): number | null {
  const c = cells.find((cell) => cell.field.id === id);
  return c ? c.bitsTotal : null;
}

describe("flat-TLV per-record length is an editable length controller", () => {
  it.each([
    // preset, per-record length field
    ["stun", "stunAttrLen"],
    ["bgpOpen", "parmLen"],
    ["pppoe", "tagLength"],
    ["tlsCertificate", "tlsCertDataLen"],
  ] as const)(
    "%s: surfaces a controlsLength controller for the per-record value length (%s)",
    (key, lenId) => {
      const src = (PRESETS as Record<string, PsdlPacket | undefined>)[key]!;
      const mirror = psdlToRenderer(src);
      const lc = (mirror.lengthControllers ?? []).find((l) => l.id === lenId);
      expect(
        lc,
        `${key} ${lenId} must surface a length controller`,
      ).toBeDefined();
      expect(lc!.controlsLength).toBe(lenId);
      // Seeded to the representative (visible) width, not the field's 0 default.
      expect(lc!.defaultValue).toBeGreaterThan(0);
    },
  );

  it("stun: raising stunAttrLen grows stunAttrValue's width", () => {
    const src = PRESETS.stun!;
    const mirror = psdlToRenderer(src);
    // Plenty of budget so the records aren't squeezed out as the value grows.
    const big = { stunMessageLength: 300 };
    const small = layoutCells(src, mirror, { ...big, stunAttrLen: 4 });
    const large = layoutCells(src, mirror, { ...big, stunAttrLen: 16 });
    const before = fieldBits(small, "stunAttrValue#0");
    const after = fieldBits(large, "stunAttrValue#0");
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(after!).toBeGreaterThan(before!);
    // bytes(ref stunAttrLen): 16 bytes → 128 bits.
    expect(after!).toBe(128);
  });

  it("bgpOpen: raising parmLen grows parmValue's width", () => {
    const src = PRESETS.bgpOpen!;
    const mirror = psdlToRenderer(src);
    const big = { optParmLen: 200 };
    const before = fieldBits(
      layoutCells(src, mirror, { ...big, parmLen: 4 }),
      "parmValue#0",
    );
    const after = fieldBits(
      layoutCells(src, mirror, { ...big, parmLen: 12 }),
      "parmValue#0",
    );
    expect(before).not.toBeNull();
    expect(after!).toBeGreaterThan(before!);
  });

  it("raising a per-record length never over-consumes the bounded scope", () => {
    // The crash-free guarantee: the live-overage derive must keep the derived
    // record count fitting the budget across the whole slider range, for every
    // affected preset (incl. the scaled gist `gistObjLen * 4` length).
    for (const key of [
      "stun",
      "bgpOpen",
      "pppoe",
      "tlsCertificate",
      "dnssecRecords",
      "cops",
      "gist",
    ] as const) {
      const src = (PRESETS as Record<string, PsdlPacket | undefined>)[key]!;
      const mirror = psdlToRenderer(src);
      for (const lc of mirror.lengthControllers ?? []) {
        for (let v = 0; v <= 260; v++) {
          expect(
            () => layoutCells(src, mirror, { [lc.id]: v }),
            `${key} ${lc.id}=${v} must not over-consume`,
          ).not.toThrow();
        }
      }
    }
  });

  it("isisLsp keeps NO per-record length controller (value collapses to width 0)", () => {
    // The suppressed case: its tlvLength sizes a `bytes(ref tlvLength)` value that
    // collapses to width 0 (no innerScopeSeeds), so surfacing a controller would
    // un-suppress an inert all-zero-width control. It must stay absent.
    const mirror = psdlToRenderer(PRESETS.isisLsp!);
    const lengthIds = (mirror.lengthControllers ?? []).map((l) => l.id);
    expect(lengthIds).not.toContain("tlvLength");
    // And the bounded repeat carries no innerScopeSeeds, the discriminator.
    const br = (mirror.boundedRepeats ?? []).find((b) => b.countKey === "tlvs");
    expect(br?.innerScopeSeeds).toBeUndefined();
  });
});
