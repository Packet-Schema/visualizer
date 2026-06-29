// override-audit (lispMapRequest AFI, fixed): a `bytes(lookup(ref X, table))`
// value's width is selected by a sibling INT discriminator X (LISP's
// `lispItrRlocAddr = bytes(lookup(ref lispItrRlocAfi, {0:0, 1:4, 2:16}))`; pgm's
// NLA addresses). X is a plain int — NOT an enum and NOT a Switch `on` — so it
// rendered as a visible cell with no enum dropdown and no Switch picker, and at
// the default env X=0 the looked-up width was 0: the user could SEE the AFI cell
// and an (empty) address region but could not change the AFI to switch address
// family. collectRefSwitches now surfaces a value-picker keyed on `env[X]` whose
// cases are the lookup table keys (labelled by byte width), and `initialState`
// seeds the first non-zero-width family so the address renders on load.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialState } from "@/lib/psdl/renderer-helpers";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

/** Build the load-time env exactly as PacketViewer does: the renderer mirror's
 *  `initialState` controllers, then the packet's declared defaults, then a 0
 *  fallback for any still-unset ref — then apply `overrides`. */
function loadEnv(
  pkt: PsdlPacket,
  overrides: Record<string, number> = {},
): Map<string, number> {
  const mirror = psdlToRenderer(pkt);
  const env = new Map<string, number>(
    Object.entries(initialState(mirror)).map(([k, v]) => [k, Number(v)]),
  );
  for (const [k, v] of initialEnv(pkt)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(pkt)) if (!env.has(r)) env.set(r, 0);
  for (const [k, v] of Object.entries(overrides)) env.set(k, v);
  return env;
}

/** Total bit width of the first instance of a field id, or 0 when no such cell
 *  renders. A wide value is split into several row-segment cells that all share
 *  the same id and each carry the FULL `bitsTotal`, so we read one (not a sum).
 *  A field collapsed into a Group surfaces as a sub-cell of the group cell
 *  (lispSrcEidAddr → `lispSourceEid:lispSrcEidAddr`), so sub-cells are scanned
 *  too. */
function fieldBits(
  pkt: PsdlPacket,
  env: Map<string, number>,
  id: string,
): number {
  for (const c of resolveLayout(pkt, { env }).cells) {
    if (c.field.id === id || c.field.id === `${id}#0`) {
      return c.bitsTotal;
    }
    for (const s of c.subCells ?? []) {
      if (s.subfield.id === id) return s.bitsTotal;
    }
  }
  return 0;
}

describe("lookup-discriminator AFI pickers (lispMapRequest / pgm)", () => {
  it("surfaces a refSwitch picker for each lookup-keyed int discriminator", () => {
    const mirror = psdlToRenderer(PRESETS["lispMapRequest"]!);
    const byKey = new Map(
      (mirror.refSwitches ?? []).map((rs) => [rs.refKey, rs]),
    );
    // The two repeat-nested AFI discriminators flagged by the probe, plus the
    // source-EID AFI (a group subfield with the same see-but-cannot-edit gap).
    for (const refKey of [
      "lispItrRlocAfi",
      "lispEidPrefixAfi",
      "lispSrcEidAfi",
    ]) {
      const rs = byKey.get(refKey);
      expect(rs, `refSwitch for ${refKey}`).toBeDefined();
      // Cases mirror the lookup table {0:0, 1:4, 2:16}; the first case is a
      // non-zero-width family so the seed reveals an address.
      expect(rs!.cases.map((c) => c.value)).toEqual([1, 2, 0]);
      expect(rs!.cases[0].label).toBe("4 bytes");
      expect(rs!.cases.find((c) => c.value === 0)?.label).toBe(
        "0 bytes (absent)",
      );
    }
  });

  it("seeds the first non-zero family so the address renders on load", () => {
    const pkt = PRESETS["lispMapRequest"]!;
    const seeded = initialState(psdlToRenderer(pkt));
    expect(seeded.lispItrRlocAfi).toBe(1);
    expect(seeded.lispEidPrefixAfi).toBe(1);
    expect(seeded.lispSrcEidAfi).toBe(1);
    const env = loadEnv(pkt);
    // IPv4 (AFI=1) → 4-byte (32-bit) address cells, not the old width-0 gap.
    expect(fieldBits(pkt, env, "lispItrRlocAddr")).toBe(32);
    expect(fieldBits(pkt, env, "lispEidPrefix")).toBe(32);
    expect(fieldBits(pkt, env, "lispSrcEidAddr")).toBe(32);
  });

  it("driving the AFI picker switches the rendered address family", () => {
    const pkt = PRESETS["lispMapRequest"]!;
    // AFI=2 (IPv6) → 16-byte (128-bit) address; AFI=0 → absent (width 0).
    expect(
      fieldBits(pkt, loadEnv(pkt, { lispItrRlocAfi: 2 }), "lispItrRlocAddr"),
    ).toBe(128);
    expect(
      fieldBits(pkt, loadEnv(pkt, { lispItrRlocAfi: 0 }), "lispItrRlocAddr"),
    ).toBe(0);
    expect(
      fieldBits(pkt, loadEnv(pkt, { lispEidPrefixAfi: 2 }), "lispEidPrefix"),
    ).toBe(128);
  });

  it("the AFI cell stays visible (the discriminator is never hidden)", () => {
    const pkt = PRESETS["lispMapRequest"]!;
    const env = loadEnv(pkt);
    expect(fieldBits(pkt, env, "lispItrRlocAfi")).toBe(16);
    expect(fieldBits(pkt, env, "lispEidPrefixAfi")).toBe(16);
  });

  it("pgm surfaces an AFI picker for each NLA discriminator", () => {
    const mirror = psdlToRenderer(PRESETS["pgm"]!);
    const keys = new Set((mirror.refSwitches ?? []).map((rs) => rs.refKey));
    for (const refKey of [
      "pgmSpmNlaAfi",
      "pgmNakSrcNlaAfi",
      "pgmNakGrpNlaAfi",
      "pgmNcfSrcNlaAfi",
      "pgmNcfGrpNlaAfi",
    ]) {
      expect(keys.has(refKey), `refSwitch for ${refKey}`).toBe(true);
    }
  });

  // pgm's NLA AFI pickers live inside the `pgmBody` switch's SPM/NAK/NCF arms
  // (`bytes(lookup(ref <afi>, {1:4, 2:16}))`). Unlike the real-Switch refSwitch
  // path, the lookup-picker path used to drop the enclosing `pgmType` case gate,
  // so `initialState` left pgmType at its first author-declared case (ODATA — a
  // case with NO NLA field) and ALL five AFI pickers loaded disabled, their
  // disable hint naming an inner field (pgmSpmNlaAfi) the user cannot set
  // directly (#11/#12). Each lookup picker now carries its arm's gate.
  it("pgm lookup AFI pickers carry their enclosing pgmType case gate", () => {
    const mirror = psdlToRenderer(PRESETS["pgm"]!);
    const byKey = new Map(
      (mirror.refSwitches ?? []).map((rs) => [rs.refKey, rs]),
    );
    // SPM=0, NAK=8, NCF=9 — each AFI picker gated on the arm it is declared in.
    const expected: Record<string, number> = {
      pgmSpmNlaAfi: 0,
      pgmNakSrcNlaAfi: 8,
      pgmNakGrpNlaAfi: 8,
      pgmNcfSrcNlaAfi: 9,
      pgmNcfGrpNlaAfi: 9,
    };
    for (const [refKey, caseValue] of Object.entries(expected)) {
      expect(byKey.get(refKey)?.gate, `gate for ${refKey}`).toEqual({
        key: "pgmType",
        value: caseValue,
      });
    }
  });

  it("the gated SPM AFI picker drives the pgmSpmNla address width", () => {
    const pkt = PRESETS["pgm"]!;
    const spmGate = (psdlToRenderer(pkt).refSwitches ?? []).find(
      (rs) => rs.refKey === "pgmSpmNlaAfi",
    )?.gate;
    expect(spmGate).toEqual({ key: "pgmType", value: 0 });
    // Selecting the SPM arm (pgmType = gate value) makes the lookup-keyed NLA a
    // real cell, and the AFI picker then drives its width: AFI=1 (IPv4) → 4-byte
    // (32-bit) address, AFI=2 (IPv6) → 16-byte (128-bit) address. Picking SPM is
    // exactly what the live pgmBody refSwitch picker (refKey=pgmType) does, so
    // the editing path the gate hint now points the user at is reachable.
    const spmEnv = (afi: number) =>
      loadEnv(pkt, { pgmType: spmGate!.value, pgmSpmNlaAfi: afi });
    expect(fieldBits(pkt, spmEnv(1), "pgmSpmNla")).toBe(32);
    expect(fieldBits(pkt, spmEnv(2), "pgmSpmNla")).toBe(128);
  });
});
