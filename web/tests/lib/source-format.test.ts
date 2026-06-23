import { describe, expect, it } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import {
  decodeSource,
  encodeSource,
  SourceParseError,
} from "@/lib/psdl/source-format";
import type { PsdlPacket } from "@/lib/psdl/types";

const sample: PsdlPacket = {
  name: "Sample",
  rowBits: 8,
  body: [{ id: "x", name: "X", type: { kind: "bits", n: 8 } }],
};

describe("source-format", () => {
  describe("encodeSource → decodeSource round-trip (YAML)", () => {
    it("preserves a minimal packet", () => {
      const text = encodeSource(sample);
      const back = decodeSource(text);
      expect(back).toEqual(sample);
    });

    it("round-trips every built-in preset", () => {
      for (const [key, preset] of Object.entries(PRESETS)) {
        const text = encodeSource(preset);
        const back = decodeSource(text);
        expect(back, `preset ${key}`).toEqual(preset);
      }
    });
  });

  describe("decodeSource", () => {
    it("accepts plain YAML (preset shape, no wire markers)", () => {
      const text =
        "name: Bare\nrowBits: 8\nbody:\n  - { id: x, name: X, type: { kind: bits, n: 8 } }\n";
      const back = decodeSource(text);
      expect(back.name).toBe("Bare");
      expect(back.body.length).toBe(1);
    });

    it("strips wire `format` / `version` markers if a user pastes them", () => {
      const text =
        'format: psdl\nversion: "0.4"\nname: Tagged\nrowBits: 8\nbody:\n  - { id: x, name: X, type: { kind: bits, n: 8 } }\n';
      const back = decodeSource(text);
      expect((back as { format?: unknown }).format).toBeUndefined();
      expect((back as { version?: unknown }).version).toBeUndefined();
      expect(back.name).toBe("Tagged");
    });

    it("reports the YAML line on parse failure", () => {
      const text =
        "name: Bad\nrowBits: 8\nbody:\n  - { id: x, name: X, type: { kind: bits, n: 8 }\n";
      let thrown: unknown;
      try {
        decodeSource(text);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(SourceParseError);
      const err = thrown as SourceParseError;
      expect(err.line).toBeGreaterThanOrEqual(1);
    });

    it("rejects an empty document with a friendly hint", () => {
      let thrown: unknown;
      try {
        decodeSource("");
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(SourceParseError);
      expect((thrown as Error).message).toMatch(/empty/i);
    });

    it("rejects a top-level array", () => {
      expect(() => decodeSource("- a\n- b\n")).toThrow(SourceParseError);
    });

    it("rejects validation failures (empty name)", () => {
      const text = 'name: ""\nrowBits: 8\nbody: []\n';
      expect(() => decodeSource(text)).toThrow();
    });
  });

  describe("encodeSource", () => {
    it("never emits wire-only `format`/`version` markers", () => {
      const out = encodeSource(sample);
      expect(out.includes("format:")).toBe(false);
      expect(out.includes("version:")).toBe(false);
    });
  });
});
