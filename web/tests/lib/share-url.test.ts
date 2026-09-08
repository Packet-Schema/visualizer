import { describe, expect, it } from "vitest";

import {
  buildShareUrl,
  buildShareQueryFromParams,
  decodePsdlParam,
  encodePsdlParam,
  findPresetKeyForPacket,
  isShareQueryLengthValid,
  normalizeShareQuery,
  parseShareParams,
} from "@/lib/share-url";
import { PRESETS } from "@/lib/psdl/presets.server";
import type { Packet } from "@/lib/psdl/types";

const BUILT_INS = Object.keys(PRESETS);

function packet(name = "Shared"): Packet {
  return {
    name,
    rowBits: 8,
    body: [{ id: "x", name: "X", type: { kind: "bits", n: 8 } }],
  };
}

describe("share URL params", () => {
  it("parses a built-in preset and controller query", () => {
    const parsed = parseShareParams(
      "?preset=ipv4&controllers.ihl=10&controllers.bad=NaN",
      BUILT_INS,
    );
    expect(parsed).toEqual({
      kind: "preset",
      presetKey: "ipv4",
      controllers: { ihl: 10 },
    });
  });

  it("omits default controller values when building a built-in URL", () => {
    const url = buildShareUrl({
      baseUrl: "https://example.test/view?preset=tcp&stale=1",
      packetKey: "tcp",
      packet: PRESETS.tcp,
      controllers: { dataOffset: 5 },
      defaultControllers: { dataOffset: 5 },
      builtInKeys: BUILT_INS,
    });
    expect(url).toBe("https://example.test/view?preset=tcp");
  });

  it("round-trips custom PSDL through an encoded payload", () => {
    const encoded = encodePsdlParam(packet("Custom Packet"), {
      customLen: 12,
    });
    expect(encoded).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");

    const decoded = decodePsdlParam(encoded);
    expect(decoded.packet.name).toBe("Custom Packet");
    expect(decoded.controllers).toEqual({ customLen: 12 });
  });

  it("returns error when psdl is invalid and no preset is present", () => {
    const result = parseShareParams("?psdl=not-valid", BUILT_INS);
    if (result.kind !== "none") throw new Error("expected kind=none");
    expect(result.error).toMatch(/Invalid shared link/);
  });

  it("falls back to preset when psdl is invalid", () => {
    const result = parseShareParams("?psdl=not-valid&preset=ipv4", BUILT_INS);
    expect(result.kind).toBe("preset");
    if (result.kind !== "preset") throw new Error("expected kind=preset");
    expect(result.presetKey).toBe("ipv4");
  });

  it("uses first valid psdl when multiple are present", () => {
    const encoded = encodePsdlParam({
      name: "T",
      rowBits: 8,
      body: [{ id: "x", name: "X", type: { kind: "bits", n: 8 } }],
    });
    const result = parseShareParams(
      `?psdl=not-valid&psdl=${encoded}`,
      BUILT_INS,
    );
    expect(result.kind).toBe("psdl");
  });

  it("uses first valid preset when multiple are present", () => {
    const result = parseShareParams("?preset=nope&preset=ipv4", BUILT_INS);
    expect(result.kind).toBe("preset");
    if (result.kind !== "preset") throw new Error("expected kind=preset");
    expect(result.presetKey).toBe("ipv4");
  });

  it("returns error for unknown preset value", () => {
    const unknownPreset = parseShareParams("?preset=nope", BUILT_INS);
    if (unknownPreset.kind !== "none") throw new Error("expected kind=none");
    expect(unknownPreset.error).toMatch(/Unknown preset/);
  });

  it("builds share query from URLSearchParams", () => {
    const params = new URLSearchParams();
    params.set("preset", "ipv4");
    params.set("controllers.ihl", "5");
    params.set("controllers.dscp", "10");
    params.set("other", "ignored");

    const query = buildShareQueryFromParams(params);
    expect(query).toContain("preset=ipv4");
    expect(query).toContain("controllers.ihl=5");
    expect(query).toContain("controllers.dscp=10");
    expect(query).not.toContain("other");
  });

  it("builds share query from plain object params", () => {
    const params = {
      preset: "tcp",
      "controllers.dataOffset": "5",
      psdl: undefined,
      other: "ignored",
    };

    const query = buildShareQueryFromParams(params);
    expect(query).toContain("preset=tcp");
    expect(query).toContain("controllers.dataOffset=5");
    expect(query).not.toContain("other");
    expect(query).not.toContain("psdl");
  });

  it("handles array values in share query params", () => {
    const params = {
      "controllers.flag": ["true", "false"],
    };

    const query = buildShareQueryFromParams(params);
    expect(query).toContain("controllers.flag=true");
    expect(query).toContain("controllers.flag=false");
  });

  it("validates share query length", () => {
    const shortQuery = "preset=ipv4";
    expect(isShareQueryLengthValid(shortQuery)).toBe(true);

    const longQuery = "preset=" + "x".repeat(200_000);
    expect(isShareQueryLengthValid(longQuery)).toBe(false);
  });
});

// normalizeShareQuery はサーバー側（page.tsx）で 302 リダイレクトの要否判定に使う。
// 空クエリ（`/` だけのアクセス）は page.tsx 側で呼び出しをスキップするため、
// リダイレクトは発生しない。クライアント側での `/` → `?preset=ipv4` の書き換えは
// PacketViewer の useEffect が担う。
describe("normalizeShareQuery", () => {
  it("空クエリはそのまま空文字を返す（/ だけのアクセスはリダイレクト対象外）", () => {
    expect(normalizeShareQuery("")).toBe("");
    expect(normalizeShareQuery("?")).toBe("");
  });

  it("不明なパラメーターを除去する", () => {
    const q = normalizeShareQuery("?preset=ipv4&foo=bar&baz=1");
    expect(new URLSearchParams(q).get("preset")).toBe("ipv4");
    expect(new URLSearchParams(q).has("foo")).toBe(false);
    expect(new URLSearchParams(q).has("baz")).toBe(false);
  });

  it("不正な psdl を除去する", () => {
    const q = normalizeShareQuery("?psdl=THIS_IS_GARBAGE");
    expect(new URLSearchParams(q).has("psdl")).toBe(false);
  });

  it("psdl が不正なとき preset を残す", () => {
    const q = normalizeShareQuery("?preset=ipv4&psdl=THIS_IS_GARBAGE");
    const params = new URLSearchParams(q);
    expect(params.has("psdl")).toBe(false);
    expect(params.get("preset")).toBe("ipv4");
  });

  it("有効な psdl があるとき preset を除去する", () => {
    const encoded = encodePsdlParam({
      name: "T",
      rowBits: 8,
      body: [{ id: "x", name: "X", type: { kind: "bits", n: 8 } }],
    });
    const q = normalizeShareQuery(`?preset=ipv4&psdl=${encoded}`);
    expect(new URLSearchParams(q).has("preset")).toBe(false);
    expect(new URLSearchParams(q).has("psdl")).toBe(true);
  });

  it("重複した preset は最初の1つだけ残す", () => {
    const q = normalizeShareQuery("?preset=ipv4&preset=tcp");
    const params = new URLSearchParams(q);
    expect(params.getAll("preset")).toEqual(["ipv4"]);
  });

  it("重複した controller キーは最初の1つだけ残す", () => {
    const q = normalizeShareQuery(
      "?preset=ipv4&controllers.ihl=5&controllers.ihl=10",
    );
    const params = new URLSearchParams(q);
    expect(params.getAll("controllers.ihl")).toEqual(["5"]);
  });

  it("有効な controller パラメーターはそのまま保持する", () => {
    const q = normalizeShareQuery("?preset=tcp&controllers.dataOffset=7");
    const params = new URLSearchParams(q);
    expect(params.get("preset")).toBe("tcp");
    expect(params.get("controllers.dataOffset")).toBe("7");
  });
});

describe("findPresetKeyForPacket", () => {
  // Packet-level fields whose wire counterparts `toJson` only started emitting
  // once the share-URL format became lossless.
  const LOSSLESS_ONLY_PACKET_KEYS = [
    "abbrev",
    "rendererHints",
    "meta",
    "imports",
    "version",
    "defs",
  ];

  /** A packet shaped like a share blob minted by the pre-lossless encoder. */
  function asLegacyBlob(p: Packet): Packet {
    const out = { ...p } as Record<string, unknown>;
    for (const k of LOSSLESS_ONLY_PACKET_KEYS) delete out[k];
    return out as Packet;
  }

  it("組み込み preset は自分自身にマッチする", () => {
    expect(findPresetKeyForPacket(PRESETS["ipv4"], PRESETS)).toBe("ipv4");
  });

  it("lossless 化より前に作られた共有 URL も引き続き preset に正規化される", () => {
    // Guards the homepage `?psdl=…` → `?preset=<key>` redirect for every link
    // already in the wild: those blobs carry none of the 0.5 metadata keys,
    // while today's presets do, so a strict wire comparison can never match.
    expect(findPresetKeyForPacket(asLegacyBlob(PRESETS["ipv4"]), PRESETS)).toBe(
      "ipv4",
    );
  });

  it("メタデータが異なるパケットは preset に畳み込まない", () => {
    // Collapsing this onto `?preset=ipv4` would silently discard the author's
    // own metadata, so it must stay a `?psdl=` document.
    const edited = {
      ...PRESETS["ipv4"],
      meta: { family: "custom-family" },
    } as Packet;
    expect(findPresetKeyForPacket(edited, PRESETS)).toBeNull();
  });

  it("body が異なる legacy blob は fallback でもマッチしない", () => {
    const legacy = asLegacyBlob(PRESETS["ipv4"]);
    const mutated = {
      ...legacy,
      body: [{ id: "zzz", name: "ZZZ", type: { kind: "bits", n: 8 } }],
    } as Packet;
    expect(findPresetKeyForPacket(mutated, PRESETS)).toBeNull();
  });
});
