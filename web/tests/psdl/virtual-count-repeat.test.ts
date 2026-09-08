// A repeat whose count is `ref(virtualField)` splits into two cases by the
// virtual's expr, because core's normalize recomputes `env[virtualId]` from the
// virtual's expr on every render (walkVirtual `state.env.set(id, eval(expr))`)
// BEFORE the repeat count is read:
//
//   * LITERAL-valued virtual (`expr: lit N`): the recompute pins the count at N
//     regardless of any override the OverridePanel stepper wrote — a stepper on
//     it is INERT/misleading, so collectFreeRepeats must surface NONE.
//
//   * SELF-ref virtual (`expr: ref(self.id)`): the recompute is idempotent
//     (`env.set(id, eval(ref(id)))` = `env.set(id, env[id])`), so an override
//     SURVIVES and the count IS drivable. collectFreeRepeats surfaces a real
//     count stepper. kerberosAsReq `padataList count={ref:padataCount}` is this
//     case: the visualizer preset adapter rewrites the upstream literal
//     `padataCount` virtual into a self-ref seed precisely so its visible
//     PA-DATA list gets an add/remove control instead of being
//     see-but-cannot-edit.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { initialState } from "@/lib/psdl/renderer-helpers";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

/** Count rendered cells whose stripped id is `rec` (the repeated record tag),
 *  at app-realistic env (initialEnv + 0-fill) with the given overrides. */
function recordCount(
  psdl: PsdlPacket,
  overrides: Record<string, number>,
): number {
  const env = new Map<string, number>(Object.entries(overrides));
  for (const [k, v] of initialEnv(psdl)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  return resolveLayout(psdl, { env, viewMode: "semantic" }).cells.filter(
    (c) => c.field.id.replace(/#\d+$/, "") === "rec",
  ).length;
}

describe("collectFreeRepeats — virtual count ref", () => {
  it("suppresses a freeRepeat keyed on a LITERAL-valued virtual (inert)", () => {
    // Arbitrary (non-preset) PSDL: a repeat counted by a virtual fixed to lit 2.
    // No override can move it — core recomputes the virtual to 2 every render —
    // so no stepper may be surfaced for it.
    const src: PsdlPacket = {
      name: "t",
      rowBits: 32,
      body: [
        { kind: "virtual", id: "litCount", expr: { kind: "lit", value: 2 } },
        {
          kind: "repeat",
          id: "litList",
          count: { kind: "ref", field: "litCount" },
          element: {
            id: "rec",
            fields: [{ id: "rec", type: { kind: "int", bits: 8 } }],
          },
        },
      ],
    } as unknown as PsdlPacket;

    const mirror = psdlToRenderer(src);
    const keys = (mirror.freeRepeats ?? []).map((fr) => fr.countKey);
    expect(keys).not.toContain("litCount");

    // And prove the inertness the suppression avoids: stepping litCount leaves
    // the record count pinned at 2 for every value.
    const counts = new Set(
      [0, 1, 3, 5].map((n) => recordCount(src, { litCount: n })),
    );
    expect(counts).toEqual(new Set([2]));
  });

  it("surfaces a DRIVABLE freeRepeat keyed on a SELF-ref virtual", () => {
    // Arbitrary (non-preset) PSDL: the same shape but with a self-ref virtual.
    const src: PsdlPacket = {
      name: "t",
      rowBits: 32,
      body: [
        {
          kind: "virtual",
          id: "selfCount",
          expr: { kind: "ref", field: "selfCount" },
        },
        {
          kind: "repeat",
          id: "selfList",
          count: { kind: "ref", field: "selfCount" },
          element: {
            id: "rec",
            fields: [{ id: "rec", type: { kind: "int", bits: 8 } }],
          },
        },
      ],
    } as unknown as PsdlPacket;

    const mirror = psdlToRenderer(src);
    const fr = (mirror.freeRepeats ?? []).find(
      (r) => r.countKey === "selfCount",
    );
    expect(fr, "self-ref virtual count must surface a stepper").toBeDefined();

    // The override survives the recompute → the record count tracks it.
    expect([0, 1, 2, 4].map((n) => recordCount(src, { selfCount: n }))).toEqual(
      [0, 1, 2, 4],
    );
  });

  it("kerberosAsReq exposes a DRIVABLE padataCount stepper (self-ref seed)", () => {
    const mirror = psdlToRenderer(PRESETS.kerberosAsReq!);
    const fr = (mirror.freeRepeats ?? []).find(
      (r) => r.countKey === "padataCount",
    );
    expect(
      fr,
      "padataCount must be surfaced as a real, drivable count stepper",
    ).toBeDefined();
    expect(fr?.defaultCount).toBe(1);

    // env[padataCount] now changes the rendered PA-DATA record count one-for-one
    // (was pinned at 1 before the self-ref preset patch + collector relaxation).
    const src = PRESETS.kerberosAsReq!;
    const controllers = initialState(mirror);
    const recordCounts = [0, 1, 2, 3].map((value) => {
      const env = new Map<string, number>(
        Object.entries(controllers).map(([k, v]) => [k, Number(v)]),
      );
      for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
      for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
      env.set("kerberosHasPadata", 1);
      env.set("padataCount", value);
      return resolveLayout(src, { env, viewMode: "semantic" }).cells.filter(
        (c) => c.field.id.replace(/#\d+$/, "") === "padataRecTag",
      ).length;
    });
    expect(recordCounts).toEqual([0, 1, 2, 3]);
  });
});
