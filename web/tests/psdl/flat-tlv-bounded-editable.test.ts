// Flat bounded-eos TLV-shaped records used to be see-but-cannot-edit.
//
// A repeat with count:"eos" inside a single-ref byte budget, whose record is a
// FLAT triplet `[type, length X (int), value = bytes(ref X), …]` (NOT a single
// Switch, so it is not isTlvRepeat / TLV-promoted; NOT wrapping its own nested
// bounded, so it is not the TLV-extension idiom) was lowered to a boundedRepeat
// exposing only the COUNT key and the outer BUDGET length key. The per-record
// length field X (stun's stunAttrLen, pppoe's tagLength, bgpOpen's parmLen,
// cops' copsObjLength, …) got NO control and was never seeded, so every record's
// value = bytes(ref X) stayed width 0 and INVISIBLE: the user saw each record's
// Type and Length=0 cells but could never make the VALUE appear, and raising the
// budget only added MORE empty records.
//
// Fix: collectFreeRepeats' plain bounded-eos derive now detects a flat
// sibling-sized value field and emits a per-record innerScopeSeed on the
// boundedRepeat (mirroring the TLV-extension tlvExtensionInnerSeeds /
// isisLsp lengthSeeds), solved against the value's length Expr so an
// offset/scaled length (cops' `copsObjLength - 4`, gist's `gistObjLen * 4`)
// still resolves to a visible value. perRecordBytes charges the seeded value
// bytes so the budget-derived count stays conservative. When the budget is a
// plain `ref(lengthKey)` a defaultLength also seeds ONE record at load.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import {
  mergeInstancesIntoPsdl,
  psdlToRenderer,
} from "@/lib/psdl/psdl-to-renderer";
import { fromJson, toJson } from "@/lib/formats/json";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { evalExprOr } from "@/lib/psdl/expr";
import { initialState } from "@/lib/psdl/renderer-helpers";
import type { Packet as RendererPacket } from "@/lib/psdl/renderer";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

// Mirror PacketViewer's layout env build: controller state (incl. innerScope /
// defaultLength seeds via initialState), then the bounded-repeat count derive.
function cellIds(
  src: PsdlPacket,
  mirror: RendererPacket,
  overrides: Record<string, number>,
): string[] {
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
    env.set(br.countKey, Math.floor(forRecords / br.perRecordBytes));
  }
  return resolveLayout(src, { env }).cells.map((c) => c.field.id);
}

describe("flat bounded-eos TLV records are editable (stun)", () => {
  const src = PRESETS.stun!;
  const mirror = psdlToRenderer(src);

  it("surfaces a boundedRepeat with a per-record length seed for the value", () => {
    const br = (mirror.boundedRepeats ?? []).find(
      (b) => b.countKey === "stunAttributes",
    );
    expect(br, "stunAttributes must surface a boundedRepeat").toBeDefined();
    expect(br!.lengthKey).toBe("stunMessageLength");
    // The per-record value-length field (stunAttrLen) is seeded so the
    // representative record's stunAttrValue resolves to a visible width.
    const seed = br!.innerScopeSeeds?.find((s) => s.key === "stunAttrLen");
    expect(seed, "stunAttrLen must be seeded").toBeDefined();
    expect(seed!.value).toBeGreaterThan(0);
    // perRecordBytes charges the seeded value, so it exceeds the bare
    // type+length prefix (which would estimate the value at ~0 B).
    expect(br!.perRecordBytes).toBeGreaterThanOrEqual(8);
  });

  it("renders the attribute VALUE cell at default load (was permanently width-0)", () => {
    const load = cellIds(src, mirror, {});
    // The whole triplet — including the previously-invisible VALUE — renders.
    expect(load).toContain("stunAttrType#0");
    expect(load).toContain("stunAttrLen#0");
    expect(load).toContain("stunAttrValue#0");
  });

  it("raising the budget grows real records, each with a visible value", () => {
    const load = cellIds(src, mirror, {});
    const grown = cellIds(src, mirror, { stunMessageLength: 40 });
    expect(grown).toContain("stunAttrValue#0");
    expect(grown).toContain("stunAttrValue#1");
    expect(grown.length).toBeGreaterThan(load.length);

    // More budget → strictly more records.
    const bigger = cellIds(src, mirror, { stunMessageLength: 120 });
    expect(bigger.length).toBeGreaterThan(grown.length);
  });

  it("never over-consumes the attributes scope across a length sweep", () => {
    for (let len = 0; len <= 600; len++) {
      expect(
        () => cellIds(src, mirror, { stunMessageLength: len }),
        `stunMessageLength=${len} must not over-consume`,
      ).not.toThrow();
    }
  });

  it("round-trips losslessly through export (source+mirror) → JSON → re-import", () => {
    // The real share/export path lifts edits via mergeInstancesIntoPsdl(source,
    // mirror) — preserving the bounded scope — then embeds env in JSON.
    const lifted = mergeInstancesIntoPsdl(src, mirror);
    const env = new Map<string, number>(
      Object.entries(initialState(mirror)).map(([k, v]) => [k, Number(v)]),
    );
    const text = toJson(lifted, env);
    const { packet: reimported } = fromJson(text);
    const mirror2 = psdlToRenderer(reimported);

    const br1 = (mirror.boundedRepeats ?? []).find(
      (b) => b.countKey === "stunAttributes",
    );
    const br2 = (mirror2.boundedRepeats ?? []).find(
      (b) => b.countKey === "stunAttributes",
    );
    // The flat-TLV inner-scope seed is re-derived identically after round-trip.
    expect(br2?.innerScopeSeeds).toEqual(br1?.innerScopeSeeds);
    // The re-imported packet still renders the previously-invisible value.
    expect(cellIds(reimported, mirror2, {})).toContain("stunAttrValue#0");
  });
});

describe("flat bounded-eos TLV records with offset/scaled value lengths", () => {
  // cops' value length is `copsObjLength - 4`; gist's is `gistObjLen * 4`.
  // A naive seed equal to the target byte count would resolve those to 0 / a
  // huge width — the seed is solved against the Expr instead.
  it.each([
    [
      "cops",
      "copsObjects",
      "copsObjLength",
      "copsObjContents",
      "copsMessageLength",
      60,
    ],
    [
      "gist",
      "gistObjects",
      "gistObjLen",
      "gistObjValue",
      "gistMessageLength",
      20,
    ],
    ["bgpOpen", "bgpOptParms", "parmLen", "parmValue", "optParmLen", 40],
    ["pppoe", "pppoeTagList", "tagLength", "tagValue", "payloadLength", 40],
    [
      "hip",
      "hipParameters",
      "hipParamLen",
      "hipParamContents",
      "hipHeaderLength",
      12,
    ],
    [
      "ipfix",
      "ipfixSets",
      "ipfixSetLength",
      "ipfixSetRecords",
      "ipfixLength",
      60,
    ],
    [
      "bgpLs",
      "bgpLsDescriptorTlvs",
      "bgpLsTlvLength",
      "bgpLsTlvValue",
      "bgpLsTotalNlriLength",
      60,
    ],
  ] as const)(
    "%s: raising the budget renders the per-record value",
    (key, countKey, lenKey, valueId, budgetKey, budget) => {
      const src = (PRESETS as Record<string, PsdlPacket | undefined>)[key]!;
      const mirror = psdlToRenderer(src);
      const br = (mirror.boundedRepeats ?? []).find(
        (b) => b.countKey === countKey,
      );
      expect(
        br,
        `${key} ${countKey} must surface a boundedRepeat`,
      ).toBeDefined();
      const seed = br!.innerScopeSeeds?.find((s) => s.key === lenKey);
      expect(seed, `${key} ${lenKey} must be seeded`).toBeDefined();

      const grown = cellIds(src, mirror, { [budgetKey]: budget });
      expect(
        grown,
        `${key} ${valueId} must render once the budget is raised`,
      ).toContain(`${valueId}#0`);
    },
  );
});

// A flat bounded-eos TLV record under a *SCALED* affine budget (hip's
// `hipHeaderLength*8 - 32`) used to render NOTHING at load: the flat-TLV
// `defaultLength` seed only fired for a PLAIN-ref budget (`budgetIsPlainRefFlat`)
// and the record-switch seed only for an element holding a switch — hip is
// neither (scaled budget + switch-free {type,length,contents} element), so no
// `defaultLength` was emitted. Worse, hip's budget field `hipHeaderLength` is a
// `controlsLength` octet seeded to its RFC minimum 4 (a header with NO
// parameters → budget `4*8-32 = 0`), so even an emitted `defaultLength` was
// suppressed by the old `!state[lengthKey]` gate. At load the derived count was
// `floor((0)/perRecord) = 0` and the ENTIRE hipParameters TLV section (type,
// length, contents) was invisible — the user saw only the fixed HIP header with
// no cue the parameter list existed (#11/#12 discoverability, the class
// babel/isisLsp/bgpOpen already fix via the plain-ref defaultLength).
describe("hip parameters render at load under a scaled affine budget", () => {
  const src = PRESETS.hip!;
  const mirror = psdlToRenderer(src);

  it("emits a defaultLength solved against the *8 budget multiplier", () => {
    const br = (mirror.boundedRepeats ?? []).find(
      (b) => b.countKey === "hipParameters",
    );
    expect(br, "hipParameters must surface a boundedRepeat").toBeDefined();
    expect(br!.lengthKey).toBe("hipHeaderLength");
    // perRecord=8, prefix=1, budget = hipHeaderLength*8 - 32: the smallest
    // hipHeaderLength giving one record is ceil((32 + 1 + 8) / 8) = 6, NOT the
    // un-scaled `32 + 1 + 8 = 41` the multiplier-blind record-switch path emits.
    expect(br!.defaultLength).toBe(6);
  });

  it("raises hipHeaderLength past its RFC-minimum default so the budget admits a record", () => {
    // The field default is 4 (RFC minimum for a header with NO parameters);
    // initialState raises it to the defaultLength because 4 < 6.
    expect(initialState(mirror).hipHeaderLength).toBe(6);
  });

  it("renders exactly one complete hipParameters record at load (was entirely invisible)", () => {
    const load = cellIds(src, mirror, {});
    expect(load).toContain("hipParamType#0");
    expect(load).toContain("hipParamLen#0");
    expect(load).toContain("hipParamContents#0");
    // Conservative: the budget admits exactly one record at the seed.
    expect(load).not.toContain("hipParamType#1");
  });

  it("a deliberate sub-threshold hipHeaderLength still collapses the section (no override)", () => {
    // A user / saved-env value wins over the seed (merged on top of
    // initialState), so the RFC-minimum 4 still yields the no-parameters layout.
    const load = cellIds(src, mirror, { hipHeaderLength: 4 });
    expect(load).not.toContain("hipParamType#0");
  });

  it("never over-consumes the parameter scope across a header-length sweep", () => {
    for (let len = 0; len <= 255; len++) {
      expect(
        () => cellIds(src, mirror, { hipHeaderLength: len }),
        `hipHeaderLength=${len} must not over-consume`,
      ).not.toThrow();
    }
    // More budget → strictly more records.
    const one = cellIds(src, mirror, {});
    const more = cellIds(src, mirror, { hipHeaderLength: 12 });
    expect(more.length).toBeGreaterThan(one.length);
  });
});
