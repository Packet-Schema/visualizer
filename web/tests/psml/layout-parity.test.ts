// PSML layout parity — for presets that exist in both the runtime registry
// (`resolvePacket`, used by the React components) and the PSML registry
// (`resolveLayout`, used by every format exporter) the totalBits must agree.
// PSML 0.3 (Phase 2C) introduces a few PSML-only presets — those exercise
// Encrypted/Varint primitives the runtime can't represent — so they are
// asserted separately against the wire-mode and semantic-mode fixtures.

import { describe, expect, it } from "vitest";
import { resolveLayout } from "../../lib/psml/layout";
import { initialEnv, normalize } from "../../lib/psml/normalize";
import {
  initialState,
  resolvePacket,
} from "../../lib/psml/runtime-resolver";
import { validatePsmlPacket } from "../../lib/psml/validate";
import { GENERATED_PRESETS } from "../../lib/psml/presets.generated";
import { MANUAL_PRESETS } from "../../lib/psml/presets";
import { PRESETS } from "../../lib/psml/runtime-presets";
import type { Expr, Packet } from "../../lib/psml/types";
import {
  EXPECTED_TOTAL_BITS,
  EXPECTED_TOTAL_BITS_PSML_ONLY,
  EXPECTED_TOTAL_BITS_SEMANTIC,
  PRESET_KEYS,
  PSML_ONLY_PRESET_KEYS,
} from "../fixtures/preset-bit-sizes";

// MANUAL wins over GENERATED so `quicShort` picks up the PSML 0.3 shape
// (Encrypted header-protection + AEAD payload) defined in presets.ts.
const ALL_PSML: Record<string, Packet> = { ...GENERATED_PRESETS, ...MANUAL_PRESETS };

// quicShort has different shapes in the runtime (flat 80 bits) and PSML
// (208 bits with Encrypted containers) — skip its runtime↔PSML parity check
// but still assert PSML totalBits against the fixture below.
const SKIP_RUNTIME_PARITY = new Set(["quicShort"]);

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

describe("preset registry sanity", () => {
  it("PSML registry covers runtime registry plus PSML-only Phase 2C presets", () => {
    expect(Object.keys(PRESETS)).toHaveLength(13);
    expect(Object.keys(EXPECTED_TOTAL_BITS)).toHaveLength(13);
    expect(Object.keys(EXPECTED_TOTAL_BITS_PSML_ONLY)).toHaveLength(2);
    // Every runtime key must also exist in the PSML registry.
    for (const k of Object.keys(PRESETS)) {
      expect(ALL_PSML[k], `psml preset "${k}"`).toBeDefined();
    }
    // PSML extends the runtime set by exactly the PSML-only Phase 2C keys.
    expect(new Set(Object.keys(ALL_PSML))).toEqual(
      new Set([
        ...Object.keys(PRESETS),
        ...PSML_ONLY_PRESET_KEYS,
      ]),
    );
  });
});

for (const key of PRESET_KEYS) {
  describe(`layout parity — ${key}`, () => {
    if (!SKIP_RUNTIME_PARITY.has(key)) {
      it("runtime totalBits matches expected fixture", () => {
        const pkt = PRESETS[key];
        expect(pkt, `runtime preset "${key}"`).toBeDefined();
        const layout = resolvePacket(pkt, initialState(pkt));
        expect(layout.totalBits).toBe(EXPECTED_TOTAL_BITS[key]);
      });
    }

    it("PSML totalBits matches expected fixture", () => {
      const pkt = ALL_PSML[key];
      expect(pkt, `psml preset "${key}"`).toBeDefined();
      const env = initialEnv(pkt);
      for (const r of collectAllRefs(pkt)) {
        if (!env.has(r)) env.set(r, 0);
      }
      const layout = resolveLayout(pkt, { env });
      expect(layout.totalBits).toBe(EXPECTED_TOTAL_BITS[key]);
    });
  });
}

for (const key of PSML_ONLY_PRESET_KEYS) {
  describe(`PSML-only preset — ${key}`, () => {
    it("normalizes without throwing", () => {
      const pkt = ALL_PSML[key];
      expect(pkt, `psml preset "${key}"`).toBeDefined();
      const env = initialEnv(pkt);
      for (const r of collectAllRefs(pkt)) {
        if (!env.has(r)) env.set(r, 0);
      }
      expect(() => normalize(pkt, env)).not.toThrow();
    });

    it("passes schema validation", () => {
      const pkt = ALL_PSML[key];
      expect(() => validatePsmlPacket(pkt)).not.toThrow();
    });

    it("wire-mode totalBits matches expected fixture", () => {
      const pkt = ALL_PSML[key];
      const env = initialEnv(pkt);
      for (const r of collectAllRefs(pkt)) {
        if (!env.has(r)) env.set(r, 0);
      }
      const layout = resolveLayout(pkt, { env, viewMode: "wire" });
      expect(layout.totalBits).toBe(EXPECTED_TOTAL_BITS_PSML_ONLY[key]);
    });

    it("semantic-mode totalBits matches expected fixture", () => {
      const pkt = ALL_PSML[key];
      const env = initialEnv(pkt);
      for (const r of collectAllRefs(pkt)) {
        if (!env.has(r)) env.set(r, 0);
      }
      const layout = resolveLayout(pkt, { env, viewMode: "semantic" });
      expect(layout.totalBits).toBe(EXPECTED_TOTAL_BITS_SEMANTIC[key]);
    });

    it("semantic-mode totalBits is greater than wire-mode totalBits", () => {
      const pkt = ALL_PSML[key];
      const env = initialEnv(pkt);
      for (const r of collectAllRefs(pkt)) {
        if (!env.has(r)) env.set(r, 0);
      }
      const wire = resolveLayout(pkt, { env, viewMode: "wire" });
      const sem = resolveLayout(pkt, { env, viewMode: "semantic" });
      expect(sem.totalBits).toBeGreaterThan(wire.totalBits);
    });
  });
}

describe("quicShort — PSML 0.3 Encrypted shape", () => {
  it("normalizes without throwing", () => {
    const pkt = ALL_PSML["quicShort"];
    const env = initialEnv(pkt);
    for (const r of collectAllRefs(pkt)) {
      if (!env.has(r)) env.set(r, 0);
    }
    expect(() => normalize(pkt, env)).not.toThrow();
  });

  it("passes schema validation", () => {
    const pkt = ALL_PSML["quicShort"];
    expect(() => validatePsmlPacket(pkt)).not.toThrow();
  });

  it("semantic-mode totalBits is greater than wire-mode totalBits", () => {
    const pkt = ALL_PSML["quicShort"];
    const env = initialEnv(pkt);
    for (const r of collectAllRefs(pkt)) {
      if (!env.has(r)) env.set(r, 0);
    }
    const wire = resolveLayout(pkt, { env, viewMode: "wire" });
    const sem = resolveLayout(pkt, { env, viewMode: "semantic" });
    expect(wire.totalBits).toBe(EXPECTED_TOTAL_BITS["quicShort"]);
    expect(sem.totalBits).toBe(EXPECTED_TOTAL_BITS_SEMANTIC["quicShort"]);
    expect(sem.totalBits).toBeGreaterThan(wire.totalBits);
  });
});
