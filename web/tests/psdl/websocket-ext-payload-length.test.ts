// override-audit: websocketFrame's top-level switch `byPayloadLength7` inserts
// an Extended Payload Length field — case 126 → 16-bit `extPayloadLength16`,
// case 127 → 64-bit `extPayloadLength64`, default → nothing — yet the mirror
// surfaced ZERO control. The discriminator `payloadLength7` is 7-bit AND nested
// inside the `wsByte2` group (no top-level cell to host a `switchCases` widget),
// and `collectRefSwitches`' encoder gate suppressed it twice over: `payloadLength7`
// is `lengthDriving` (the trailing `payload` width reads it) and it is sub-byte
// with `category:"length"` arms. So an imported 126/127 frame rendered an
// Extended-Length cell the user could SEE but never toggle off or reach — a
// see-but-cannot-edit gap (bar #1).
//
// Fix: a TOP-LEVEL (non-repeat) group/case-nested length-extension switch whose
// arms add fixed-width Extended-Length cells of STRUCTURALLY DISTINCT WIDTH
// (16 vs 64 vs empty) is exempt from the encoder suppression and surfaces a
// packet-level refSwitch keyed on `env[payloadLength7]` (cases 126/127 + a
// synthetic default that reaches the empty `_` arm). The repeat-nested CoAP /
// BGP length encoders keep their suppression untouched.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

function cellIds(
  psdl: PsdlPacket,
  overrides: Record<string, number>,
): string[] {
  const env = new Map<string, number>(Object.entries(overrides));
  for (const [k, v] of initialEnv(psdl)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  return resolveLayout(psdl, { env }).cells.flatMap((c) => [
    c.field.id,
    ...(c.subCells ?? []).map((s) => s.subfield.id),
  ]);
}

describe("websocketFrame Extended Payload Length switch", () => {
  const psdl = PRESETS["websocketFrame"] as PsdlPacket;

  it("surfaces a packet-level refSwitch on payloadLength7", () => {
    const mirror = psdlToRenderer(psdl);
    const rs = mirror.refSwitches?.find((r) => r.refKey === "payloadLength7");
    expect(rs).toBeDefined();
    const values = new Set(rs!.cases.map((c) => c.value));
    // The two RFC-defined magic values…
    expect(values.has(126)).toBe(true);
    expect(values.has(127)).toBe(true);
    // …plus a synthetic option that reaches the empty `_` default arm (so the
    // extended cell can be toggled OFF), landing on neither 126 nor 127.
    expect(rs!.cases.length).toBe(3);
    const synthetic = rs!.cases.find((c) => c.value !== 126 && c.value !== 127);
    expect(synthetic).toBeDefined();
  });

  it("the discriminator keeps its refSwitch AND earns an inline length slider", () => {
    const mirror = psdlToRenderer(psdl);
    // `payloadLength7` is BOTH the 126/127 escape discriminator (the refSwitch
    // above) AND the inline 0..125 payload length (the `_` branch of the
    // `bytes(cond …)` width returns it verbatim). It therefore ALSO surfaces a
    // length controller — but capped at 125 so dragging it can never snap into an
    // extended-length arm (that is the refSwitch's job). The cap is what keeps the
    // two controls from fighting: the slider owns 0..125, the picker owns
    // {0,126,127}. (cond-width payload audit.)
    const inline = mirror.lengthControllers?.find(
      (l) => l.id === "payloadLength7",
    );
    expect(inline).toBeDefined();
    expect(inline!.controlsLength).toBe("payloadLength7");
    expect(inline!.max).toBe(125);
    // The refSwitch is untouched — it is still the only control offering 126/127.
    expect(mirror.refSwitches?.some((r) => r.refKey === "payloadLength7")).toBe(
      true,
    );
  });

  it("selecting 126/127/default flips the Extended Length cell on the diagram", () => {
    const extCells = (overrides: Record<string, number>) =>
      cellIds(psdl, overrides).filter((id) =>
        id.startsWith("extPayloadLength"),
      );

    // Default (0..125): no Extended Length field.
    expect(extCells({})).toEqual([]);
    expect(extCells({ payloadLength7: 0 })).toEqual([]);

    // 126 → the 16-bit Extended Length.
    expect(extCells({ payloadLength7: 126 })).toContain("extPayloadLength16");
    expect(extCells({ payloadLength7: 126 })).not.toContain(
      "extPayloadLength64",
    );

    // 127 → the 64-bit Extended Length.
    expect(extCells({ payloadLength7: 127 })).toContain("extPayloadLength64");
    expect(extCells({ payloadLength7: 127 })).not.toContain(
      "extPayloadLength16",
    );
  });

  it("the refSwitch's synthetic default value selects the empty (no extended length) arm", () => {
    const mirror = psdlToRenderer(psdl);
    const rs = mirror.refSwitches!.find((r) => r.refKey === "payloadLength7")!;
    const synthetic = rs.cases.find((c) => c.value !== 126 && c.value !== 127)!;
    const ext = cellIds(psdl, { payloadLength7: synthetic.value }).filter(
      (id) => id.startsWith("extPayloadLength"),
    );
    expect(ext).toEqual([]);
  });
});

// override-audit (cond-width payload): websocketFrame's Payload Data width is a
// `bytes(cond payloadLength7==126 ? extPayloadLength16 : (payloadLength7==127 ?
// extPayloadLength64 : payloadLength7))`. A node probe (set env, re-resolveLayout)
// confirms each of the three refs moves the diagram, yet before this fix NONE of
// them earned a usable control: `payloadLength7` surfaced only as a refSwitch with
// the discrete {0,126,127} cases (so the inline 1..125 length could not be set,
// only snapped to 0), and `extPayloadLength16`/`extPayloadLength64` lived inside
// the switch arms with NO mirror entry at all (not in fields, lengthControllers,
// or refSwitch seeds). The user could SEE the Payload Data + Extended-Length cells
// but could not change the payload length — the most important editable quantity
// in the frame (see-but-cannot-edit, bar #1).
//
// Fix: `collectCondWidthLengthControllers` walks the `bytes(cond …)` width and
// surfaces a length controller per leaf ref. extPayloadLength16/64 gate on their
// own cell's render state (live only in the 126/127 arm); payloadLength7 keeps its
// refSwitch for the magic values AND earns an inline slider capped at 125.
describe("websocketFrame cond-width payload length controllers", () => {
  const psdl = PRESETS["websocketFrame"] as PsdlPacket;

  // The variable-length payload renders as one diagram cell PER unit, so its
  // visual extent is the count of `payload` cells (each `c.bits` is undefined for
  // a variable cell — count, don't sum).
  function payloadCells(overrides: Record<string, number>): number {
    const env = new Map<string, number>(Object.entries(overrides));
    for (const [k, v] of initialEnv(psdl)) if (!env.has(k)) env.set(k, v);
    for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
    return resolveLayout(psdl, { env }).cells.filter(
      (c) => c.field.id === "payload",
    ).length;
  }

  it("surfaces a length controller for each of the three width-driving refs", () => {
    const mirror = psdlToRenderer(psdl);
    const ids = new Set((mirror.lengthControllers ?? []).map((l) => l.id));
    expect(ids.has("payloadLength7")).toBe(true);
    expect(ids.has("extPayloadLength16")).toBe(true);
    expect(ids.has("extPayloadLength64")).toBe(true);
  });

  it("each surfaced controller carries controlsLength keyed on its own env id", () => {
    const mirror = psdlToRenderer(psdl);
    for (const id of [
      "payloadLength7",
      "extPayloadLength16",
      "extPayloadLength64",
    ]) {
      const lc = mirror.lengthControllers!.find((l) => l.id === id)!;
      expect(lc.controlsLength).toBe(id);
    }
  });

  it("the extended-length controllers actually move the diagram in their arm", () => {
    // 126 arm: raising env[extPayloadLength16] shrinks the payload.
    const big = payloadCells({ payloadLength7: 126 });
    const small = payloadCells({ payloadLength7: 126, extPayloadLength16: 40 });
    expect(small).toBeLessThan(big);
    // 127 arm: env[extPayloadLength64] likewise drives the payload width.
    const big64 = payloadCells({
      payloadLength7: 127,
      extPayloadLength64: 200,
    });
    const small64 = payloadCells({
      payloadLength7: 127,
      extPayloadLength64: 80,
    });
    expect(small64).toBeLessThan(big64);
  });

  it("the inline payloadLength7 slider drives the inline payload and is capped below the magic values", () => {
    const mirror = psdlToRenderer(psdl);
    const inline = mirror.lengthControllers!.find(
      (l) => l.id === "payloadLength7",
    )!;
    // Capped at the smallest magic literal (126) minus 1, so the slider stays in
    // the inline range and can never flip the diagram into an extended arm.
    expect(inline.max).toBe(125);
    // Within the inline range the payload width tracks the value.
    expect(payloadCells({ payloadLength7: 20 })).toBeGreaterThan(
      payloadCells({ payloadLength7: 10 }),
    );
  });
});
