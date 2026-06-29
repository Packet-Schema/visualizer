// optional-wrapped-tlv (high): a TLV-shaped Repeat (element = a single Switch,
// count = eos/until) wrapped DIRECTLY in an `optional` container — e.g.
// `optional(flag){ repeat eos { switch on peek } }` — renders records in the
// diagram but exposed NO editable control: no freeRepeat count stepper, no
// peek/ref type picker, and it was NOT promoted to a top-level `tlv` field.
//
// This is the same see-but-cannot-edit class already fixed for icmpv6Ndp (a TLV
// repeat inside a SWITCH CASE), but that fix only relaxed the `!isTlvRepeat`
// guard for `insideSwitch`. flattenForMirror does NOT erase an `optional`
// wrapper and it is not a switch case, so the optional-wrapped TLV repeat fell
// through every path (isTlvRepeat()===true disqualifies it from the freeRepeat /
// peekSwitch collectors, and repeatToTlvField only sees TOP-LEVEL body Repeats).
//
// The fix threads an `insideOptional` flag through collectFreeRepeats and
// collectPeekSwitches and broadens the relaxation to
// `isTlvRepeat(c) && (insideSwitch || insideOptional) && !insideRepeat`, set
// true when descending the `optional` branch. This surfaces the eos count
// stepper keyed on env[repeat.id] plus the peek picker — exactly as the
// icmpv6Ndp switch-nested fix does.

import { describe, it, expect } from "vitest";

import { peek, ref } from "@/lib/psdl/expr";
import {
  psdlToRenderer,
  mergeInstancesIntoPsdl,
} from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

const bits = (n: number) => ({ kind: "bits" as const, n });

// `optional(ref flag){ repeat 'recs' count:eos element:[ switch 'recSw' on
// peek(8) ] }` — the optional-wrapped TLV-shaped repeat.
function mkPacket(): PsdlPacket {
  return {
    name: "OptionalWrappedTlv",
    rowBits: 32,
    body: [
      { id: "flag", name: "Flag", type: bits(8) },
      {
        kind: "optional",
        id: "recsOpt",
        when: ref("flag"),
        container: {
          kind: "repeat",
          id: "recs",
          count: "eos",
          element: {
            id: "recStruct",
            fields: [
              {
                kind: "switch",
                id: "recSw",
                on: peek(8),
                cases: {
                  "1": {
                    id: "recA",
                    name: "Type A",
                    fields: [
                      { id: "aType", name: "A Type", type: bits(8) },
                      { id: "aVal", name: "A Value", type: bits(8) },
                    ],
                  },
                  "2": {
                    id: "recB",
                    name: "Type B",
                    fields: [
                      { id: "bType", name: "B Type", type: bits(8) },
                      { id: "bVal", name: "B Value", type: bits(16) },
                    ],
                  },
                },
              },
            ],
          },
        },
      },
    ],
  };
}

function cellIds(
  psdl: PsdlPacket,
  overrides: Record<string, number>,
): string[] {
  const env = new Map<string, number>(Object.entries(overrides));
  for (const [k, v] of initialEnv(psdl)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  return resolveLayout(psdl, { env }).cells.map((c) => c.field.id);
}

describe("optional-wrapped TLV-shaped repeat surfaces override controls", () => {
  it("emits a freeRepeat count stepper and a peekSwitch (not a tlv field)", () => {
    const mirror = psdlToRenderer(mkPacket());

    // The eos count stepper, keyed on env[repeat.id].
    const recsRepeat = (mirror.freeRepeats ?? []).find(
      (r) => r.countKey === "recs",
    );
    expect(recsRepeat).toBeDefined();
    expect(recsRepeat!.defaultCount).toBe(1);

    // The peek type-picker for choosing the record variant.
    const peekSw = (mirror.peekSwitches ?? []).find((p) => p.id === "recSw");
    expect(peekSw).toBeDefined();
    expect(peekSw!.peekKey).toBe("__peek__0__8");
    expect(peekSw!.cases.map((c) => c.value).sort()).toEqual([1, 2]);

    // It is NOT promoted to a top-level tlv field.
    expect(mirror.fields.some((f) => f.tlv)).toBe(false);
  });

  it("the surfaced controls actually drive the diagram", () => {
    const src = mkPacket();

    // flag on + one record renders the peek-default (value 1 → Type A).
    const base = cellIds(src, { flag: 1, recs: 1, __peek__0__8: 1 });
    expect(base).toContain("aType#0");
    expect(base).toContain("aVal#0");

    // Driving the peek picker to 2 switches the record to Type B — proving the
    // published peek key is the one normalize actually reads.
    const variant = cellIds(src, { flag: 1, recs: 1, __peek__0__8: 2 });
    expect(variant).toContain("bType#0");
    expect(variant).toContain("bVal#0");

    // Raising the count stepper instantiates a second record.
    const two = cellIds(src, { flag: 1, recs: 2, __peek__0__8: 1 });
    expect(two).toContain("aType#1");
    expect(two).toContain("aVal#1");
  });

  it("lift stays idempotent (no spurious instances materialised)", () => {
    const src = mkPacket();
    const lifted = mergeInstancesIntoPsdl(src, psdlToRenderer(src));
    // Re-lifting the already-lifted packet must be a fixed point.
    const twice = mergeInstancesIntoPsdl(lifted, psdlToRenderer(lifted));
    expect(JSON.stringify(twice)).toEqual(JSON.stringify(lifted));
  });
});
