// override-design-audit (bar #1/#2): a `bytes {delimiter:[...]}` field expanded
// inside a Repeat (or `ref`) is read by core's emit() under the FULLY-QUALIFIED
// per-instance key `__bytesDelimLen__<prefix>.<id>#<n>`, NOT the bare
// `__bytesDelimLen__<id>` the visualizer's seed / WidthPicker write. Without
// qualifying the bare value onto every instance key the field renders as ZERO
// bytes on load (no cell at all) and the WidthPicker is completely inert —
// see-but-cannot-edit. varint / berLength escape this because core reads them
// via the BARE field.id in typeBits(); delimited bytes are the asymmetric case.

import { describe, it, expect } from "vitest";

import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { seedDynamicWidthDefaults } from "@/lib/psdl/dynamic-width-defaults";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

// repeat{count:ref(n), element:[ {id:label, bytes:{delimiter:[0]}} ]}
const REPEAT_PACKET: PsdlPacket = {
  name: "repeatProbe",
  rowBits: 32,
  body: [
    { id: "n", name: "n", type: { kind: "int", bits: 8 } },
    {
      kind: "repeat",
      id: "rep",
      count: { kind: "ref", field: "n" },
      element: {
        id: "repElement",
        fields: [
          {
            id: "label",
            name: "label",
            type: { kind: "bytes", n: { delimiter: [0] } },
          },
        ],
      },
    },
    { id: "tail", name: "tail", type: { kind: "int", bits: 8 } },
  ],
};

function cells(src: PsdlPacket, overrides: Record<string, number> = {}) {
  const env = new Map<string, number>(Object.entries(overrides));
  for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
  seedDynamicWidthDefaults(src, env);
  return resolveLayout(src, { env }).cells;
}

describe("delimiter-terminated bytes inside a repeat", () => {
  it("renders the nested delimited field on default load (seeded width)", () => {
    const ids = cells(REPEAT_PACKET, { n: 1 }).map((c) => c.field.id);
    // Previously the cells were just [n, tail#0] — `label#0` was invisible.
    expect(ids).toContain("label#0");
  });

  it("paints one delimited cell per repeat instance", () => {
    const ids = cells(REPEAT_PACKET, { n: 3 }).map((c) => c.field.id);
    expect(ids).toContain("label#0");
    expect(ids).toContain("label#1");
    expect(ids).toContain("label#2");
  });

  it("the WidthPicker key (env[label], bytes) drives every instance cell", () => {
    // The picker writes the bare authored id in BYTES; core needs that fanned
    // out onto every `__bytesDelimLen__label#<n>` qualified key. (A 16-byte field
    // segments across 32-bit rows into several cells, so assert on the per-field
    // `bitsTotal` rather than the cell count.)
    const out = cells(REPEAT_PACKET, { n: 2, label: 16 });
    const byId = new Map(
      out
        .filter((c) => c.field.id.startsWith("label#"))
        .map((c) => [c.field.id, c.bitsTotal]),
    );
    expect([...byId.keys()].sort()).toEqual(["label#0", "label#1"]);
    expect(byId.get("label#0")).toBe(16 * 8);
    expect(byId.get("label#1")).toBe(16 * 8);
  });

  it("an explicit per-instance width still wins over the bare value", () => {
    // env keyed by the qualified delim key is the user pinning one instance.
    const out = cells(REPEAT_PACKET, {
      n: 2,
      label: 4,
      ["__bytesDelimLen__label#1"]: 9,
    });
    const byId = new Map(
      out
        .filter((c) => c.field.id.startsWith("label#"))
        .map((c) => [c.field.id, c.field.bits]),
    );
    expect(byId.get("label#0")).toBe(4 * 8); // bare/seeded value
    expect(byId.get("label#1")).toBe(9 * 8); // explicit per-instance width
  });

  it("the nested delimited cell carries the isDelimited WidthPicker hint", () => {
    const labelCell = cells(REPEAT_PACKET, { n: 1, label: 8 }).find(
      (c) => c.field.id === "label#0",
    );
    expect(labelCell?.field.isDelimited).toBe(true);
  });
});

// repeat{count:ref(n), element:[ {id:rec, bytes:{delimiter:[0]}} ]} reached via
// a `ref` so the emitted id carries an idPrefix (`outer.rec#n`); the same
// qualified-key bridge must reach prefixed instances too.
const REF_PACKET: PsdlPacket = {
  name: "refProbe",
  rowBits: 32,
  defs: {
    inner: {
      id: "inner",
      fields: [
        {
          id: "rec",
          name: "rec",
          type: { kind: "bytes", n: { delimiter: [0] } },
        },
      ],
    },
  },
  body: [
    { id: "m", name: "m", type: { kind: "int", bits: 8 } },
    {
      kind: "repeat",
      id: "outer",
      count: { kind: "ref", field: "m" },
      element: {
        id: "outerElement",
        fields: [{ kind: "ref", id: "innerRef", ref: "inner" }],
      },
    },
  ],
};

describe("delimiter-terminated bytes inside a ref-expanded repeat", () => {
  it("renders the prefixed delimited instances and the width drives them", () => {
    const out = cells(REF_PACKET, { m: 2, rec: 4 });
    const byId = new Map(
      out
        .filter((c) => c.field.id.includes("rec"))
        .map((c) => [c.field.id, c.bitsTotal]),
    );
    // ref id prefixes the instance id: `innerRef.rec#0`, `innerRef.rec#1`.
    expect(byId.size).toBe(2);
    for (const bits of byId.values()) expect(bits).toBe(4 * 8);
  });
});
