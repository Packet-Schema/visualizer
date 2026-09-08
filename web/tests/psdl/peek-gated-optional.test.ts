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
import { initialState } from "../../lib/psdl/renderer-helpers";
import { peekEnvKey } from "../../lib/psdl/expr";
import type { Packet } from "../../lib/psdl/types";

const rohc = (): Packet => PRESETS.rohcUncompressed as Packet;

const paddingCellIds = (env: Record<string, number>): string[] =>
  resolveLayout(rohc(), { env: new Map(Object.entries(env)) })
    .cells.map((c) => c.field.id)
    .filter((id) => /padding|feedback/i.test(id));

const allCellIds = (env: Record<string, number>): string[] =>
  resolveLayout(rohc(), { env: new Map(Object.entries(env)) }).cells.map(
    (c) => c.field.id,
  );

describe("psdlToRenderer — peek-gated Optional surfaces its gate", () => {
  it("does NOT surface a redundant peek picker for the count-driven Padding / Feedback gates", () => {
    // ROHC Padding / Feedback are `optional(peek == lit){ group{ repeat until } }`.
    // The `rohcPadding` / `rohcFeedback` until-repeats already own count steppers
    // (freeRepeats), and `initialState` seeds the gate peek to its "present"
    // value, so the stepper alone reveals (raise) or hides (0) the records. A
    // peek picker that merely toggles the same region on/off is a misleading
    // duplicate of the stepper — setting the peek alone, with count 0, does
    // nothing. It must NOT be surfaced.
    const mirror = psdlToRenderer(rohc());
    const byKey = new Map(
      (mirror.peekSwitches ?? []).map((p) => [p.peekKey, p] as const),
    );

    const padKey = peekEnvKey(0, 8);
    const fbKey = peekEnvKey(0, 5);

    expect(byKey.get(padKey)).toBeUndefined();
    expect(byKey.get(fbKey)).toBeUndefined();

    // The count steppers ARE surfaced and ARE the live control.
    const repeatKeys = (mirror.freeRepeats ?? []).map((r) => r.countKey);
    expect(repeatKeys).toContain("rohcPadding");
    expect(repeatKeys).toContain("rohcFeedback");
  });

  it("still surfaces the peek picker for an optional wrapping a plain field (Add-CID)", () => {
    // The Add-CID octet is `optional(peek(4) == 14){ field }` — a directly
    // renderable field with NO count stepper of its own, so the peek picker is
    // the only control and must remain.
    const mirror = psdlToRenderer(rohc());
    const addCidKey = peekEnvKey(0, 4);
    const picker = (mirror.peekSwitches ?? []).find(
      (p) => p.peekKey === addCidKey,
    );
    expect(picker).toBeDefined();
    expect(picker!.cases.map((c) => c.value)).toContain(14);
    expect(picker!.cases.some((c) => c.label === "(absent)")).toBe(true);
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

  it("the header dispatch picker can drive BOTH IR and normal-datagram layouts", () => {
    const mirror = psdlToRenderer(rohc());
    const headerKey = peekEnvKey(0, 7);
    const picker = (mirror.peekSwitches ?? []).find(
      (p) => p.id === "rohcHeader",
    );
    expect(picker).toBeDefined();

    // The picker MUST offer the IR-packet value (126) AND a synthetic default
    // case (value != 126) that reaches the RFC 5795 normal-datagram form.
    const values = picker!.cases.map((c) => c.value);
    expect(values).toContain(126);
    const defaultCase = picker!.cases.find((c) => c.value !== 126);
    expect(defaultCase).toBeDefined();
    expect(defaultCase!.value).not.toBe(126);

    // On load the diagram must show the most basic (normal-datagram) shape,
    // NOT the IR-packet body: `initialState` must not seed 126.
    const seeded = initialState(mirror)[headerKey];
    expect(seeded).not.toBe(126);
    expect(allCellIds(initialState(mirror))).toContain("rohcNormalDatagram");

    // Picking the IR value reveals the IR-packet body and hides the datagram.
    const ir = allCellIds({ [headerKey]: 126 });
    expect(ir).toContain("rohcPacketType");
    expect(ir).toContain("rohcProfile");
    expect(ir).toContain("rohcCrc");
    expect(ir).not.toContain("rohcNormalDatagram");

    // Picking the default-case value drives the diagram back to the
    // normal-datagram form — both layouts are reachable from the one control.
    const datagram = allCellIds({ [headerKey]: defaultCase!.value });
    expect(datagram).toContain("rohcNormalDatagram");
    expect(datagram).not.toContain("rohcPacketType");
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
