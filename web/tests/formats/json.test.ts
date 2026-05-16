// PSML JSON format — round-trip parity for every preset (with default and
// non-default controllers, with TLV instances, with chain instances), plus
// edge cases: empty packet, missing optionals, unknown extra keys, and the
// version/format-tag error paths.

import { describe, expect, it } from "vitest";
import { fromJson, toJson } from "../../lib/formats/json";
import { initialEnv } from "../../lib/psml/normalize";
import { GENERATED_PRESETS } from "../../lib/psml/presets.generated";
import { MANUAL_PRESETS } from "../../lib/psml/presets";
import type { Packet, PacketEnv } from "../../lib/psml/types";

const ALL_PRESETS: Record<string, Packet> = {
  ...MANUAL_PRESETS,
  ...GENERATED_PRESETS,
};

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
    const text = toJson(MANUAL_PRESETS.udp, new Map());
    const obj = JSON.parse(text);
    expect(obj.format).toBe("psml");
    expect(obj.version).toBe("0.2");
    expect(obj.name).toBe(MANUAL_PRESETS.udp.name);
    expect(obj.rowBits).toBe(32);
    expect(Array.isArray(obj.body)).toBe(true);
  });

  it("omits empty env entirely", () => {
    const obj = JSON.parse(toJson(MANUAL_PRESETS.udp));
    expect(obj.env).toBeUndefined();
  });

  it("preserves the env when populated", () => {
    const env: PacketEnv = new Map([["ihl", 7]]);
    const obj = JSON.parse(toJson(MANUAL_PRESETS.ipv4, env));
    expect(obj.env).toEqual({ ihl: 7 });
  });

  it("preserves byteOrder, description, and constraints when present", () => {
    const obj = JSON.parse(toJson(MANUAL_PRESETS.ipv4, new Map()));
    expect(obj.byteOrder).toBe("BE");
    expect(typeof obj.description).toBe("string");
    expect(Array.isArray(obj.constraints)).toBe(true);
    expect(obj.constraints.length).toBeGreaterThan(0);
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
    const text = toJson(MANUAL_PRESETS.ipv4, env);
    const round = fromJson(text);
    expect(round.env.get("ihl")).toBe(7);
    expect(round.env.get("headerBytes")).toBe(28);
  });

  it("non-default TCP dataOffset=10", () => {
    const env: PacketEnv = new Map([["dataOffset", 10]]);
    const text = toJson(MANUAL_PRESETS.tcp, env);
    expect(JSON.parse(text).env).toEqual({ dataOffset: 10 });
  });
});

describe("toJson / fromJson — TLV options populated", () => {
  it("IPv4 record route count=3 round-trips via env", () => {
    const env: PacketEnv = new Map([
      ["ipv4OptionsCount", 1],
      ["optType", 7],
    ]);
    const text = toJson(MANUAL_PRESETS.ipv4, env);
    const round = fromJson(text);
    expect(round.env.get("ipv4OptionsCount")).toBe(1);
    expect(round.env.get("optType")).toBe(7);
  });

  it("TCP MSS+SACK Permitted instances round-trip via env count", () => {
    const env: PacketEnv = new Map([
      ["tcpOptionsCount", 2],
      ["optKind", 2],
    ]);
    const text = toJson(MANUAL_PRESETS.tcp, env);
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
    const text = toJson(GENERATED_PRESETS.ipv6, env);
    const round = fromJson(text);
    expect(round.env.get("nextHeader_chainCount")).toBe(2);
    expect(round.env.get("nextHeader_proto")).toBe(0);
  });
});

describe("fromJson — edge cases", () => {
  it("handles a minimal empty packet (only name + rowBits)", () => {
    const text = JSON.stringify({
      format: "psml",
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
      format: "psml",
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
      format: "psml",
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
      format: "psml",
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

  it("throws on the wrong PSML version", () => {
    expect(() =>
      fromJson(JSON.stringify({ format: "psml", version: "0.1" })),
    ).toThrow(/Unsupported PSML version/);
  });

  it("requires a non-empty name", () => {
    expect(() =>
      fromJson(JSON.stringify({ format: "psml", version: "0.2", name: "" })),
    ).toThrow(/missing string `name`/);
    expect(() =>
      fromJson(JSON.stringify({ format: "psml", version: "0.2" })),
    ).toThrow(/missing string `name`/);
  });

  it("requires integer rowBits > 0", () => {
    expect(() =>
      fromJson(
        JSON.stringify({ format: "psml", version: "0.2", name: "x", rowBits: 0 }),
      ),
    ).toThrow(/rowBits/);
    expect(() =>
      fromJson(
        JSON.stringify({ format: "psml", version: "0.2", name: "x", rowBits: 1.5 }),
      ),
    ).toThrow(/rowBits/);
  });

  it("requires the body to be an array", () => {
    expect(() =>
      fromJson(
        JSON.stringify({
          format: "psml",
          version: "0.2",
          name: "x",
          rowBits: 8,
          body: "nope",
        }),
      ),
    ).toThrow(/missing array `body`/);
  });
});
