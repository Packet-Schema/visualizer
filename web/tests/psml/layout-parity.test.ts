// PSML layout parity — for each of the 13 presets, the runtime resolver
// (`resolvePacket`, used by the React components) and the PSML layout
// adapter (`resolveLayout`, used by every format exporter) must agree on
// totalBits. Also asserts the expected total against a hand-maintained
// fixture so any size regression surfaces in the diff.

import { describe, expect, it } from "vitest";
import { resolveLayout } from "../../lib/psml/layout";
import { initialEnv } from "../../lib/psml/normalize";
import {
  initialState,
  resolvePacket,
} from "../../lib/psml/runtime-resolver";
import { GENERATED_PRESETS } from "../../lib/psml/presets.generated";
import { MANUAL_PRESETS } from "../../lib/psml/presets";
import { PRESETS } from "../../lib/psml/runtime-presets";
import type { Expr, Packet } from "../../lib/psml/types";
import { EXPECTED_TOTAL_BITS, PRESET_KEYS } from "../fixtures/preset-bit-sizes";

const ALL_PSML: Record<string, Packet> = { ...MANUAL_PRESETS, ...GENERATED_PRESETS };

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
    }
  };
  walk(packet.body as AnyNode[]);
  return out;
}

describe("preset registry sanity", () => {
  it("has 13 presets in PSML and runtime forms", () => {
    expect(Object.keys(ALL_PSML)).toHaveLength(13);
    expect(Object.keys(PRESETS)).toHaveLength(13);
    expect(Object.keys(EXPECTED_TOTAL_BITS)).toHaveLength(13);
  });

  it("PSML and runtime registries cover the same keys", () => {
    expect(new Set(Object.keys(PRESETS))).toEqual(new Set(Object.keys(ALL_PSML)));
  });
});

for (const key of PRESET_KEYS) {
  describe(`layout parity — ${key}`, () => {
    it("runtime totalBits matches expected fixture", () => {
      const pkt = PRESETS[key];
      expect(pkt, `runtime preset "${key}"`).toBeDefined();
      const layout = resolvePacket(pkt, initialState(pkt));
      expect(layout.totalBits).toBe(EXPECTED_TOTAL_BITS[key]);
    });

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
