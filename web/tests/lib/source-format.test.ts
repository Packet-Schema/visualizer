import { describe, expect, it } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import {
  decodeSource,
  encodeSource,
  lintSource,
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

    // Regression: "Save as preset" / KSY / save-as bake a non-default `env`
    // block directly onto the PsdlPacket. `env` is NOT a top-level PSDL schema
    // property and the schema uses `unevaluatedProperties: false`, so emitting
    // it into the YAML made the source pane fail to re-parse (= uneditable) the
    // moment the user typed a character. `env` is controller state, not
    // authored PSDL, so it must be omitted (mirrors `toJson`, which never
    // spreads packet.env).
    it("omits a baked controller `env` block", () => {
      const withEnv: PsdlPacket = { ...sample, env: { someCount: 3 } };
      const out = encodeSource(withEnv);
      expect(out.includes("env:")).toBe(false);
    });
  });

  describe("baked controller `env` does not break the YAML edit round-trip", () => {
    // `decodeSource(encodeSource(packetWithEnv))` must succeed — previously it
    // threw `PSDL schema validation failed: (root): must NOT have unevaluated
    // properties`.
    it("re-parses a packet that carries a baked env without a schema error", () => {
      const withEnv: PsdlPacket = { ...sample, env: { someCount: 3 } };
      const back = decodeSource(encodeSource(withEnv));
      expect(back.name).toBe(sample.name);
      // env is dropped on the authoring round-trip (controller state, not PSDL).
      expect(back.env).toBeUndefined();
    });

    it("re-parses an env-carrying preset (dnsResponse) without a schema error", () => {
      const withEnv: PsdlPacket = {
        ...PRESETS.dnsResponse,
        env: { dnsAnCount: 3 },
      };
      expect(() => decodeSource(encodeSource(withEnv))).not.toThrow();
    });

    // Defensive: even if a stale/hand-pasted YAML still contains an `env`
    // block (e.g. a user pasted an env-baked packet), decodeSource must strip
    // it before schema validation instead of rejecting the document.
    it("strips an env block present in raw pasted YAML", () => {
      const text =
        "name: Bare\nrowBits: 8\n" +
        "body:\n  - { id: x, name: X, type: { kind: bits, n: 8 } }\n" +
        "env:\n  someCount: 2\n";
      const back = decodeSource(text);
      expect(back.name).toBe("Bare");
      expect(back.env).toBeUndefined();
    });

    it("does not flag an env block as a lint issue", () => {
      const text =
        "name: Bare\nrowBits: 8\n" +
        "body:\n  - { id: x, name: X, type: { kind: bits, n: 8 } }\n" +
        "env:\n  someCount: 2\n";
      expect(lintSource(text)).toEqual([]);
    });
  });
});
