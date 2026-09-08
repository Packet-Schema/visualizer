// nested-tlv DIRECT repeat-of-repeat (arbitrary PSDL): a TLV-shaped eos repeat
// (element = a SINGLE peek-discriminated Switch, isTlvRepeat) that is a DIRECT
// child of an OUTER repeat's element — with NO intervening switch case or
// optional — used to get ZERO override surface: no count stepper for the inner
// repeat and no peek option-type picker. The inner option records still render
// per outer instance (`ik#i_j`), and the inner count (env[repeat.id]) plus the
// peek discriminator (__peek__0__8) genuinely drive the diagram, so the user
// could SEE the option cells but had no panel control to add/remove them or
// change their type (see-but-cannot-edit; the bar covers ANY user-authored PSDL,
// not just the 184 built-ins — none of which nest this exact shape, because
// rtcpSdesItems / lispRecLocators carry a discriminator FIELD before the switch
// so isTlvRepeat is false and they surface via the normal path).
//
// The icmpv6Ndp fix and its "one level deeper" relaxation only covered a TLV
// repeat reached THROUGH a switch case or optional (precondition `(insideSwitch
// || insideOptional) && (!insideRepeat || enclosingInstantiable)`), so a TLV
// repeat that is a DIRECT repeat-of-repeat child (insideSwitch=insideOptional=
// false, insideRepeat=true) fell through. collectFreeRepeats / collectPeekSwitches
// now add `insideRepeat && enclosingInstantiable` as an independent qualifying
// branch, keyed on the inner repeat's bare id / the bare peek discriminator (core
// reads both for every outer instance) — a single shared control per the
// documented A7 per-record tradeoff.

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

// Build `repeat<count=outerCount> { repeat eos { switch on peek } }` — the inner
// TLV-shaped repeat is a DIRECT child of the outer repeat's element, with NO
// switch case / optional between them.
function directRepeatOfRepeat(outerCount: PsdlPacket["body"]): PsdlPacket {
  return {
    name: "t",
    rowBits: 32,
    body: [
      { kind: "field", id: "outerN", type: { kind: "int", bits: 8 } },
      {
        kind: "repeat",
        id: "outer",
        count: outerCount as unknown,
        element: {
          fields: [
            {
              kind: "repeat",
              id: "inner",
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
                            id: "ik",
                            type: { kind: "int", bits: 8 },
                          },
                          {
                            kind: "field",
                            id: "iv",
                            type: { kind: "int", bits: 8 },
                          },
                        ],
                      },
                      "2": {
                        id: "o2",
                        fields: [
                          {
                            kind: "field",
                            id: "ik2",
                            type: { kind: "int", bits: 8 },
                          },
                          {
                            kind: "field",
                            id: "iv2",
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
    ],
  } as unknown as PsdlPacket;
}

// The outer count is a ref to a plain top-level int (`outerN`), so the outer
// repeat is a free (op/ref-count) stepper and therefore instantiable — its
// records render and the inner TLV repeat's records are on screen.
const shapeB = directRepeatOfRepeat({
  kind: "ref",
  field: "outerN",
} as unknown as PsdlPacket["body"]);

describe("nested-tlv direct repeat-of-repeat: TLV peek repeat directly inside a repeat", () => {
  it("surfaces a count stepper + peek picker for the inner TLV repeat", () => {
    const mirror = psdlToRenderer(shapeB);

    // (1) eos count stepper keyed on the inner repeat's bare id, seeded to one
    // representative option record. The direct-repeat-of-repeat shape has NO
    // enclosing switch case, so there is no discriminator gate.
    const inner = (mirror.freeRepeats ?? []).find(
      (r) => r.countKey === "inner",
    );
    expect(inner).toBeDefined();
    expect(inner!.defaultCount).toBe(1);
    expect(inner!.gate).toBeUndefined();

    // The outer ref-count stepper is still surfaced too.
    expect((mirror.freeRepeats ?? []).map((r) => r.countKey)).toContain(
      "outerN",
    );

    // (2) the inner peek option-type picker publishing the real bare peek key.
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
    const seed = initialState(psdlToRenderer(shapeB));

    // On load a representative inner option record renders under the outer
    // instance(s) — the records the user sees are exactly what the surfaced
    // count/peek controls govern.
    const base = cellIds(shapeB, seed as Record<string, number>);
    expect(base.some((id) => id.startsWith("ik#0"))).toBe(true);

    // Stepping the inner count key (bare id) adds an option record to every outer
    // instance — a live, non-inert control (the A7 per-record tradeoff). Core
    // reads env[inner] for each outer iteration.
    const grown = cellIds(shapeB, { outerN: 2, inner: 3, __peek__0__8: 1 });
    expect(grown.filter((id) => id.startsWith("ik#0")).length).toBe(3);
    expect(grown.filter((id) => id.startsWith("ik#1")).length).toBe(3);

    // Driving the peek key switches the rendered option type across every
    // instance — proving the published peek key is the real discriminator.
    const opt2 = cellIds(shapeB, { outerN: 1, inner: 1, __peek__0__8: 2 });
    expect(opt2.some((id) => id.startsWith("iv2#0"))).toBe(true);
    expect(opt2.some((id) => id.startsWith("iv#0"))).toBe(false);
  });

  it("a NON-instantiable outer (virtual-driven count) surfaces NOTHING inner — no inert control", () => {
    // The outer count is `ref(cnt)` where `cnt` is a `virtual` (recomputed by
    // normalize each render), so the outer is in NEITHER freeRepeats NOR
    // boundedRepeats — no control can make its records appear. Surfacing an inner
    // count stepper / peek picker would be a permanently-inert, misleading control
    // over a region that never renders. The relaxation gates on
    // `enclosingInstantiable`, so it correctly stays silent.
    const nonInst: PsdlPacket = {
      name: "nonInst",
      rowBits: 32,
      body: [
        { kind: "virtual", id: "cnt", expr: { kind: "lit", value: 0 } },
        ...(directRepeatOfRepeat({
          kind: "ref",
          field: "cnt",
        } as unknown as PsdlPacket["body"]).body as PsdlPacket["body"]),
      ],
    } as unknown as PsdlPacket;
    const mirror = psdlToRenderer(nonInst);
    expect((mirror.freeRepeats ?? []).map((r) => r.countKey)).not.toContain(
      "inner",
    );
    expect(mirror.peekSwitches ?? []).toEqual([]);
  });
});
