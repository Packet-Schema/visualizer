// nested-tlv ONE LEVEL DEEPER (arbitrary PSDL): a TLV-shaped eos repeat
// (peek-discriminated) OR a plain ref-discriminated record-variant switch that
// lives inside a switch CASE which is itself inside ANOTHER repeat used to get
// ZERO override surface — no count stepper, no peek picker, no variant picker —
// even though the records render per outer instance (`#i_j`). The user could
// SEE the inner option/variant cells but had no control to add/remove them or
// change their type (see-but-cannot-edit; the bar covers ANY user-authored
// PSDL, not just the 184 built-in presets — none of which nest this deep).
//
// The fix treats a repeat as INSTANTIABLE (its records always render) when it
// has a literal count >= 1, and relaxes the switch/optional-nested TLV-repeat
// guard in collectFreeRepeats / collectPeekSwitches to the insideRepeat case
// when the enclosing repeat is instantiable. The controls are keyed on the
// repeat's bare id / the bare discriminator (peek/ref) — core reads those for
// every outer instance — so a single shared control drives every record
// uniformly (the documented A7 per-record tradeoff). Per-instance switch/peek
// discrimination is deliberately NOT attempted: core resolves a switch `on`
// from the bare discriminator key, never a `#i`-qualified one, so a per-instance
// picker would be inert (verified below).

import { describe, it, expect } from "vitest";

import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialState } from "@/lib/psdl/renderer-helpers";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

function cellIds(psdl: PsdlPacket, env: Record<string, number>): string[] {
  return resolveLayout(psdl, { env: new Map(Object.entries(env)) }).cells.map(
    (c) => c.field.id,
  );
}

// Probe A: a TLV-shaped (single peek-switch element) eos repeat inside a switch
// case (`kind`) inside a literal-count outer repeat.
const probeA: PsdlPacket = {
  name: "probeA",
  rowBits: 32,
  body: [
    { kind: "field", id: "msgType", type: { kind: "int", bits: 8 } },
    {
      kind: "repeat",
      id: "outer",
      count: { kind: "lit", value: 2 },
      element: {
        fields: [
          { kind: "field", id: "kind", type: { kind: "int", bits: 8 } },
          {
            kind: "switch",
            id: "sw",
            on: { kind: "ref", field: "kind" },
            cases: {
              "1": {
                id: "c1",
                fields: [
                  {
                    kind: "repeat",
                    id: "innerTlv",
                    count: "eos",
                    element: {
                      fields: [
                        {
                          kind: "switch",
                          id: "optSw",
                          on: { kind: "peek", bits: 8 },
                          cases: {
                            "1": {
                              id: "o1",
                              fields: [
                                {
                                  kind: "field",
                                  id: "o1t",
                                  type: { kind: "int", bits: 8 },
                                },
                                {
                                  kind: "field",
                                  id: "o1v",
                                  type: { kind: "int", bits: 8 },
                                },
                              ],
                            },
                            "2": {
                              id: "o2",
                              fields: [
                                {
                                  kind: "field",
                                  id: "o2t",
                                  type: { kind: "int", bits: 8 },
                                },
                                {
                                  kind: "field",
                                  id: "o2v",
                                  type: { kind: "int", bits: 16 },
                                },
                              ],
                            },
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    },
  ],
} as unknown as PsdlPacket;

// Probe B: a plain ref-discriminated record-variant switch directly inside a
// literal-count repeat.
const probeB: PsdlPacket = {
  name: "probeB",
  rowBits: 32,
  body: [
    { kind: "field", id: "kind", type: { kind: "int", bits: 8 } },
    {
      kind: "repeat",
      id: "outer",
      count: { kind: "lit", value: 2 },
      element: {
        fields: [
          { kind: "field", id: "rType", type: { kind: "int", bits: 8 } },
          {
            kind: "switch",
            id: "rSw",
            on: { kind: "ref", field: "rType" },
            cases: {
              "1": {
                id: "c1",
                fields: [
                  {
                    kind: "field",
                    id: "raVal",
                    type: { kind: "int", bits: 8 },
                  },
                ],
              },
              "2": {
                id: "c2",
                fields: [
                  {
                    kind: "field",
                    id: "rbVal",
                    type: { kind: "int", bits: 16 },
                  },
                ],
              },
            },
          },
        ],
      },
    },
  ],
} as unknown as PsdlPacket;

describe("nested-tlv-in-repeat: TLV peek repeat inside switch-case inside repeat", () => {
  it("surfaces a count stepper + peek picker for the inner TLV repeat", () => {
    const mirror = psdlToRenderer(probeA);

    // (1) eos count stepper keyed on the inner repeat's bare id, gated on its
    // owning case discriminator, seeded to one record.
    const inner = (mirror.freeRepeats ?? []).find(
      (r) => r.countKey === "innerTlv",
    );
    expect(inner).toBeDefined();
    expect(inner!.defaultCount).toBe(1);
    expect(inner!.gate).toEqual({ key: "kind", value: 1 });

    // (2) the inner peek type-picker publishing the real peek key.
    const peek = (mirror.peekSwitches ?? []).find(
      (p) => p.peekKey === "__peek__0__8",
    );
    expect(peek).toBeDefined();
    expect(peek!.cases.map((c) => c.value).sort()).toEqual([1, 2]);

    // It is NOT promoted to a top-level tlv field — the stepper + picker are the
    // controls.
    expect(mirror.fields.some((f) => f.tlv)).toBe(false);
  });

  it("the surfaced controls actually drive the per-outer-instance diagram", () => {
    const seed = initialState(psdlToRenderer(probeA));

    // On load a representative inner option record renders under BOTH outer
    // instances (#0_0 and #1_0) — the records the user sees are exactly what the
    // surfaced count/peek controls govern.
    const base = cellIds(probeA, seed as Record<string, number>);
    expect(base).toContain("o1t#0_0");
    expect(base).toContain("o1t#1_0");

    // Stepping the inner count key (bare id) adds an option record to every
    // outer instance — a live, non-inert control (the A7 per-record tradeoff).
    const grown = cellIds(probeA, {
      msgType: 1,
      kind: 1,
      innerTlv: 2,
      __peek__0__8: 1,
    });
    expect(grown.filter((id) => id.startsWith("o1t#0")).length).toBe(2);
    expect(grown.filter((id) => id.startsWith("o1t#1")).length).toBe(2);

    // Driving the peek key switches the rendered option type across every
    // instance — proving the published peek key is the real one.
    const opt2 = cellIds(probeA, {
      msgType: 1,
      kind: 1,
      innerTlv: 1,
      __peek__0__8: 2,
    });
    expect(opt2).toContain("o2v#0_0");
    expect(opt2).toContain("o2v#1_0");
  });
});

describe("nested-tlv-in-repeat: ref-variant switch inside a literal-count repeat", () => {
  it("surfaces a record-variant picker keyed on the bare discriminator", () => {
    const mirror = psdlToRenderer(probeB);
    const picker = (mirror.refSwitches ?? []).find((r) => r.refKey === "rType");
    expect(picker).toBeDefined();
    expect(picker!.cases.map((c) => c.value).sort()).toEqual([1, 2]);
  });

  it("the variant picker drives the rendered arm for every record", () => {
    // Default (initialState seeds rType to the first case) renders the case-1
    // value under both instances.
    const seed = initialState(psdlToRenderer(probeB));
    const def = cellIds(probeB, seed as Record<string, number>);
    expect(def).toContain("raVal#0");
    expect(def).toContain("raVal#1");

    // Selecting variant 2 swaps EVERY record's arm — a live control. (Core reads
    // the switch `on` from the bare `rType`, so the single shared key drives all
    // outer instances uniformly.)
    const v2 = cellIds(probeB, { kind: 1, rType: 2 });
    expect(v2).toContain("rbVal#0");
    expect(v2).toContain("rbVal#1");
    expect(v2).not.toContain("raVal#0");
  });

  it("a `#i`-qualified discriminator override is INERT (justifies the shared key)", () => {
    // Core resolves a switch `on: ref(rType)` from the bare `rType` env key,
    // never a per-instance `rType#0`. Setting `rType#0` therefore does NOT change
    // instance 0's arm — so a per-instance refSwitch picker would be a misleading
    // inert control. This is the empirical reason the fix uses a single shared
    // discriminator key (drives all records uniformly) rather than per-instance
    // keys; if core ever gains per-instance discrimination this canary flips.
    const bare = cellIds(probeB, { kind: 1, rType: 2 });
    const perInstance = cellIds(probeB, { kind: 1, rType: 2, "rType#0": 1 });
    expect(perInstance).toEqual(bare);
  });
});

// Build a `repeat { switch on k { case: repeat eos { switch on peek } } }`
// packet whose OUTER count is supplied by `outerCount`.
function deepNest(outerCount: PsdlPacket["body"]): PsdlPacket {
  return {
    name: "deep",
    rowBits: 32,
    body: [
      {
        kind: "repeat",
        id: "outer",
        count: outerCount as unknown,
        element: {
          fields: [
            { kind: "field", id: "k", type: { kind: "int", bits: 8 } },
            {
              kind: "switch",
              id: "sw",
              on: { kind: "ref", field: "k" },
              cases: {
                "1": {
                  id: "c1",
                  fields: [
                    {
                      kind: "repeat",
                      id: "innerTlv",
                      count: "eos",
                      element: {
                        fields: [
                          {
                            kind: "switch",
                            id: "optSw",
                            on: { kind: "peek", bits: 8 },
                            cases: {
                              "1": {
                                id: "o1",
                                fields: [
                                  {
                                    kind: "field",
                                    id: "o1t",
                                    type: { kind: "int", bits: 8 },
                                  },
                                ],
                              },
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
      },
    ],
  } as unknown as PsdlPacket;
}

describe("nested-tlv-in-repeat: gated on the enclosing repeat being instantiable", () => {
  it("an instantiable (eos free-stepper) outer surfaces the inner TLV repeat", () => {
    // An `eos` outer with no enclosing budget is itself a free count stepper, so
    // its records render — the inner TLV repeat is on screen and IS surfaced.
    const mirror = psdlToRenderer(
      deepNest("eos" as unknown as PsdlPacket["body"]),
    );
    const innerKeys = (mirror.freeRepeats ?? []).map((r) => r.countKey);
    expect(innerKeys).toContain("outer");
    expect(innerKeys).toContain("innerTlv");
    expect((mirror.peekSwitches ?? []).map((p) => p.peekKey)).toContain(
      "__peek__0__8",
    );
  });

  it("a NON-instantiable outer (virtual-driven count) surfaces NOTHING inner — no inert control", () => {
    // The outer count is `ref(cnt)` where `cnt` is a `virtual` (recomputed by
    // normalize each render, so a stepper write can't survive) — the outer is in
    // NEITHER freeRepeats NOR boundedRepeats, so no control can make its records
    // appear. Surfacing an inner count stepper / peek picker there would be a
    // permanently-inert, misleading control over a region that never renders.
    // The relaxation gates on `enclosingInstantiable`, so it correctly stays
    // silent — exactly the bgpPathAttributes-class suppression, one level deeper.
    const nonInst: PsdlPacket = {
      name: "nonInst",
      rowBits: 32,
      body: [
        { kind: "virtual", id: "cnt", expr: { kind: "lit", value: 0 } },
        ...(deepNest({
          kind: "ref",
          field: "cnt",
        } as unknown as PsdlPacket["body"]).body as PsdlPacket["body"]),
      ],
    } as unknown as PsdlPacket;
    const mirror = psdlToRenderer(nonInst);
    expect(mirror.freeRepeats ?? []).toEqual([]);
    expect(mirror.boundedRepeats ?? []).toEqual([]);
    expect(mirror.peekSwitches ?? []).toEqual([]);
    expect((mirror.refSwitches ?? []).map((r) => r.refKey)).not.toContain("k");
  });
});
