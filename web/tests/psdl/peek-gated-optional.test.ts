// Regression: an `Optional` gated by a `peek(bits) == lit` `when` must
// surface a peek-switch picker so the gated region (and any repeat-count
// stepper inside it) is reachable. Without this the region is hidden at the
// default env (peek defaults to 0) and — because the gate's `when` is a peek,
// not a `ref` — `attachOverrideMetadata` produces no `optionalGateFor`, so a
// surfaced repeat stepper inside the region appears permanently inert.
//
// Concrete victim: ROHC Uncompressed (RFC 5795). `rohcPadding` / `rohcFeedback`
// are until-repeats wrapped in `optional(peek(8) == 224)` / `optional(peek(5)
// == 30)`. Before the fix their freeRepeat steppers could never change the
// diagram because the only control that reveals the records — the gating peek —
// was unsurfaced.

import { describe, expect, it } from "vitest";

import { PRESETS } from "../../lib/psdl/presets.server";
import { psdlToRenderer } from "../../lib/psdl/psdl-to-renderer";
import { resolveLayout } from "../../lib/psdl/layout";
import { peekEnvKey } from "../../lib/psdl/expr";
import type { Packet } from "../../lib/psdl/types";

const rohc = (): Packet => PRESETS.rohcUncompressed as Packet;

const paddingCellIds = (env: Record<string, number>): string[] =>
  resolveLayout(rohc(), { env: new Map(Object.entries(env)) })
    .cells.map((c) => c.field.id)
    .filter((id) => /padding|feedback/i.test(id));

describe("psdlToRenderer — peek-gated Optional surfaces its gate", () => {
  it("publishes a peek-switch for ROHC padding / feedback gates", () => {
    const mirror = psdlToRenderer(rohc());
    const byKey = new Map(
      (mirror.peekSwitches ?? []).map((p) => [p.peekKey, p] as const),
    );

    const padKey = peekEnvKey(0, 8);
    const fbKey = peekEnvKey(0, 5);
    const pad = byKey.get(padKey);
    const fb = byKey.get(fbKey);

    expect(pad).toBeDefined();
    expect(fb).toBeDefined();
    // Each gate offers the "present" value plus an "(absent)" toggle-off case.
    expect(pad!.cases.map((c) => c.value)).toContain(224);
    expect(fb!.cases.map((c) => c.value)).toContain(30);
    expect(pad!.cases.some((c) => c.label === "(absent)")).toBe(true);
    expect(fb!.cases.some((c) => c.label === "(absent)")).toBe(true);
  });

  it("does not shadow the real header Switch peek key", () => {
    const mirror = psdlToRenderer(rohc());
    // The 7-bit header dispatch (`__peek__0__7`) must still surface exactly
    // once, from the Switch — not duplicated by a gate picker.
    const headerKey = peekEnvKey(0, 7);
    const headerPickers = (mirror.peekSwitches ?? []).filter(
      (p) => p.peekKey === headerKey,
    );
    expect(headerPickers).toHaveLength(1);
    expect(headerPickers[0].id).toBe("rohcHeader");
  });

  it("the surfaced gate keys actually change the diagram", () => {
    // Default env: gates are closed, no record renders regardless of the
    // repeat-count stepper.
    expect(paddingCellIds({ rohcPadding: 2, rohcFeedback: 2 })).toEqual([]);

    // Opening the padding gate (the env key the picker writes) plus the
    // repeat-count stepper reveals padding cells.
    const padded = paddingCellIds({ [peekEnvKey(0, 8)]: 224, rohcPadding: 2 });
    expect(padded.length).toBeGreaterThan(0);
    expect(padded.every((id) => /padding/i.test(id))).toBe(true);

    // Same for feedback via its own gate key.
    const fed = paddingCellIds({ [peekEnvKey(0, 5)]: 30, rohcFeedback: 2 });
    expect(fed.length).toBeGreaterThan(0);
    expect(fed.every((id) => /feedback/i.test(id))).toBe(true);
  });
});

describe("psdlToRenderer — peek-gated Optional grouping", () => {
  it("collapses gates that share a peek key into one picker (Teredo)", () => {
    const mirror = psdlToRenderer(PRESETS.teredo as Packet);
    const key = peekEnvKey(0, 16);
    const pickers = (mirror.peekSwitches ?? []).filter(
      (p) => p.peekKey === key,
    );
    // Teredo's two indicators both peek 16 bits at offset 0; they must share
    // a single picker (writing the same env key) rather than two pickers that
    // fight over it.
    expect(pickers).toHaveLength(1);
    const values = pickers[0].cases.map((c) => c.value);
    expect(values).toContain(0); // Origin Indicator
    expect(values).toContain(1); // Authentication Indicator
    // The "(absent)" case must not collide with a real gate value.
    const absent = pickers[0].cases.find((c) => c.label === "(absent)");
    expect(absent).toBeDefined();
    expect([0, 1]).not.toContain(absent!.value);
  });
});
