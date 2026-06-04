// PSDL layout parity — after Round 6 every preset is a PSDL Packet and the
// diagram is resolved via `resolveLayout`. This file asserts that each
// preset's totalBits matches the documented fixture in both wire and (where
// applicable) semantic view modes.

import { describe, expect, it } from "vitest";
import { resolveLayout } from "../../lib/psdl/layout";
import { initialEnv, normalize } from "../../lib/psdl/normalize";
import { validatePsdlPacket } from "../../lib/psdl/validate";
import { PRESETS } from "../../lib/psdl/presets";
import type { Expr, Packet } from "../../lib/psdl/types";
import {
  EXPECTED_TOTAL_BITS,
  EXPECTED_TOTAL_BITS_PSDL_04,
  EXPECTED_TOTAL_BITS_PSDL_ONLY,
  EXPECTED_TOTAL_BITS_SEMANTIC,
  PRESET_KEYS,
  PSDL_04_PRESET_KEYS,
  PSDL_ONLY_PRESET_KEYS,
} from "../fixtures/preset-bit-sizes";

function collectAllRefs(packet: Packet): Set<string> {
  const out = new Set<string>();
  const visit = (e: Expr) => {
    switch (e.kind) {
      case "lit":
        return;
      case "ref":
        out.add(e.field);
        return;
      case "op":
        visit(e.a);
        visit(e.b);
        return;
      case "cond":
        visit(e.test);
        visit(e.t);
        visit(e.f);
        return;
    }
  };
  type AnyNode = {
    kind?: string;
    type?: { kind: string; n?: Expr };
    element?: { fields: AnyNode[] };
    children?: AnyNode[];
    cases?: Record<string, { fields: AnyNode[] }>;
    default?: { fields: AnyNode[] };
    on?: Expr;
    count?: Expr | string | { until: Expr };
    plaintext?: { fields: AnyNode[] };
    wireBits?: Expr;
  };
  const walk = (containers: AnyNode[]) => {
    for (const c of containers) {
      if (!c.kind || c.kind === "field") {
        if (c.type?.kind === "bytes" && c.type.n) visit(c.type.n);
        continue;
      }
      if (c.kind === "group" && c.children) walk(c.children);
      if (c.kind === "switch") {
        if (c.on) visit(c.on);
        for (const v of Object.values(c.cases ?? {})) walk(v.fields);
        if (c.default) walk(c.default.fields);
      }
      if (c.kind === "repeat") {
        if (c.count && typeof c.count === "object" && "kind" in c.count) {
          visit(c.count as Expr);
        }
        if (c.element) walk(c.element.fields);
      }
      if (c.kind === "encrypted") {
        if (c.wireBits) visit(c.wireBits);
        if (c.plaintext) walk(c.plaintext.fields);
      }
    }
  };
  walk(packet.body as AnyNode[]);
  return out;
}

function buildEnv(packet: Packet) {
  const env = initialEnv(packet);
  for (const r of collectAllRefs(packet)) {
    if (!env.has(r)) env.set(r, 0);
  }
  return env;
}

describe("preset registry sanity", () => {
  it("PSDL registry contains every documented preset", () => {
    for (const k of PRESET_KEYS) {
      expect(PRESETS[k], `psdl preset "${k}"`).toBeDefined();
    }
    for (const k of PSDL_ONLY_PRESET_KEYS) {
      expect(PRESETS[k], `psdl-only preset "${k}"`).toBeDefined();
    }
  });

  it("PRESETS exposes every documented key (picker + PSDL-only + PSDL 0.4 demo)", () => {
    expect(Object.keys(PRESETS).sort()).toEqual(
      [...PRESET_KEYS, ...PSDL_ONLY_PRESET_KEYS, ...PSDL_04_PRESET_KEYS].sort(),
    );
  });
});

for (const key of PRESET_KEYS) {
  describe(`layout — ${key}`, () => {
    it("PSDL totalBits matches expected fixture", () => {
      const pkt = PRESETS[key];
      expect(pkt, `psdl preset "${key}"`).toBeDefined();
      const env = buildEnv(pkt);
      const layout = resolveLayout(pkt, { env });
      expect(layout.totalBits).toBe(EXPECTED_TOTAL_BITS[key]);
    });
  });
}

for (const key of PSDL_ONLY_PRESET_KEYS) {
  describe(`PSDL-only preset — ${key}`, () => {
    it("normalizes without throwing", () => {
      const pkt = PRESETS[key];
      const env = buildEnv(pkt);
      expect(() => normalize(pkt, env)).not.toThrow();
    });

    it("passes schema validation", () => {
      const pkt = PRESETS[key];
      expect(() => validatePsdlPacket(pkt)).not.toThrow();
    });

    it("wire-mode totalBits matches expected fixture", () => {
      const pkt = PRESETS[key];
      const env = buildEnv(pkt);
      const layout = resolveLayout(pkt, { env, viewMode: "wire" });
      expect(layout.totalBits).toBe(EXPECTED_TOTAL_BITS_PSDL_ONLY[key]);
    });

    it("semantic-mode totalBits matches expected fixture", () => {
      const pkt = PRESETS[key];
      const env = buildEnv(pkt);
      const layout = resolveLayout(pkt, { env, viewMode: "semantic" });
      expect(layout.totalBits).toBe(EXPECTED_TOTAL_BITS_SEMANTIC[key]);
    });

    it("semantic-mode totalBits is greater than wire-mode totalBits", () => {
      const pkt = PRESETS[key];
      const env = buildEnv(pkt);
      const wire = resolveLayout(pkt, { env, viewMode: "wire" });
      const sem = resolveLayout(pkt, { env, viewMode: "semantic" });
      expect(sem.totalBits).toBeGreaterThan(wire.totalBits);
    });
  });
}

describe("quicShort — PSDL 0.3 Encrypted shape", () => {
  it("normalizes without throwing", () => {
    const pkt = PRESETS["quicShort"];
    const env = buildEnv(pkt);
    expect(() => normalize(pkt, env)).not.toThrow();
  });

  it("passes schema validation", () => {
    const pkt = PRESETS["quicShort"];
    expect(() => validatePsdlPacket(pkt)).not.toThrow();
  });

  it("semantic-mode totalBits is greater than wire-mode totalBits", () => {
    const pkt = PRESETS["quicShort"];
    const env = buildEnv(pkt);
    const wire = resolveLayout(pkt, { env, viewMode: "wire" });
    const sem = resolveLayout(pkt, { env, viewMode: "semantic" });
    expect(wire.totalBits).toBe(EXPECTED_TOTAL_BITS["quicShort"]);
    expect(sem.totalBits).toBe(EXPECTED_TOTAL_BITS_SEMANTIC["quicShort"]);
    expect(sem.totalBits).toBeGreaterThan(wire.totalBits);
  });
});

for (const key of PSDL_04_PRESET_KEYS) {
  describe(`PSDL 0.4 demo preset — ${key}`, () => {
    it("normalizes without throwing", () => {
      const pkt = PRESETS[key];
      const env = buildEnv(pkt);
      expect(() => normalize(pkt, env)).not.toThrow();
    });

    it("passes schema validation", () => {
      const pkt = PRESETS[key];
      expect(() => validatePsdlPacket(pkt)).not.toThrow();
    });

    it("totalBits matches expected fixture", () => {
      const pkt = PRESETS[key];
      const env = buildEnv(pkt);
      const layout = resolveLayout(pkt, { env });
      expect(layout.totalBits).toBe(EXPECTED_TOTAL_BITS_PSDL_04[key]);
    });
  });
}

describe("http2FrameHeader — per-type payload Switch", () => {
  it("unknown frame type renders an opaque length-prefixed payload", () => {
    const pkt = PRESETS["http2FrameHeader"];
    const env = buildEnv(pkt);
    // An unregistered Type (0xFF) falls through to the Switch default,
    // which carries the opaque `payload` byte run sized by http2PayloadBytes.
    env.set("type", 0xff);
    env.set("http2PayloadBytes", 7);
    const layout = resolveLayout(pkt, { env });
    // 9-byte fixed header (72 bits) + 7 bytes of opaque payload (56 bits) = 128.
    expect(layout.totalBits).toBe(72 + 7 * 8);
    const payload = layout.cells.find((c) => c.field.id === "payload");
    expect(payload?.bitsTotal).toBe(56);
  });

  it("SETTINGS frame (Type 0x4) expands Identifier/Value entries", () => {
    const pkt = PRESETS["http2FrameHeader"];
    const env = buildEnv(pkt);
    env.set("type", 0x4);
    env.set("http2SettingsCount", 2);
    const layout = resolveLayout(pkt, { env });
    // 72-bit header + 2 entries × (16 + 32) bits = 72 + 96 = 168.
    expect(layout.totalBits).toBe(72 + 2 * (16 + 32));
  });

  it("RST_STREAM frame (Type 0x3) appends a 32-bit Error Code", () => {
    const pkt = PRESETS["http2FrameHeader"];
    const env = buildEnv(pkt);
    env.set("type", 0x3);
    const layout = resolveLayout(pkt, { env });
    expect(layout.totalBits).toBe(72 + 32);
  });
});

describe("tlsExtensionsBlock — peek lookahead Switch", () => {
  it("peek seeds the Switch case via the synthetic env key", () => {
    const pkt = PRESETS["tlsExtensionsBlock"];
    const env = buildEnv(pkt);
    // One repetition, peek = 0 → SNI case.
    env.set("tlsExtensionsBlock_extensions_count", 1);
    env.set("__peek__0__16", 0);
    env.set("serverNameListLength", 5);
    const layout = resolveLayout(pkt, { env });
    // 16 (extensionType) + 16 (serverNameListLength) + 40 (5 bytes) = 72.
    expect(layout.totalBits).toBe(72);
    // Fields emitted from inside a Repeat carry the repetition index as
    // a suffix (e.g. `serverNameList#0`). Match exactly that shape — a
    // bare `startsWith("serverNameList")` would also accept the
    // sibling `serverNameListLength` field and let the regression slip
    // through if the inner Repeat field got renamed.
    expect(
      layout.cells.some((c) => /^serverNameList#\d+$/.test(c.field.id)),
    ).toBe(true);
  });
});

describe("pcieTlpFragment — per-field byteOrder propagation", () => {
  it("LE byteOrder reaches the cell layer", () => {
    const pkt = PRESETS["pcieTlpFragment"];
    const env = buildEnv(pkt);
    const layout = resolveLayout(pkt, { env });
    const addr = layout.cells.find((c) => c.field.id === "address");
    const len = layout.cells.find((c) => c.field.id === "length");
    expect(addr?.byteOrder).toBe("BE");
    expect(len?.byteOrder).toBe("LE");
  });
});

describe("quicLong — header-protected Packet Number", () => {
  it("semantic-mode emits headerProtected on Packet Number cells", () => {
    const pkt = PRESETS["quicLong"];
    const env = buildEnv(pkt);
    const layout = resolveLayout(pkt, { env, viewMode: "semantic" });
    const pnCells = layout.cells.filter((c) => c.field.id === "packetNumber");
    expect(pnCells.length).toBeGreaterThan(0);
    expect(pnCells.every((c) => c.headerProtected)).toBe(true);
  });
});
