// coap: the `options` until-peek repeat (surfaced as a freeRepeat with a count
// stepper) contains a group `optHeaderByte` whose 4-bit `optDelta` nibble selects
// the Option-Delta extension encoding via the `byOptDelta` switch-on-ref:
// optDelta==13 inserts the 8-bit `optDeltaExt1`, optDelta==14 inserts the 16-bit
// `optDeltaExt2`, every other value (the literal 0..12) inserts nothing. With the
// option record visible (defaultCount 1) the `optDelta` cell renders and driving
// the nibble to 13/14 visibly ADDS the extension byte(s) to the diagram — yet the
// blanket sub-byte length-encoder heuristic suppressed `byOptDelta` from the
// mirror entirely (no refSwitch / switchCases / length controller), leaving the
// option-delta cell and its extension bytes see-but-cannot-edit. This is the same
// extended-nibble class as coapSignaling `coapSigLen` / websocketFrame
// `payloadLength7`, but living INSIDE a plain repeat.
//
// The fix relaxes ONLY the sub-byte heuristic (never `lengthDriving`) for a
// repeat-nested extended-nibble switch whose discriminator sizes nothing
// (not in `lengthDriving`, not a surfaced length controller) and whose arms carry
// distinct fixed widths, surfacing a packet-level refSwitch keyed on env[optDelta].

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { initialState } from "@/lib/psdl/renderer-helpers";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

// Cell ids the way the live app renders them: PacketViewer layers the renderer's
// `initialState` seeds UNDER the explicit overrides, then `initialEnv` +
// `psdlRefs` 0-fill, then `resolveLayout`. The `initialState` layer is what makes
// the load diagram faithful (e.g. the repeat-path refSwitch leaves env[optDelta]
// at 0, the literal/no-extension state).
function appCellIdsSeeded(
  psdl: PsdlPacket,
  overrides: Record<string, number>,
): string[] {
  const mirror = psdlToRenderer(psdl);
  const env = new Map<string, number>(Object.entries(overrides));
  const state = initialState(mirror);
  for (const [k, v] of Object.entries(state))
    if (!env.has(k)) env.set(k, Number(v));
  for (const [k, v] of initialEnv(psdl)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  return resolveLayout(psdl, { env }).cells.flatMap((c) => [
    c.field.id,
    ...(c.subCells ?? []).map((s) => s.subfield.id),
  ]);
}

describe("coap: option Delta extended-encoding (optDelta) is editable", () => {
  it("surfaces byOptDelta as a refSwitch keyed on env[optDelta]", () => {
    const mirror = psdlToRenderer(PRESETS.coap!);

    const rs = (mirror.refSwitches ?? []).find((r) => r.refKey === "optDelta");
    expect(
      rs,
      "byOptDelta (optDelta extension picker) must be surfaced",
    ).toBeTruthy();
    expect(rs!.id).toBe("byOptDelta");

    // The picker must offer BOTH extension arms (13 → 1-byte ext, 14 → 2-byte
    // ext) AND a literal/no-extension state so the control is reversible and its
    // first option agrees with the load diagram (env[optDelta]=0).
    const values = rs!.cases.map((c) => c.value);
    expect(values).toContain(0);
    expect(values).toContain(13);
    expect(values).toContain(14);
    expect(values[0]).toBe(0); // first option == load (no extension)

    // The option record IS instantiable (the `options` until-peek repeat is a
    // freeRepeat with a count stepper), which is what makes the per-record delta
    // picker meaningful rather than moot.
    expect(
      (mirror.freeRepeats ?? []).some((r) => r.countKey === "options"),
    ).toBe(true);
  });

  it("does NOT surface optLength as a refSwitch (already a length controller)", () => {
    // The sibling `optLength` nibble has the identical extended-encoding switch
    // (`byOptLength`) but it sizes `optValue` and is already editable via its
    // surfaced length controller — surfacing it ALSO as a refSwitch would be a
    // redundant, length-desyncing control. The relaxation must skip it.
    const mirror = psdlToRenderer(PRESETS.coap!);
    const refKeys = (mirror.refSwitches ?? []).map((r) => r.refKey);
    expect(refKeys).not.toContain("optLength");
    expect((mirror.lengthControllers ?? []).map((lc) => lc.id)).toContain(
      "optLength",
    );
  });

  it("driving optDelta to 13/14 inserts the distinct-width extension cell", () => {
    const src = PRESETS.coap!;

    // Load default (initialState seed, no explicit optDelta) → literal, no ext.
    const base = appCellIdsSeeded(src, { options: 1 });
    expect(base).not.toContain("optDeltaExt1#0");
    expect(base).not.toContain("optDeltaExt2#0");

    // optDelta=13 → the 8-bit Delta Extended (1 B) cell appears.
    const d13 = appCellIdsSeeded(src, { options: 1, optDelta: 13 });
    expect(d13).toContain("optDeltaExt1#0");
    expect(d13).not.toContain("optDeltaExt2#0");

    // optDelta=14 → the 16-bit Delta Extended (2 B) cell appears.
    const d14 = appCellIdsSeeded(src, { options: 1, optDelta: 14 });
    expect(d14).toContain("optDeltaExt2#0");
    expect(d14).not.toContain("optDeltaExt1#0");

    // Distinct selections render distinct diagrams (not an inert dropdown) and
    // the literal value reverts to no extension (reversible control).
    expect(d13).not.toEqual(base);
    expect(d14).not.toEqual(d13);
    const literal = appCellIdsSeeded(src, { options: 1, optDelta: 0 });
    expect(literal).not.toContain("optDeltaExt1#0");
    expect(literal).not.toContain("optDeltaExt2#0");
  });

  it("keeps BGP attrExtLen (a bounded-scope length encoder) suppressed", () => {
    // Guard: the relaxation is bounded by `lengthDriving`. bgpUpdateFull's
    // `attrExtLen` flag drives a 1- vs 2-byte Attribute Length that sizes the
    // bounded Attribute Value scope — driving it as a variant would desync the
    // scope, so it must STAY an encoder (never a refSwitch).
    const bgp = psdlToRenderer(PRESETS.bgpUpdateFull!);
    const bgpRefKeys = (bgp.refSwitches ?? []).map((r) => r.refKey);
    expect(bgpRefKeys).not.toContain("attrExtLen");
  });
});
