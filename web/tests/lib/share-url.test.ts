import { describe, expect, it } from "vitest";

import {
  buildShareUrl,
  buildShareQueryFromParams,
  decodePsdlParam,
  encodePsdlParam,
  isShareQueryLengthValid,
  parseShareParams,
} from "@/lib/share-url";
import { PRESETS } from "@/lib/psdl/presets";
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
    expect(encoded).toMatch(/^[A-Za-z0-9+$-]+$/);
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");

    const decoded = decodePsdlParam(encoded);
    expect(decoded.packet.name).toBe("Custom Packet");
    expect(decoded.controllers).toEqual({ customLen: 12 });
  });

  it("treats invalid psdl and unknown preset values defensively", () => {
    const badPsdl = parseShareParams("?psdl=not-valid", BUILT_INS);
    if (badPsdl.kind !== "none") throw new Error("expected kind=none");
    expect(badPsdl.error).toMatch(/Invalid shared link/);

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

    const longQuery = "preset=" + "x".repeat(3000);
    expect(isShareQueryLengthValid(longQuery)).toBe(false);
  });
});
