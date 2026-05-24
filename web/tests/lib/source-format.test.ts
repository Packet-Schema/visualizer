import { describe, expect, it } from "vitest";

import { PRESETS } from "@/lib/psml/presets";
import {
  decodeSource,
  encodeSource,
  SourceParseError,
} from "@/lib/psml/source-format";
import type { PsmlPacket } from "@/lib/psml/types";

const sample: PsmlPacket = {
  name: "Sample",
  rowBits: 8,
  body: [{ id: "x", name: "X", type: { kind: "bits", n: 8 } }],
};

describe("source-format", () => {
  describe("encodeSource → decodeSource round-trip", () => {
    it("preserves a minimal packet through YAML", () => {
      const text = encodeSource(sample, "yaml");
      const back = decodeSource(text, "yaml");
      expect(back).toEqual(sample);
    });

    it("preserves a minimal packet through JSON", () => {
      const text = encodeSource(sample, "json");
      const back = decodeSource(text, "json");
      expect(back).toEqual(sample);
    });

    it("round-trips every built-in preset through YAML", () => {
      for (const [key, preset] of Object.entries(PRESETS)) {
        const text = encodeSource(preset, "yaml");
        const back = decodeSource(text, "yaml");
        expect(back, `preset ${key}`).toEqual(preset);
      }
    });

    it("round-trips every built-in preset through JSON", () => {
      for (const [key, preset] of Object.entries(PRESETS)) {
        const text = encodeSource(preset, "json");
        const back = decodeSource(text, "json");
        expect(back, `preset ${key}`).toEqual(preset);
      }
    });
  });

  describe("decodeSource", () => {
    it("strips the on-wire `format` / `version` markers if present", () => {
      const text = JSON.stringify(
        {
          format: "psml",
          version: "0.4",
          name: "Tagged",
          rowBits: 8,
          body: [{ id: "x", name: "X", type: { kind: "bits", n: 8 } }],
        },
        null,
        2,
      );
      const back = decodeSource(text, "json");
      expect((back as { format?: unknown }).format).toBeUndefined();
      expect((back as { version?: unknown }).version).toBeUndefined();
      expect(back.name).toBe("Tagged");
    });

    it("accepts YAML input that omits `format`/`version` (preset shape)", () => {
      const text =
        "name: Bare\nrowBits: 8\nbody:\n  - { id: x, name: X, type: { kind: bits, n: 8 } }\n";
      const back = decodeSource(text, "yaml");
      expect(back.name).toBe("Bare");
      expect(back.body.length).toBe(1);
    });

    it("reports the YAML line on parse failure", () => {
      const text =
        "name: Bad\nrowBits: 8\nbody:\n  - { id: x, name: X, type: { kind: bits, n: 8 }\n";
      let thrown: unknown;
      try {
        decodeSource(text, "yaml");
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(SourceParseError);
      const err = thrown as SourceParseError;
      expect(err.line).toBeGreaterThanOrEqual(1);
    });

    it("rejects a top-level array", () => {
      expect(() => decodeSource("[]", "json")).toThrow(SourceParseError);
    });

    it("rejects validation failures (empty name)", () => {
      const bad: unknown = { name: "", rowBits: 8, body: [] };
      const text = JSON.stringify(bad);
      expect(() => decodeSource(text, "json")).toThrow();
    });
  });

  describe("encodeSource", () => {
    it("emits the on-wire `format`/`version` only for JSON", () => {
      const yamlOut = encodeSource(sample, "yaml");
      const jsonOut = encodeSource(sample, "json");
      expect(yamlOut.includes("format:")).toBe(false);
      expect(jsonOut.includes('"format": "psml"')).toBe(true);
      expect(jsonOut.includes('"version": "0.4"')).toBe(true);
    });
  });
});
