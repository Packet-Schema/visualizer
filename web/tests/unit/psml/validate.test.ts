// Renderer-side packet validation tests — exercises the structural rules
// enforced by `validatePacket` against the renderer-shaped Packet model.
// PSML-side validation lives next door in `validate.test.ts` for the
// `validatePsmlPacket` walker.

import { describe, expect, it } from "vitest";
import { validatePacket } from "@/lib/psml/renderer-helpers";
import { validatePsmlPacket } from "@/lib/psml/validate";
import type { Packet } from "@/lib/psml/renderer";

function pkt(fields: Packet["fields"]): Packet {
  return { name: "Test", rowBits: 32, fields };
}

describe("validatePacket — structural rules", () => {
  it("accepts a clean packet", () => {
    const p = pkt([
      { id: "a", name: "A", bits: 8 },
      { id: "b", name: "B", bits: 8 },
    ]);
    expect(() => validatePacket(p)).not.toThrow();
  });

  it("throws when subfield bit-sum mismatches the parent width", () => {
    const p = pkt([
      {
        id: "flags",
        name: "Flags",
        bits: 8,
        subfields: [
          { id: "f1", name: "F1", bits: 4 },
          { id: "f2", name: "F2", bits: 3 }, // 7 != 8
        ],
      },
    ]);
    expect(() => validatePacket(p)).toThrow(/sum to 7 bits/);
  });

  it("throws when subfields appear on a variable-length field", () => {
    const p = pkt([
      {
        id: "var",
        name: "Var",
        variable: true,
        formula: "ihl_options",
        lengthFrom: "ihl",
        subfields: [{ id: "x", name: "X", bits: 1 }],
      },
    ]);
    expect(() => validatePacket(p)).toThrow(
      /variable-length and cannot have subfields/,
    );
  });

  it("throws when subfields and TLV catalog co-exist", () => {
    const p = pkt([
      {
        id: "opts",
        name: "Opts",
        bits: 8,
        subfields: [{ id: "x", name: "X", bits: 8 }],
        tlv: { catalog: [{ kind: 0, name: "EOL", bits: 8 }], instances: [] },
      },
    ]);
    expect(() => validatePacket(p)).toThrow(/cannot have both subfields/);
  });

  it("throws when a subfield has zero or non-integer bits", () => {
    const p = pkt([
      {
        id: "flags",
        name: "Flags",
        bits: 8,
        subfields: [
          { id: "z", name: "Z", bits: 8 },
          { id: "y", name: "Y", bits: 0 },
        ],
      },
    ]);
    expect(() => validatePacket(p)).toThrow(/positive integer bits/);
  });

  it("throws when a TLV catalog is empty", () => {
    const p = pkt([
      {
        id: "opts",
        name: "Opts",
        bits: 8,
        tlv: { catalog: [], instances: [] },
      },
    ]);
    expect(() => validatePacket(p)).toThrow(/empty catalog/);
  });

  it("throws when a subfield-bearing field has no bits at all", () => {
    const p = pkt([
      {
        id: "flags",
        name: "Flags",
        subfields: [{ id: "x", name: "X", bits: 8 }],
      },
    ]);
    expect(() => validatePacket(p)).toThrow();
  });
});

describe("validatePsmlPacket — reserved cell-id tokens (Codex P2)", () => {
  const base = (
    body: import("../../lib/psml/types").Container[],
  ): import("../../lib/psml/types").Packet => ({
    name: "T",
    rowBits: 32,
    body,
  });

  it("rejects a Field id with the reserved __inst_<N> suffix", () => {
    expect(() =>
      validatePsmlPacket(
        base([{ id: "opt__inst_0", name: "X", type: { kind: "bits", n: 8 } }]),
      ),
    ).toThrow(/__inst_/);
  });

  it("rejects a Field id containing the `:` separator", () => {
    expect(() =>
      validatePsmlPacket(
        base([{ id: "a:b", name: "X", type: { kind: "bits", n: 8 } }]),
      ),
    ).toThrow(/separator/);
  });

  it("rejects a Group id with a reserved token (Codex P2)", () => {
    expect(() =>
      validatePsmlPacket(
        base([
          {
            kind: "group",
            id: "grp__remaining",
            children: [{ id: "c", name: "C", type: { kind: "bits", n: 8 } }],
          },
        ]),
      ),
    ).toThrow(/__remaining/);
  });

  it("rejects a Repeat id with a reserved token (Codex P2)", () => {
    expect(() =>
      validatePsmlPacket(
        base([
          {
            kind: "repeat",
            id: "r__inst_3",
            element: {
              id: "rec",
              fields: [{ id: "c", name: "C", type: { kind: "bits", n: 8 } }],
            },
            count: { kind: "lit", value: 1 },
          },
        ]),
      ),
    ).toThrow(/__inst_/);
  });

  it("accepts clean container ids", () => {
    expect(() =>
      validatePsmlPacket(
        base([
          {
            kind: "group",
            id: "flags",
            children: [
              { id: "df", name: "DF", type: { kind: "bits", n: 1 } },
              { id: "mf", name: "MF", type: { kind: "bits", n: 1 } },
            ],
          },
        ]),
      ),
    ).not.toThrow();
  });

  it("rejects a Field id containing `#` (repeat-index tag separator)", () => {
    expect(() =>
      validatePsmlPacket(
        base([{ id: "foo#1", name: "X", type: { kind: "bits", n: 8 } }]),
      ),
    ).toThrow(/#/);
  });

  it("rejects a plain Field id ending in the reserved `_chain` suffix", () => {
    expect(() =>
      validatePsmlPacket(
        base([
          { id: "nextHeader_chain", name: "X", type: { kind: "bits", n: 8 } },
        ]),
      ),
    ).toThrow(/_chain/);
  });

  it("allows a Repeat id ending in `_chain` (only Fields are restricted)", () => {
    expect(() =>
      validatePsmlPacket(
        base([
          {
            kind: "repeat",
            id: "nh_chain",
            element: {
              id: "rec",
              fields: [{ id: "c", name: "C", type: { kind: "bits", n: 8 } }],
            },
            count: { kind: "lit", value: 1 },
          },
        ]),
      ),
    ).not.toThrow();
  });

  it("rejects duplicate sibling group ids (collapsed-cell boundary) (Codex P2)", () => {
    expect(() =>
      validatePsmlPacket(
        base([
          {
            kind: "group",
            id: "dup",
            children: [{ id: "a", name: "A", type: { kind: "bits", n: 8 } }],
          },
          {
            kind: "group",
            id: "dup",
            children: [{ id: "b", name: "B", type: { kind: "bits", n: 8 } }],
          },
        ]),
      ),
    ).toThrow(/duplicate sibling group id/);
  });

  it("allows same group id in non-sibling positions (different parents)", () => {
    expect(() =>
      validatePsmlPacket(
        base([
          {
            kind: "group",
            id: "outer1",
            children: [
              {
                kind: "group",
                id: "inner",
                children: [
                  { id: "a", name: "A", type: { kind: "bits", n: 8 } },
                ],
              },
            ],
          },
          {
            kind: "group",
            id: "outer2",
            children: [
              {
                kind: "group",
                id: "inner",
                children: [
                  { id: "b", name: "B", type: { kind: "bits", n: 8 } },
                ],
              },
            ],
          },
        ]),
      ),
    ).not.toThrow();
  });
});
