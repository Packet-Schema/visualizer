// PSML packet validation tests — checks structural invariants enforced by
// `validatePacket` and the variable-field formula resolution in
// `attachToBits`.

import { describe, expect, it } from "vitest";
import {
  attachToBits,
  validatePacket,
} from "../../lib/psml/runtime-resolver";
import type { Packet } from "../../lib/psml/runtime-types";

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
    expect(() => validatePacket(p)).toThrow(/variable-length and cannot have subfields/);
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
        subfields: [{ id: "z", name: "Z", bits: 8 }, { id: "y", name: "Y", bits: 0 }],
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

describe("attachToBits — variable formula resolution", () => {
  it("attaches a known formula", () => {
    const p = pkt([
      {
        id: "options",
        name: "Options",
        variable: true,
        lengthFrom: "ihl",
        formula: "ihl_options",
      },
    ]);
    attachToBits(p);
    expect(typeof p.fields[0].toBits).toBe("function");
    expect(p.fields[0].toBits!(7)).toBe(64);
    expect(p.fields[0].toBits!(5)).toBe(0);
  });

  it("throws on a missing formula token", () => {
    const p = pkt([
      {
        id: "options",
        name: "Options",
        variable: true,
        lengthFrom: "ihl",
      },
    ]);
    expect(() => attachToBits(p)).toThrow(/has no formula/);
  });

  it("throws on an unknown formula", () => {
    const p = pkt([
      {
        id: "options",
        name: "Options",
        variable: true,
        lengthFrom: "ihl",
        formula: "no_such_formula",
      },
    ]);
    expect(() => attachToBits(p)).toThrow(/unknown variable-length formula/);
  });
});
