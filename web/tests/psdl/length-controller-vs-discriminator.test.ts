// A cell must never carry BOTH a length slider (`controlsLength`) and a
// variant dropdown (`switchCases`): they bind the same env key, so moving one
// silently moves the other. The adapter used to try to express this upstream
// with a `!target.switchCases` term, but that ran before
// `attachOverrideMetadata` stamped the property, so it protected nothing.
// `PreMetadataField` makes writing it there a compile error and the rule is
// now enforced once, after the metadata exists.
import { describe, expect, it } from "vitest";

import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { PRESETS as CORE_PRESETS } from "@packet-schema/presets";
import { adaptPreset } from "@/lib/psdl/preset-patches";
import type { Packet } from "@/lib/psdl/types";

const adapt = (key: string, p: (typeof CORE_PRESETS)[string]): Packet =>
  adaptPreset(key, p as unknown as Record<string, unknown>) as Packet;

describe("length controller vs switch discriminator", () => {
  it("a discriminator keeps its cell and the length slider stands down", () => {
    // `sel` is nominated as a length controller by the constraint (the
    // IHL / Data Offset idiom, `sel * 4 == hdrBytes`) AND is the discriminator
    // of the switch below it, so both stages target the same cell.
    const packet = {
      name: "Collide",
      rowBits: 8,
      constraints: [
        {
          lhs: {
            kind: "op",
            op: "*",
            a: { kind: "ref", field: "sel" },
            b: { kind: "lit", value: 4 },
          },
          rhs: { kind: "ref", field: "hdrBytes" },
        },
      ],
      body: [
        {
          id: "sel",
          name: "Sel",
          category: "length" as const,
          type: { kind: "int" as const, bits: 8 },
        },
        {
          id: "hdrBytes",
          name: "HdrBytes",
          type: { kind: "int" as const, bits: 8 },
        },
        {
          kind: "switch" as const,
          id: "body",
          on: { kind: "ref" as const, field: "sel" },
          cases: {
            "1": {
              id: "one",
              fields: [
                { id: "a", name: "A", type: { kind: "int" as const, bits: 8 } },
              ],
            },
            _: {
              id: "other",
              fields: [
                {
                  id: "b",
                  name: "B",
                  type: { kind: "int" as const, bits: 16 },
                },
              ],
            },
          },
        },
      ],
    } as unknown as Packet;

    const sel = psdlToRenderer(packet).fields.find((f) => f.id === "sel");
    expect(sel).toBeDefined();
    expect(sel?.switchCases).toBeDefined();
    expect(sel?.controlsLength).toBeUndefined();
  });

  it("no built-in preset carries both on one cell", () => {
    // Also pins that the rule above is a no-op for the shipped corpus, so a
    // future change that starts tripping it is a real signal rather than noise.
    // Top-level cells only: `controlsLength` is a Field property, and the
    // post-pass that enforces the rule walks the same list.
    const offenders: string[] = [];
    for (const [key, raw] of Object.entries(CORE_PRESETS)) {
      const rp = psdlToRenderer(adapt(key, raw));
      for (const f of rp.fields) {
        if (f.controlsLength && f.switchCases) offenders.push(`${key}:${f.id}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
