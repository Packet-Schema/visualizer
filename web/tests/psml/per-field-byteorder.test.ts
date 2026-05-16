// PSML 0.4 — per-field byteOrder tests.
//
// Verifies:
//   * Field.byteOrder propagates onto NormalizedField and the resolved Cell;
//   * fields without byteOrder produce no cell.byteOrder (renderer default);
//   * BE and LE can coexist on different fields within the same packet;
//   * validator rejects values other than 'BE' or 'LE'.

import { describe, expect, it } from "vitest";
import { normalize } from "../../lib/psml/normalize";
import { resolveLayout } from "../../lib/psml/layout";
import { validatePsmlPacket } from "../../lib/psml/validate";
import type { Field, Packet } from "../../lib/psml/types";

const bits = (n: number) => ({ kind: "bits" as const, n });

describe("per-field byteOrder", () => {
  it("LE on a Field propagates onto NormalizedField and Cell", () => {
    const p: Packet = {
      name: "LeField",
      rowBits: 32,
      body: [{ id: "le", name: "LE", type: bits(16), byteOrder: "LE" }],
    };
    const n = normalize(p);
    expect(n.fields[0].byteOrder).toBe("LE");
    const layout = resolveLayout(p);
    expect(layout.cells[0].byteOrder).toBe("LE");
  });

  it("absent byteOrder leaves NormalizedField.byteOrder and Cell.byteOrder undefined", () => {
    const p: Packet = {
      name: "DefField",
      rowBits: 32,
      body: [{ id: "f", name: "F", type: bits(16) }],
    };
    const n = normalize(p);
    expect(n.fields[0].byteOrder).toBeUndefined();
    const layout = resolveLayout(p);
    expect(layout.cells[0].byteOrder).toBeUndefined();
  });

  it("mixes BE and LE fields in the same packet", () => {
    const beField: Field = { id: "be", name: "BE", type: bits(16), byteOrder: "BE" };
    const leField: Field = { id: "le", name: "LE", type: bits(16), byteOrder: "LE" };
    const plainField: Field = { id: "x", name: "X", type: bits(16) };
    const p: Packet = {
      name: "Mixed",
      rowBits: 64,
      body: [beField, leField, plainField],
    };
    const n = normalize(p);
    expect(n.fields.map((f) => f.byteOrder)).toEqual(["BE", "LE", undefined]);
    const layout = resolveLayout(p);
    expect(layout.cells.map((c) => c.byteOrder)).toEqual(["BE", "LE", undefined]);
  });

  it("validator rejects an invalid byteOrder string", () => {
    const p: Packet = {
      name: "Bad",
      rowBits: 32,
      body: [
        {
          id: "f",
          name: "F",
          type: bits(16),
          byteOrder: "MIDDLE" as unknown as "BE",
        },
      ],
    };
    expect(() => validatePsmlPacket(p)).toThrow(/byteOrder must be 'BE' or 'LE'/);
  });
});
