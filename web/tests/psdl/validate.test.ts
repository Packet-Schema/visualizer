// Renderer-side packet validation tests — exercises the structural rules
// enforced by `validatePacket` against the renderer-shaped Packet model.
// PSDL-side validation lives next door in `validate.test.ts` for the
// `validatePsdlPacket` walker.

import { describe, expect, it } from "vitest";
import { validatePacket } from "../../lib/psdl/renderer-helpers";
import { validatePsdlPacket } from "../../lib/psdl/validate";
import type { Packet } from "../../lib/psdl/renderer";
import type { Encrypted, Packet as PsdlPacket } from "../../lib/psdl/types";

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

describe("validatePsdlPacket — reserved cell-id tokens (Codex P2)", () => {
  const base = (
    body: import("../../lib/psdl/types").Container[],
  ): import("../../lib/psdl/types").Packet => ({
    name: "T",
    rowBits: 32,
    body,
  });

  it("rejects a Field id with the reserved __inst_<N> suffix", () => {
    expect(() =>
      validatePsdlPacket(
        base([{ id: "opt__inst_0", name: "X", type: { kind: "bits", n: 8 } }]),
      ),
    ).toThrow(/__inst_/);
  });

  it("rejects a Field id containing the `:` separator", () => {
    expect(() =>
      validatePsdlPacket(
        base([{ id: "a:b", name: "X", type: { kind: "bits", n: 8 } }]),
      ),
    ).toThrow(/separator/);
  });

  it("rejects a Group id with a reserved token (Codex P2)", () => {
    expect(() =>
      validatePsdlPacket(
        base([
          {
            kind: "group",
            id: "grp__remaining",
            name: "grp__remaining",
            children: [{ id: "c", name: "C", type: { kind: "bits", n: 8 } }],
          },
        ]),
      ),
    ).toThrow(/__remaining/);
  });

  it("rejects a Repeat id with a reserved token (Codex P2)", () => {
    expect(() =>
      validatePsdlPacket(
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
      validatePsdlPacket(
        base([
          {
            kind: "group",
            id: "flags",
            name: "flags",
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
      validatePsdlPacket(
        base([{ id: "foo#1", name: "X", type: { kind: "bits", n: 8 } }]),
      ),
    ).toThrow(/#/);
  });

  it("rejects a plain Field id ending in the reserved `_chain` suffix", () => {
    expect(() =>
      validatePsdlPacket(
        base([
          { id: "nextHeader_chain", name: "X", type: { kind: "bits", n: 8 } },
        ]),
      ),
    ).toThrow(/_chain/);
  });

  it("allows a Repeat id ending in `_chain` (only Fields are restricted)", () => {
    expect(() =>
      validatePsdlPacket(
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
      validatePsdlPacket(
        base([
          {
            kind: "group",
            id: "dup",
            name: "dup",
            children: [{ id: "a", name: "A", type: { kind: "bits", n: 8 } }],
          },
          {
            kind: "group",
            id: "dup",
            name: "dup",
            children: [{ id: "b", name: "B", type: { kind: "bits", n: 8 } }],
          },
        ]),
      ),
    ).toThrow(/duplicate sibling group id/);
  });

  it("allows same group id in non-sibling positions (different parents)", () => {
    expect(() =>
      validatePsdlPacket(
        base([
          {
            kind: "group",
            id: "outer1",
            name: "outer1",
            children: [
              {
                kind: "group",
                id: "inner",
                name: "inner",
                children: [
                  { id: "a", name: "A", type: { kind: "bits", n: 8 } },
                ],
              },
            ],
          },
          {
            kind: "group",
            id: "outer2",
            name: "outer2",
            children: [
              {
                kind: "group",
                id: "inner",
                name: "inner",
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

describe("validatePsdlPacket — Encrypted headerProtected ref collection (Codex P2)", () => {
  // Regression: `collectIdsFromContainer` must descend `bounded` so a
  // `headerProtected` ref can resolve a field that lives behind a PSDL 0.5
  // wire-scope inside the plaintext. Before the fix this threw a false
  // "does not name a field inside plaintext" error.
  it("resolves headerProtected ids for fields nested inside a bounded", () => {
    const enc: Encrypted = {
      kind: "encrypted",
      id: "enc",
      name: "Protected Payload",
      contextNote: "TLS 1.3 handshake keys",
      headerProtected: ["pn", "leaf"],
      plaintext: {
        id: "qpkt",
        fields: [
          { id: "pn", name: "Packet Number", type: { kind: "bits", n: 32 } },
          {
            kind: "bounded",
            id: "scope",
            name: "Scope",
            bytes: { kind: "lit", value: 16 },
            fields: [
              { id: "leaf", name: "Leaf", type: { kind: "bits", n: 8 } },
            ],
          },
        ],
      },
    };
    const packet: PsdlPacket = { name: "QuicShort", rowBits: 32, body: [enc] };
    expect(() => validatePsdlPacket(packet)).not.toThrow();
  });
});

describe("validatePsdlPacket — align boundary (Codex P2)", () => {
  const withAlign = (to: number): PsdlPacket => ({
    name: "Aligned",
    rowBits: 32,
    body: [
      { id: "a", name: "A", type: { kind: "int", bits: 8 } },
      {
        kind: "align",
        id: "pad",
        to,
      } as import("../../lib/psdl/types").Container,
    ],
  });

  it("accepts a power-of-two multiple of 8 (32)", () => {
    expect(() => validatePsdlPacket(withAlign(32))).not.toThrow();
  });

  it("rejects a non-multiple-of-8 boundary (7)", () => {
    expect(() => validatePsdlPacket(withAlign(7))).toThrow(
      /align 'to' must be a positive power-of-two multiple of 8/,
    );
  });

  it("rejects a multiple-of-8 that is not a power of two (24)", () => {
    expect(() => validatePsdlPacket(withAlign(24))).toThrow(
      /power-of-two multiple of 8/,
    );
  });
});
