// bgpUpdateFull: the BGP Extended-Length flag (`attrExtLen`) was see-but-cannot-
// edit. Each bgpPathAttributes record carries a switch (`bgpAttrLengthByExt`) on
// the 1-bit `attrExtLen` flags bit: case 1 → the 16-bit `bgpAttrLength16`, default
// (`_`, flag cleared) → the 8-bit `bgpAttrLength8`. The blanket sub-byte
// length-encoder heuristic (AND `lengthDriving`, since the flag reads into the
// bounded Attribute Value scope) suppressed the switch from the override mirror,
// so the user could SEE the flag bit and the Attribute Length cell but had no
// control to toggle the 1-byte vs 2-byte encoding.
//
// This is the same Extended-Length discriminator class as the already-surfaced
// top-level coap `coapSigLen` / websocket `payloadLength7` nibbles, but expressed
// as a flags BIT inside the per-record `bgpPathAttributes` repeat. The fix
// surfaces it as a refSwitch keyed on env[attrExtLen] via a narrow
// repeat-nested-Extended-Length-flag relaxation (1-bit `flags` discriminator, all
// arms a length int at ≥ 2 distinct widths), with the cleared-flag value-0 case
// ordered first so the load diagram (flag cleared → 8-bit length) agrees.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { initialState } from "@/lib/psdl/renderer-helpers";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

// Cell ids the way the live app renders them: layer the renderer's initialState
// seeds UNDER the explicit overrides, then initialEnv + psdlRefs 0-fill, then
// resolveLayout. bgpPathAttributes is instantiated to 1 so a representative
// Attribute record (its attrExtLen flag and length cell) renders.
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

describe("bgpUpdateFull: Extended-Length flag (attrExtLen) is editable", () => {
  it("surfaces attrExtLen as a refSwitch with both encodings, value 0 first", () => {
    const mirror = psdlToRenderer(PRESETS.bgpUpdateFull!);
    const rs = (mirror.refSwitches ?? []).find(
      (r) => r.refKey === "attrExtLen",
    );
    expect(
      rs,
      "attrExtLen Extended-Length flag picker must be surfaced",
    ).toBeTruthy();

    const values = rs!.cases.map((c) => c.value);
    expect(values).toContain(0); // cleared flag → 8-bit length
    expect(values).toContain(1); // set flag → 16-bit length
    // The load diagram renders with the flag cleared, so the value-0 case must be
    // FIRST (initialState seeds env[attrExtLen] = cases[0].value).
    expect(values[0]).toBe(0);
  });

  it("renders the flag bit and the 1-byte length at load (flag cleared)", () => {
    const ids = appCellIdsSeeded(PRESETS.bgpUpdateFull!, {
      bgpPathAttributes: 1,
    });
    // The 1-bit flag is a visible subcell of the Attribute Flags byte.
    expect(ids).toContain("attrExtLen");
    // With the flag cleared the 8-bit Attribute Length renders, not the 16-bit.
    expect(ids.some((i) => i.startsWith("bgpAttrLength8"))).toBe(true);
    expect(ids.some((i) => i.startsWith("bgpAttrLength16"))).toBe(false);
  });

  it("toggling attrExtLen swaps bgpAttrLength8 <-> bgpAttrLength16", () => {
    const cleared = appCellIdsSeeded(PRESETS.bgpUpdateFull!, {
      bgpPathAttributes: 1,
      attrExtLen: 0,
    });
    const set = appCellIdsSeeded(PRESETS.bgpUpdateFull!, {
      bgpPathAttributes: 1,
      attrExtLen: 1,
    });
    expect(cleared.some((i) => i.startsWith("bgpAttrLength8"))).toBe(true);
    expect(cleared.some((i) => i.startsWith("bgpAttrLength16"))).toBe(false);
    expect(set.some((i) => i.startsWith("bgpAttrLength16"))).toBe(true);
    expect(set.some((i) => i.startsWith("bgpAttrLength8"))).toBe(false);
    // Not an inert dropdown: the two values render distinct diagrams.
    expect(set).not.toEqual(cleared);
  });

  it("leaves coap and lwm2m record-variant pickers unchanged", () => {
    // The flag relaxation is narrow (1-bit `flags`, all-length arms). coap's
    // `optDelta` (a 4-bit `length` nibble) and lwm2m's `tlvIdLen` (a variant
    // selector) are surfaced by their own paths, and coap `optLength` stays a
    // length controller — none of them gains or loses surfacing from this fix.
    const coap = psdlToRenderer(PRESETS.coap!);
    const coapKeys = (coap.refSwitches ?? []).map((r) => r.refKey);
    expect(coapKeys).toContain("optDelta");
    expect(coapKeys).not.toContain("optLength");

    const lwm2m = psdlToRenderer(PRESETS.lwm2mRegister!);
    const lwm2mKeys = (lwm2m.refSwitches ?? []).map((r) => r.refKey);
    expect(lwm2mKeys).toContain("tlvIdLen");
  });
});
