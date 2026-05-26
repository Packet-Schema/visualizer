// PSML 0.3 — Varint type tests.
//
// Verifies:
//   * the schema validator accepts the three supported encodings and
//     rejects unknown ones;
//   * `typeBits` returns 0 for a varint with no env override, and returns
//     the override when the env supplies one keyed by the field id;
//   * QUIC's 2-bit length-prefix maps to 1/2/4/8 byte encoded forms with
//     the correct total bit width (8/16/32/64).

import { describe, expect, it } from "vitest";
import { typeBits } from "@/lib/psml/normalize";
import { validatePsmlPacket } from "@/lib/psml/validate";
import type { Packet, PacketEnv, TypeVarint } from "@/lib/psml/types";

function mkPacket(encoding: TypeVarint["encoding"] | string): Packet {
  return {
    name: "WithVarint",
    rowBits: 32,
    body: [
      {
        id: "vlen",
        name: "Length",
        type: { kind: "varint", encoding } as TypeVarint,
      },
    ],
  };
}

describe("validatePsmlPacket — Varint encoding", () => {
  it.each(["quic", "protobuf", "cbor"] as const)(
    "accepts encoding=%s",
    (enc) => {
      expect(() => validatePsmlPacket(mkPacket(enc))).not.toThrow();
    },
  );

  it("rejects an unknown encoding", () => {
    expect(() => validatePsmlPacket(mkPacket("leb128"))).toThrow(
      /varint encoding must be one of/,
    );
  });

  it("rejects a missing encoding", () => {
    const p: Packet = {
      name: "WithVarint",
      rowBits: 32,
      body: [
        {
          id: "vlen",
          name: "Length",
          type: { kind: "varint" } as unknown as TypeVarint,
        },
      ],
    };
    expect(() => validatePsmlPacket(p)).toThrow(/varint encoding/);
  });
});

describe("typeBits — Varint", () => {
  const t = { kind: "varint" as const, encoding: "quic" as const };

  it("returns 0 without an env override", () => {
    expect(typeBits(t, new Map())).toBe(0);
  });

  it("returns the env override keyed by the field id", () => {
    const env: PacketEnv = new Map([["vlen", 32]]);
    expect(typeBits(t, env, "vlen")).toBe(32);
  });

  it("returns 0 when no field id is supplied (anonymous lookup)", () => {
    const env: PacketEnv = new Map([["vlen", 32]]);
    expect(typeBits(t, env)).toBe(0);
  });
});

describe("QUIC varint — 2-bit prefix encoding", () => {
  // Per RFC 9000 §16: the top 2 bits of the first byte select 1/2/4/8 byte
  // encoded forms (total widths 8/16/32/64 bits). The bit-width function
  // mirrors that mapping, and we keep it close to where the runtime would
  // consult it (the env override) so the value range can be exercised end-
  // to-end without touching the renderer.
  function quicVarintBits(prefix2: number): number {
    switch (prefix2 & 0b11) {
      case 0b00:
        return 8;
      case 0b01:
        return 16;
      case 0b10:
        return 32;
      case 0b11:
        return 64;
      default:
        throw new Error("unreachable");
    }
  }

  it.each([
    [0b00, 8],
    [0b01, 16],
    [0b10, 32],
    [0b11, 64],
  ])("prefix 0b%i -> %i bits", (prefix, expected) => {
    expect(quicVarintBits(prefix)).toBe(expected);
  });

  it("typeBits picks up the encoded width from env", () => {
    const t = { kind: "varint" as const, encoding: "quic" as const };
    for (const prefix of [0b00, 0b01, 0b10, 0b11]) {
      const bits = quicVarintBits(prefix);
      const env: PacketEnv = new Map([["len", bits]]);
      expect(typeBits(t, env, "len")).toBe(bits);
    }
  });
});
