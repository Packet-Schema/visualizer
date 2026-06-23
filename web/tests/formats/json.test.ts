// PSDL JSON format — round-trip parity for every preset (with default and
// non-default controllers, with TLV instances, with chain instances), plus
// edge cases: empty packet, missing optionals, unknown extra keys, and the
// version/format-tag error paths.

import { describe, expect, it } from "vitest";
import { fromJson, toJson } from "../../lib/formats/json";
import { initialEnv } from "../../lib/psdl/normalize";
import { PRESETS as ALL_PRESETS } from "../../lib/psdl/presets.server";
import type { Packet, PacketEnv } from "../../lib/psdl/types";

describe("toJson / fromJson — every preset round-trips", () => {
  for (const [key, pkt] of Object.entries(ALL_PRESETS)) {
    it(`${key}: byte-identical canonical text after one round-trip`, () => {
      const env = initialEnv(pkt);
      const text1 = toJson(pkt, env);
      const { packet: re, env: reEnv } = fromJson(text1);
      const text2 = toJson(re, reEnv);
      expect(text2).toBe(text1);
    });
  }
});

describe("toJson — preset shape", () => {
  it("emits format/version tags", () => {
    const text = toJson(ALL_PRESETS.udp, new Map());
    const obj = JSON.parse(text);
    expect(obj.format).toBe("psdl");
    expect(obj.version).toBe("0.2");
    expect(obj.name).toBe(ALL_PRESETS.udp.name);
    expect(obj.rowBits).toBe(32);
    expect(Array.isArray(obj.body)).toBe(true);
  });

  it("omits empty env entirely", () => {
    const obj = JSON.parse(toJson(ALL_PRESETS.udp));
    expect(obj.env).toBeUndefined();
  });

  it("preserves the env when populated", () => {
    const env: PacketEnv = new Map([["ihl", 7]]);
    const obj = JSON.parse(toJson(ALL_PRESETS.ipv4, env));
    expect(obj.env).toEqual({ ihl: 7 });
  });

  it("preserves byteOrder and description when present", () => {
    // The 0.5 ipv4 preset keeps top-level byteOrder + description, but no
    // longer carries top-level `constraints`: the old "IHL*4 == headerBytes"
    // length relation moved onto the `optionsArea` Bounded scope's `bytes`
    // expression. Constraint serialization is covered separately below.
    const obj = JSON.parse(toJson(ALL_PRESETS.ipv4, new Map()));
    expect(obj.byteOrder).toBe("BE");
    expect(typeof obj.description).toBe("string");
  });

  it("preserves top-level constraints when present", () => {
    // Round-trip a packet that genuinely carries top-level constraints — the
    // 0.5 presets no longer do, so build one explicitly to keep this coverage
    // load-bearing.
    const pkt: Packet = {
      name: "Constrained",
      rowBits: 8,
      body: [{ id: "a", name: "A", type: { kind: "bits", n: 8 } }],
      constraints: [
        {
          lhs: { kind: "ref", field: "a" },
          rhs: { kind: "lit", value: 1 },
        },
      ],
    };
    const text = toJson(pkt, new Map());
    const obj = JSON.parse(text);
    expect(Array.isArray(obj.constraints)).toBe(true);
    expect(obj.constraints.length).toBeGreaterThan(0);
    // Parse it back so the `Array.isArray(r.constraints)` *true* branch in
    // fromJson is exercised (the 0.5 presets carry no top-level constraints).
    const { packet: re } = fromJson(text);
    expect(re.constraints).toEqual(pkt.constraints);
  });

  it("omits constraints when the array is empty", () => {
    const pkt: Packet = {
      name: "Empty",
      rowBits: 8,
      body: [{ id: "a", name: "A", type: { kind: "bits", n: 8 } }],
      constraints: [],
    };
    const obj = JSON.parse(toJson(pkt));
    expect(obj.constraints).toBeUndefined();
  });
});

describe("toJson / fromJson — IHL=7 controller value", () => {
  it("non-default IHL flows back through", () => {
    const env: PacketEnv = new Map([
      ["ihl", 7],
      ["headerBytes", 28],
    ]);
    const text = toJson(ALL_PRESETS.ipv4, env);
    const round = fromJson(text);
    expect(round.env.get("ihl")).toBe(7);
    expect(round.env.get("headerBytes")).toBe(28);
  });

  it("non-default TCP dataOffset=10", () => {
    const env: PacketEnv = new Map([["dataOffset", 10]]);
    const text = toJson(ALL_PRESETS.tcp, env);
    expect(JSON.parse(text).env).toEqual({ dataOffset: 10 });
  });
});

describe("toJson / fromJson — TLV options populated", () => {
  it("IPv4 record route count=3 round-trips via env", () => {
    const env: PacketEnv = new Map([
      ["ipv4OptionsCount", 1],
      ["optType", 7],
    ]);
    const text = toJson(ALL_PRESETS.ipv4, env);
    const round = fromJson(text);
    expect(round.env.get("ipv4OptionsCount")).toBe(1);
    expect(round.env.get("optType")).toBe(7);
  });

  it("TCP MSS+SACK Permitted instances round-trip via env count", () => {
    const env: PacketEnv = new Map([
      ["tcpOptionsCount", 2],
      ["optKind", 2],
    ]);
    const text = toJson(ALL_PRESETS.tcp, env);
    const round = fromJson(text);
    expect(round.env.get("tcpOptionsCount")).toBe(2);
  });
});

describe("toJson / fromJson — chain (IPv6 extension headers)", () => {
  it("IPv6 with Hop-by-Hop + Fragment env survives", () => {
    const env: PacketEnv = new Map([
      ["nextHeader_chainCount", 2],
      ["nextHeader_proto", 0],
    ]);
    const text = toJson(ALL_PRESETS.ipv6, env);
    const round = fromJson(text);
    expect(round.env.get("nextHeader_chainCount")).toBe(2);
    expect(round.env.get("nextHeader_proto")).toBe(0);
  });
});

describe("fromJson — edge cases", () => {
  it("handles a minimal empty packet (only name + rowBits)", () => {
    const text = JSON.stringify({
      format: "psdl",
      version: "0.2",
      name: "Empty",
      rowBits: 8,
      body: [],
    });
    const { packet, env } = fromJson(text);
    expect(packet.name).toBe("Empty");
    expect(packet.body).toEqual([]);
    expect(env.size).toBe(0);
  });

  it("treats missing optional fields as absent", () => {
    const text = JSON.stringify({
      format: "psdl",
      version: "0.2",
      name: "x",
      rowBits: 8,
      body: [{ id: "a", name: "A", type: { kind: "bits", n: 8 } }],
    });
    const { packet } = fromJson(text);
    expect(packet.byteOrder).toBeUndefined();
    expect(packet.description).toBeUndefined();
    expect(packet.constraints).toBeUndefined();
  });

  it("ignores unknown extra keys at the root", () => {
    const text = JSON.stringify({
      format: "psdl",
      version: "0.2",
      name: "x",
      rowBits: 8,
      body: [],
      randomExtra: 12345,
      anotherKey: { foo: "bar" },
    });
    expect(() => fromJson(text)).not.toThrow();
  });

  it("filters non-finite numbers out of env on import", () => {
    const text = JSON.stringify({
      format: "psdl",
      version: "0.2",
      name: "x",
      rowBits: 8,
      body: [],
      env: { good: 7, bogus: "string", inf: Infinity },
    });
    const { env } = fromJson(text);
    expect(env.get("good")).toBe(7);
    expect(env.has("bogus")).toBe(false);
    expect(env.has("inf")).toBe(false);
  });
});

describe("toJson / fromJson — PSDL 0.3 Varint Type", () => {
  it("round-trips a varint-typed field with all three encodings", () => {
    for (const encoding of ["quic", "protobuf", "cbor"] as const) {
      const pkt: Packet = {
        name: "VarintPkt",
        rowBits: 32,
        body: [
          { id: "len", name: "Length", type: { kind: "varint", encoding } },
        ],
      };
      const text = toJson(pkt);
      const { packet: re } = fromJson(text);
      // Pass-through preserves the type exactly.
      const f = re.body[0] as { type: { kind: string; encoding: string } };
      expect(f.type.kind).toBe("varint");
      expect(f.type.encoding).toBe(encoding);
    }
  });
});

describe("toJson / fromJson — PSDL 0.3 Encrypted Container", () => {
  it("round-trips an encrypted container with plaintext Struct, wireBits, headerProtected, contextNote", () => {
    const pkt: Packet = {
      name: "QuicShort",
      rowBits: 32,
      body: [
        {
          kind: "encrypted",
          id: "payload",
          name: "Protected Payload",
          plaintext: {
            id: "plain",
            fields: [
              {
                id: "pn",
                name: "Packet Number",
                type: { kind: "bits", n: 32 },
              },
              {
                id: "frame_type",
                name: "Frame Type",
                type: { kind: "bits", n: 8 },
              },
            ],
          },
          wireBits: { kind: "lit", value: 128 },
          contextNote: "TLS 1.3 handshake keys",
          headerProtected: ["pn"],
        },
      ],
    };
    const text = toJson(pkt);
    const { packet: re } = fromJson(text);
    const enc = re.body[0] as Record<string, unknown> & {
      plaintext: { fields: Array<{ id: string }> };
    };
    expect(enc.kind).toBe("encrypted");
    expect(enc.id).toBe("payload");
    expect(enc.name).toBe("Protected Payload");
    expect(enc.contextNote).toBe("TLS 1.3 handshake keys");
    expect(enc.headerProtected).toEqual(["pn"]);
    expect(enc.wireBits).toEqual({ kind: "lit", value: 128 });
    expect(enc.plaintext.fields.map((f) => f.id)).toEqual(["pn", "frame_type"]);
  });

  it("round-trips an encrypted container without optional wireBits/headerProtected", () => {
    const pkt: Packet = {
      name: "MinimalEnc",
      rowBits: 32,
      body: [
        {
          kind: "encrypted",
          id: "blob",
          plaintext: {
            id: "p",
            fields: [{ id: "x", name: "X", type: { kind: "bits", n: 8 } }],
          },
          contextNote: "external key",
        },
      ],
    };
    const text1 = toJson(pkt);
    const { packet: re } = fromJson(text1);
    const text2 = toJson(re);
    expect(text2).toBe(text1);
  });

  it("nested Encrypted (inside a Group) round-trips its full tree", () => {
    const pkt: Packet = {
      name: "Nested",
      rowBits: 32,
      body: [
        {
          kind: "group",
          id: "outer",
          name: "outer",
          children: [
            { id: "hdr", name: "Header", type: { kind: "bits", n: 8 } },
            {
              kind: "encrypted",
              id: "body",
              plaintext: {
                id: "p",
                fields: [
                  {
                    id: "secret",
                    name: "Secret",
                    type: { kind: "bits", n: 64 },
                  },
                ],
              },
              contextNote: "session key",
            },
          ],
        },
      ],
    };
    const text1 = toJson(pkt);
    const text2 = toJson(fromJson(text1).packet);
    expect(text2).toBe(text1);
  });
});

describe("fromJson — error paths", () => {
  it("throws on invalid JSON", () => {
    expect(() => fromJson("{not-json")).toThrow(/Invalid JSON/);
  });

  it("throws when the root is not an object", () => {
    expect(() => fromJson("[1,2,3]")).toThrow(/must be an object/);
    expect(() => fromJson("null")).toThrow(/must be an object/);
  });

  it("throws on the wrong format tag", () => {
    expect(() => fromJson(JSON.stringify({ format: "other" }))).toThrow(
      /Unknown format tag/,
    );
    expect(() => fromJson(JSON.stringify({}))).toThrow(/Unknown format tag/);
  });

  it("throws on the wrong PSDL version", () => {
    expect(() =>
      fromJson(JSON.stringify({ format: "psdl", version: "0.1" })),
    ).toThrow(/Unsupported PSDL version/);
  });

  it("requires a non-empty name", () => {
    expect(() =>
      fromJson(JSON.stringify({ format: "psdl", version: "0.2", name: "" })),
    ).toThrow(/missing string `name`/);
    expect(() =>
      fromJson(JSON.stringify({ format: "psdl", version: "0.2" })),
    ).toThrow(/missing string `name`/);
  });

  it("requires integer rowBits > 0", () => {
    expect(() =>
      fromJson(
        JSON.stringify({
          format: "psdl",
          version: "0.2",
          name: "x",
          rowBits: 0,
        }),
      ),
    ).toThrow(/rowBits/);
    expect(() =>
      fromJson(
        JSON.stringify({
          format: "psdl",
          version: "0.2",
          name: "x",
          rowBits: 1.5,
        }),
      ),
    ).toThrow(/rowBits/);
  });

  it("requires the body to be an array", () => {
    expect(() =>
      fromJson(
        JSON.stringify({
          format: "psdl",
          version: "0.2",
          name: "x",
          rowBits: 8,
          body: "nope",
        }),
      ),
    ).toThrow(/missing array `body`/);
  });
});

// PSDL 0.4 — round-trip the four new primitives through the JSON serializer.
// Each test builds a minimal packet that contains exactly one primitive and
// asserts byte-identical canonical text after one round-trip.
describe("toJson / fromJson — PSDL 0.4 primitives round-trip", () => {
  it("Optional container", () => {
    const pkt: Packet = {
      name: "Opt",
      rowBits: 8,
      body: [
        {
          kind: "optional",
          id: "maybeFlag",
          when: { kind: "ref", field: "present" },
          container: { id: "flag", name: "Flag", type: { kind: "bits", n: 8 } },
        },
      ],
    };
    const env: PacketEnv = new Map([["present", 1]]);
    const text1 = toJson(pkt, env);
    const round = fromJson(text1);
    expect(toJson(round.packet, round.env)).toBe(text1);
    // Optional structure survives unchanged.
    const obj = JSON.parse(text1);
    expect(obj.body[0]).toMatchObject({
      kind: "optional",
      when: { kind: "ref", field: "present" },
    });
  });

  it("berLength Type", () => {
    const pkt: Packet = {
      name: "Ber",
      rowBits: 8,
      body: [
        {
          id: "len",
          name: "BER",
          type: { kind: "berLength" },
          category: "length",
        },
      ],
    };
    const text1 = toJson(pkt);
    expect(toJson(fromJson(text1).packet, fromJson(text1).env)).toBe(text1);
    expect(JSON.parse(text1).body[0].type).toEqual({ kind: "berLength" });
  });

  it("peek Expr (as a Switch discriminator)", () => {
    const pkt: Packet = {
      name: "Peek",
      rowBits: 16,
      body: [
        {
          kind: "switch",
          id: "byPeek",
          on: { kind: "peek", bits: 16 },
          cases: {
            "1": {
              id: "one",
              fields: [{ id: "a", name: "A", type: { kind: "bits", n: 16 } }],
            },
          },
        },
      ],
    };
    const text1 = toJson(pkt);
    expect(toJson(fromJson(text1).packet, fromJson(text1).env)).toBe(text1);
    const obj = JSON.parse(text1);
    expect(obj.body[0].on).toEqual({ kind: "peek", bits: 16 });
  });

  it("per-field byteOrder", () => {
    const pkt: Packet = {
      name: "BO",
      rowBits: 16,
      body: [
        {
          id: "a",
          name: "A",
          type: { kind: "int", bits: 16 },
          byteOrder: "LE",
        },
      ],
    };
    const text1 = toJson(pkt);
    expect(toJson(fromJson(text1).packet, fromJson(text1).env)).toBe(text1);
    expect(JSON.parse(text1).body[0].byteOrder).toBe("LE");
  });
});

describe("toJson / fromJson — PSDL 0.4 demo presets round-trip", () => {
  for (const key of [
    "http2FrameHeader",
    "tlsExtensionsBlock",
    "pcieTlpFragment",
  ]) {
    it(`${key}: byte-identical after one round-trip`, () => {
      const pkt = ALL_PRESETS[key];
      const env = initialEnv(pkt);
      const t1 = toJson(pkt, env);
      const round = fromJson(t1);
      expect(toJson(round.packet, round.env)).toBe(t1);
    });
  }
});
