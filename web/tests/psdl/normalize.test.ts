// PSDL normalize tests — Repeat (literal/expr/eos/until), Switch
// (case/default/missing key with no default), nested Group, Repeat-of-Struct-
// with-Repeat, plus default-value seeding and the byte-typed `bytes` Type.

import { describe, expect, it } from "vitest";
import { lit, op, ref } from "../../lib/psdl/expr";
import { initialEnv, normalize, typeBits } from "../../lib/psdl/normalize";
import type {
  Container,
  Group,
  Packet,
  PacketEnv,
  Struct,
  Switch,
} from "../../lib/psdl/types";

const bits = (n: number) => ({ kind: "bits" as const, n });
const int = (n: number) => ({ kind: "int" as const, bits: n });

function mk(name: string, body: Container[], rowBits = 32): Packet {
  return { name, rowBits, body };
}

describe("typeBits", () => {
  const env: PacketEnv = new Map([["len", 5]]);
  it("int / enum", () => {
    expect(typeBits(int(16), env)).toBe(16);
    expect(typeBits({ kind: "enum", bits: 8, variants: { 0: "x" } }, env)).toBe(
      8,
    );
  });
  it("bits", () => {
    expect(typeBits(bits(7), env)).toBe(7);
  });
  it("bytes uses ref expression × 8", () => {
    expect(typeBits({ kind: "bytes", n: ref("len") }, env)).toBe(40);
  });
});

describe("normalize — fields and groups", () => {
  it("emits a flat field list", () => {
    const p = mk("simple", [
      { id: "a", name: "A", type: bits(4) },
      { id: "b", name: "B", type: bits(12) },
      { id: "c", name: "C", type: int(16) },
    ]);
    const n = normalize(p);
    expect(n.totalBits).toBe(32);
    expect(n.fields.map((f) => f.id)).toEqual(["a", "b", "c"]);
    expect(n.fields[0].absoluteBitOffset).toBe(0);
    expect(n.fields[1].absoluteBitOffset).toBe(4);
    expect(n.fields[2].absoluteBitOffset).toBe(16);
  });

  it("descends into nested Groups (case 1)", () => {
    const p = mk("group", [
      {
        kind: "group",
        id: "outer",
        children: [
          { id: "x", name: "X", type: bits(4) },
          {
            kind: "group",
            id: "inner",
            children: [
              { id: "y", name: "Y", type: bits(4) },
              { id: "z", name: "Z", type: bits(8) },
            ],
          },
        ],
      },
    ]);
    const n = normalize(p);
    expect(n.totalBits).toBe(16);
    expect(n.fields.map((f) => f.id)).toEqual(["x", "y", "z"]);
    expect(n.fields[2].originalContainerPath).toBe("group/outer/inner");
  });

  it("seeds default values into the env (case 2 — defaults)", () => {
    const p = mk("defaults", [
      { id: "ihl", name: "IHL", type: bits(4), defaultValue: 5 },
      { id: "hdr", name: "Hdr", type: bits(28) },
    ]);
    const env = initialEnv(p);
    expect(env.get("ihl")).toBe(5);
    // does not stomp existing env entries
    const pre = new Map([["ihl", 9]]);
    expect(normalize(p, pre).fields[0].id).toBe("ihl");
  });
});

describe("normalize — Repeat", () => {
  const elem: Struct = {
    id: "row",
    fields: [
      { id: "kind", name: "Kind", type: bits(8) },
      { id: "len", name: "Len", type: bits(8) },
    ],
  };

  it("literal count (case 3)", () => {
    const p = mk("rep-lit", [
      { kind: "repeat", id: "rows", element: elem, count: lit(3) },
    ]);
    const n = normalize(p);
    expect(n.totalBits).toBe(48);
    // 3 copies × 2 fields each
    expect(n.fields.length).toBe(6);
    expect(n.fields.map((f) => f.repeatIndex)).toEqual([0, 0, 1, 1, 2, 2]);
    expect(n.fields[0].id).toBe("kind#0");
    expect(n.fields[2].id).toBe("kind#1");
  });

  it("expression count from env (case 4)", () => {
    const p = mk("rep-expr", [
      {
        kind: "repeat",
        id: "rows",
        element: elem,
        count: op("+", ref("n"), lit(1)),
      },
    ]);
    const env = new Map([["n", 2]]);
    const n = normalize(p, env);
    expect(n.fields.length).toBe(6); // (2+1) * 2 fields
  });

  it("eos count falls back to env override (case 5)", () => {
    const p = mk("rep-eos", [
      { kind: "repeat", id: "rows", element: elem, count: "eos" },
    ]);
    expect(normalize(p).fields.length).toBe(0);
    const env = new Map([["rows", 2]]);
    expect(normalize(p, env).fields.length).toBe(4);
  });

  it("until count falls back to env override (case 6)", () => {
    const p = mk("rep-until", [
      {
        kind: "repeat",
        id: "rows",
        element: elem,
        count: { until: ref("done") },
      },
    ]);
    expect(normalize(p).fields.length).toBe(0);
    const env = new Map([["rows", 4]]);
    expect(normalize(p, env).fields.length).toBe(8);
  });

  it("Repeat-of-Struct-with-Repeat — recursive expansion", () => {
    const inner: Struct = {
      id: "inner",
      fields: [
        {
          kind: "repeat",
          id: "leaves",
          element: {
            id: "leaf",
            fields: [{ id: "v", name: "V", type: bits(8) }],
          },
          count: lit(2),
        },
      ],
    };
    const p = mk("nested-rep", [
      { kind: "repeat", id: "outer", element: inner, count: lit(3) },
    ]);
    const n = normalize(p);
    // 3 outer × 2 inner × 1 byte = 48 bits
    expect(n.totalBits).toBe(48);
    expect(n.fields.length).toBe(6);
    expect(n.fields[0].originalContainerPath).toContain("outer");
  });

  it("negative or fractional counts truncate to zero / floor", () => {
    const p = mk("neg", [
      {
        kind: "repeat",
        id: "x",
        element: elem,
        count: op("-", lit(0), lit(1)),
      },
    ]);
    expect(normalize(p).fields.length).toBe(0);
  });

  it("propagates repeatIndex through a nested Switch", () => {
    // Regression: an earlier revision only suffixed direct Field children of
    // a Repeat with their repeatIndex; Switch / Group children dropped the
    // index, producing duplicate `id="type"` entries that crashed React's
    // key reconciliation downstream.
    const sw: Switch = {
      kind: "switch",
      id: "byKind",
      on: lit(0),
      cases: {
        "0": {
          id: "case-zero",
          fields: [{ id: "type", name: "Type", type: bits(8) }],
        },
      },
    };
    const p = mk("rep-switch", [
      {
        kind: "repeat",
        id: "options",
        element: { id: "el", fields: [sw] },
        count: lit(3),
      },
    ]);
    const n = normalize(p);
    expect(n.fields.length).toBe(3);
    expect(n.fields.map((f) => f.id)).toEqual(["type#0", "type#1", "type#2"]);
    expect(n.fields.map((f) => f.repeatIndex)).toEqual([0, 1, 2]);
  });

  it("propagates repeatIndex through a nested Group", () => {
    const g: Group = {
      kind: "group",
      id: "g",
      children: [{ id: "leaf", name: "Leaf", type: bits(8) }],
    };
    const p = mk("rep-group", [
      {
        kind: "repeat",
        id: "outer",
        element: { id: "el", fields: [g] },
        count: lit(2),
      },
    ]);
    const n = normalize(p);
    expect(n.fields.map((f) => f.id)).toEqual(["leaf#0", "leaf#1"]);
  });
});

describe("normalize — Switch", () => {
  const opt0: Struct = {
    id: "eol",
    fields: [{ id: "k", name: "K0", type: bits(8) }],
  };
  const opt1: Struct = {
    id: "nop",
    fields: [{ id: "k", name: "K1", type: bits(8) }],
  };
  const def: Struct = {
    id: "def",
    fields: [{ id: "k", name: "Default", type: bits(8) }],
  };

  it("explicit case match", () => {
    const p = mk("sw", [
      {
        kind: "switch",
        id: "byKind",
        on: ref("kind"),
        cases: { "0": opt0, "1": opt1 },
        default: def,
      },
    ]);
    const env = new Map([["kind", 1]]);
    const n = normalize(p, env);
    expect(n.fields.length).toBe(1);
    expect(n.fields[0].name).toBe("K1");
    expect(n.fields[0].switchCase).toBe("1");
  });

  it("falls through to default", () => {
    const p = mk("sw-def", [
      {
        kind: "switch",
        id: "byKind",
        on: ref("kind"),
        cases: { "0": opt0, "1": opt1 },
        default: def,
      },
    ]);
    const env = new Map([["kind", 99]]);
    expect(normalize(p, env).fields[0].name).toBe("Default");
  });

  it("emits nothing when neither case nor default matches", () => {
    const p = mk("sw-empty", [
      {
        kind: "switch",
        id: "byKind",
        on: ref("kind"),
        cases: { "0": opt0 },
      },
    ]);
    const env = new Map([["kind", 99]]);
    expect(normalize(p, env).fields.length).toBe(0);
  });

  it("recurses into non-field children of a chosen case", () => {
    const innerGroup: Struct = {
      id: "deep",
      fields: [
        {
          kind: "group",
          id: "g",
          children: [
            { id: "a", name: "A", type: bits(4) },
            { id: "b", name: "B", type: bits(4) },
          ],
        },
      ],
    };
    const p = mk("sw-deep", [
      {
        kind: "switch",
        id: "swd",
        on: lit(0),
        cases: { "0": innerGroup },
      },
    ]);
    const n = normalize(p);
    expect(n.fields.length).toBe(2);
    expect(n.fields.map((f) => f.id)).toEqual(["a", "b"]);
  });
});
