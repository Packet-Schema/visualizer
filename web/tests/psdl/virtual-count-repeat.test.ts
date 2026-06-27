// A freeRepeat whose count is `ref(virtualField)` is INERT: core's normalize
// recomputes `env[virtualId]` from the virtual's expr on every render
// (walkVirtual `state.env.set(id, eval(expr))`), clobbering whatever the
// OverridePanel stepper wrote before `count={ref:...}` is evaluated. kerberosAsReq
// `padataList count={ref:padataCount}` with `padataCount` a virtual `lit 1` is
// exactly this case — driving env[padataCount] over 0/1/2/3/5 always renders one
// PA-DATA record. collectFreeRepeats must surface NO stepper for it, since the
// only fix that keeps the count editable is replacing the virtual with a real
// field in the PSDL (a source change, not an override surface).

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

/** Count rendered cells whose id is `padataList` (the repeated PA-DATA record),
 *  at app-realistic env (initialEnv + 0-fill) with the given overrides. */
function padataRecordCount(
  psdl: PsdlPacket,
  overrides: Record<string, number>,
): number {
  const env = new Map<string, number>(Object.entries(overrides));
  for (const [k, v] of initialEnv(psdl)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  return resolveLayout(psdl, { env, viewMode: "semantic" }).cells.filter(
    (c) => c.field.id === "padataList",
  ).length;
}

describe("collectFreeRepeats — virtual count ref", () => {
  it("kerberosAsReq exposes NO freeRepeat keyed on the virtual padataCount", () => {
    const mirror = psdlToRenderer(PRESETS.kerberosAsReq!);
    const padata = (mirror.freeRepeats ?? []).find(
      (fr) => fr.countKey === "padataCount",
    );
    expect(
      padata,
      "padataCount is a virtual field; normalize recomputes it every render, so a stepper on it is inert/misleading and must not be surfaced",
    ).toBeUndefined();
  });

  it("the underlying control would be inert: env[padataCount] cannot change the rendered PA-DATA record count", () => {
    const kerberos = PRESETS.kerberosAsReq!;
    const counts = [0, 1, 2, 3, 5].map((n) =>
      padataRecordCount(kerberos, { padataCount: n }),
    );
    // The virtual recompute pins the count regardless of the override — every
    // value renders the same number of records. (This is WHY no stepper is
    // surfaced: it could never move the diagram.)
    expect(new Set(counts).size).toBe(1);
  });
});
