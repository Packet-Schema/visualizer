// PSML 0.4 — BER length type tests.
//
// Verifies:
//   * default width is 8 bits (short form);
//   * env override `__berLen__<fieldId>` is honoured;
//   * the layout adapter sizes the resulting cell from the env override;
//   * the validator accepts the new type kind.

import { describe, expect, it } from "vitest";
import { berLenEnvKey, typeBits } from "@/lib/psml/normalize";
import { resolveLayout } from "@/lib/psml/layout";
import { validatePsmlPacket } from "@/lib/psml/validate";
import type { Packet, PacketEnv, TypeBerLength } from "@/lib/psml/types";

const berT: TypeBerLength = { kind: "berLength" };

function mkPacket(): Packet {
  return {
    name: "WithBer",
    rowBits: 32,
    body: [{ id: "blen", name: "Length", type: berT }],
  };
}

describe("typeBits — berLength", () => {
  it("defaults to 8 bits when no env override is present", () => {
    expect(typeBits(berT, new Map(), "blen")).toBe(8);
  });

  it("defaults to 8 bits when no field id is supplied", () => {
    expect(typeBits(berT, new Map())).toBe(8);
  });

  it("returns the env override under `__berLen__<fieldId>`", () => {
    const env: PacketEnv = new Map([[berLenEnvKey("blen"), 24]]);
    expect(typeBits(berT, env, "blen")).toBe(24);
  });

  it("ignores an unrelated env key", () => {
    const env: PacketEnv = new Map([["blen", 999]]);
    // berLength reads from the namespaced key, not the bare field id.
    expect(typeBits(berT, env, "blen")).toBe(8);
  });
});

describe("resolveLayout — berLength", () => {
  it("produces a cell of default 8 bits", () => {
    const layout = resolveLayout(mkPacket());
    expect(layout.totalBits).toBe(8);
    expect(layout.cells.length).toBe(1);
    expect(layout.cells[0].bitsTotal).toBe(8);
  });

  it("uses the env-override width when present", () => {
    const env: PacketEnv = new Map([[berLenEnvKey("blen"), 16]]);
    const layout = resolveLayout(mkPacket(), { env });
    expect(layout.totalBits).toBe(16);
    expect(layout.cells[0].bitsTotal).toBe(16);
  });
});

describe("validatePsmlPacket — berLength", () => {
  it("accepts a berLength field", () => {
    expect(() => validatePsmlPacket(mkPacket())).not.toThrow();
  });
});
