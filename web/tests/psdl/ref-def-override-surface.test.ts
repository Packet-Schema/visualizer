// Audit gap: a user PSDL whose ref-resolved `def` contains a repeat-of-switch
// renders records in the diagram but exposed ZERO override surface. The mirror's
// top-level walk (`flattenForMirror(packet.body, packet.defs)`) resolved the
// def's FIELDS, but the override collectors did NOT thread `defs`:
//   - collectFreeRepeats walked the body manually and skipped `kind:"ref"`,
//   - collectRefSwitches / collectPeekSwitches / attachOverrideMetadata called
//     flattenForMirror with NO defs argument.
// So the repeat got no record-count stepper and its discriminator switch got no
// variant picker — see-but-cannot-edit. No built-in preset triggers this (no
// referenced def in the 184 presets contains a switch/repeat), so it is an
// arbitrary-PSDL gap. This locks in that the collectors are ref-aware.

import { describe, it, expect } from "vitest";

import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

// body = [recCount:int8, ref(Recs)]
// Recs.fields = [repeat recs count=ref(recCount)
//                  element=[rtype:int8, switch recSw on ref(rtype) {1:RecA, 2:RecB}]]
const psdl = {
  name: "RefDefRepeatSwitch",
  rowBits: 32,
  body: [
    { id: "recCount", name: "Rec Count", type: { kind: "int", bits: 8 } },
    { kind: "ref", id: "recs", ref: "Recs" },
  ],
  defs: {
    Recs: {
      id: "Recs",
      fields: [
        {
          kind: "repeat",
          id: "recs",
          count: { kind: "ref", field: "recCount" },
          element: {
            id: "rec",
            fields: [
              { id: "rtype", name: "Type", type: { kind: "int", bits: 8 } },
              {
                kind: "switch",
                id: "recSw",
                on: { kind: "ref", field: "rtype" },
                cases: {
                  "1": {
                    id: "RecA",
                    name: "RecA",
                    fields: [
                      {
                        id: "aVal",
                        name: "A",
                        type: { kind: "int", bits: 16 },
                      },
                    ],
                  },
                  "2": {
                    id: "RecB",
                    name: "RecB",
                    fields: [
                      {
                        id: "bVal",
                        name: "B",
                        type: { kind: "int", bits: 32 },
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
} as unknown as PsdlPacket;

function cellIds(overrides: Record<string, number>): string[] {
  const env = new Map<string, number>(Object.entries(overrides));
  for (const [k, v] of initialEnv(psdl)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  return resolveLayout(psdl, { env }).cells.flatMap((c) => [
    c.field.id,
    ...(c.subCells ?? []).map((s) => s.subfield.id),
  ]);
}

describe("ref-resolved def with a nested repeat/switch exposes override surface", () => {
  it("records render in the diagram (baseline: not a no-op packet)", () => {
    // The records ARE drawn by resolveLayout (the see-but-cannot-edit premise).
    const ids = cellIds({ recCount: 3, rtype: 2 });
    expect(ids).toContain("recCount");
    // Per-record cells carry the ref-container id prefix + a `#<n>` instance
    // suffix (e.g. `recs.rtype#0`). Three records render at recCount=3.
    expect(ids.some((id) => /(^|\.)rtype#\d+$/.test(id))).toBe(true);
  });

  it("surfaces a record-count stepper for the repeat inside the def", () => {
    const r = psdlToRenderer(psdl);
    const fr = (r.freeRepeats ?? []).find((f) => f.countKey === "recCount");
    expect(fr, "recCount stepper must be surfaced").toBeTruthy();
  });

  it("surfaces a refSwitch variant picker for the in-def discriminator", () => {
    const r = psdlToRenderer(psdl);
    const rs = (r.refSwitches ?? []).find((s) => s.refKey === "rtype");
    expect(rs, "rtype variant picker must be surfaced").toBeTruthy();
    expect(rs!.cases.map((c) => c.value).sort()).toEqual([1, 2]);
  });

  it("the surfaced picker actually drives the rendered record variant", () => {
    // RecA (16-bit aVal) vs RecB (32-bit bVal): selecting the variant must change
    // the diagram, proving the picker isn't inert.
    const asA = cellIds({ recCount: 1, rtype: 1 });
    const asB = cellIds({ recCount: 1, rtype: 2 });
    expect(asA).not.toEqual(asB);
  });
});
