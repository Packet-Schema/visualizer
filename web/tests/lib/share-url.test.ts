import { describe, expect, it } from "vitest";

import {
  buildShareUrl,
  decodePsmlParam,
  encodePsmlParam,
  parseShareParams,
} from "@/lib/share-url";
import { PRESETS } from "@/lib/psml/presets";
import type { Packet } from "@/lib/psml/types";

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
      defaultPacketKey: "ipv4",
      builtInKeys: BUILT_INS,
    });
    expect(url).toBe("https://example.test/view?preset=tcp");
  });

  it("round-trips custom PSML through an encoded payload", () => {
    const encoded = encodePsmlParam(packet("Custom Packet"), {
      customLen: 12,
    });
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");

    const decoded = decodePsmlParam(encoded);
    expect(decoded.packet.name).toBe("Custom Packet");
    expect(decoded.controllers).toEqual({ customLen: 12 });
  });

  it("treats invalid psml and unknown preset values defensively", () => {
    const badPsml = parseShareParams("?psml=not-valid", BUILT_INS);
    expect(badPsml.kind).toBe("none");
    expect(badPsml.error).toMatch(/Invalid shared PSML payload/);

    const unknownPreset = parseShareParams("?preset=nope", BUILT_INS);
    expect(unknownPreset.kind).toBe("none");
    expect(unknownPreset.error).toMatch(/Unknown preset/);
  });
});
