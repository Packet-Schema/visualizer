// high: a `Switch` whose discriminator is a plain top-level field is stamped a
// `switchCases` dropdown by `attachOverrideMetadata` — a path that
// `collectRefSwitches`'s inert-arm gate never reaches. tlsHandshake's
// `handshakeType` has 11 arms, each a single `bytes(ref tlsHandshakeBodyLen)`
// opaque body; tlsHandshakeBodyLen has no length control, so every selectable
// arm AND the `_` default arm are structurally identical and choosing any value
// yields a byte-identical layout. That picker is an inert see-but-cannot-edit
// dropdown and must NOT be surfaced. `attachOverrideMetadata` suppresses a
// multi-option case picker whose every selectable arm is structurally identical
// AND whose `_` default arm (if present) matches that shape.
//
// eap's `eapCode` is a sharper case. Its listed arms 1 / 2 are identical
// (`eapType` + `eapTypeData`) and its `_` default arm (`eapNoBody`) is EMPTY, so
// codes 3 / 4 (Success / Failure) DO drop the body — but those values are NOT in
// the switch's case list, and a FIELD-LEVEL `switchCases` dropdown has no
// synthetic `_`-reaching option, so it can only ever offer 1 / 2 (identical) and
// can never reach the empty arm. The switch picker is therefore inert. `eapCode`
// is ALSO an `enum(8)` discriminator (1=Request 2=Response 3=Success 4=Failure)
// whose EnumDropdown writes the SAME `env[eapCode]` key and already drives every
// meaningful state, including the empty `_` body at 3 / 4. So the switch picker
// must be SUPPRESSED (no `switchCases`); the enum is the canonical single
// control. This is `listedArmsAllIdentical`: inert listed arms despite a
// differing `_` arm.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { initialState } from "@/lib/psdl/renderer-helpers";
import { seedDynamicWidthDefaults } from "@/lib/psdl/dynamic-width-defaults";
import { evalExprOr } from "@/lib/psdl/expr";
import type { Field as RendererField } from "@/lib/psdl/renderer";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

function findField(
  fields: RendererField[],
  id: string,
): RendererField | undefined {
  return fields.find((f) => f.id === id);
}

/**
 * App-realistic layout GEOMETRY signature: `initialState` (freeRepeat defaults
 * + refSwitch seeds) over `initialEnv` + 0-filled psdl refs + dynamic-width
 * seeds + the PacketViewer boundedRepeats count-derivation, then resolveLayout.
 * Captures each cell's rendered bit width / row span only — the picker is inert
 * iff every arm yields the same geometry (the per-arm opaque body shares one
 * `bytes(ref tlsHandshakeBodyLen)` shape; only the cell LABEL differs, and at
 * any reachable env the body is the same width for every value, so no value
 * changes the diagram's shape).
 */
function appGeometry(
  psdl: PsdlPacket,
  overrides: Record<string, number>,
): Array<[number, number, number]> {
  const mirror = psdlToRenderer(psdl);
  const env = new Map<string, number>(Object.entries(overrides));
  const state = initialState(mirror);
  for (const [k, v] of Object.entries(state))
    if (!env.has(k)) env.set(k, Number(v));
  for (const [k, v] of initialEnv(psdl)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  seedDynamicWidthDefaults(psdl, env);
  for (const br of mirror.boundedRepeats ?? []) {
    const budget = evalExprOr(br.bytesExpr, env, 0);
    const forRecords = Math.max(0, budget - br.prefixBytes);
    env.set(br.countKey, Math.floor(forRecords / br.perRecordBytes));
  }
  return resolveLayout(psdl, { env, viewMode: "semantic" }).cells.map((c) => [
    c.bitsTotal,
    c.startBit,
    c.endBit,
  ]);
}

describe("inert multi-option switchCases pickers are suppressed", () => {
  it("does not stamp switchCases on tlsHandshake's handshakeType", () => {
    const tls = psdlToRenderer(PRESETS.tlsHandshake!);
    const ht = findField(tls.fields, "handshakeType");
    expect(ht, "handshakeType field must exist").toBeTruthy();
    // The 10-option dropdown OverridePanel would render is gone.
    expect(ht!.switchCases).toBeUndefined();
    // And it didn't leak into refSwitches / freeRepeats instead.
    expect((tls.refSwitches ?? []).map((r) => r.refKey)).not.toContain(
      "handshakeType",
    );
    expect((tls.freeRepeats ?? []).map((r) => r.countKey)).not.toContain(
      "handshakeType",
    );
  });

  it("does NOT stamp switchCases on eap's eapCode (listed arms identical; enum is canonical)", () => {
    // Listed arms 1 / 2 are byte-identical and the field-level dropdown cannot
    // reach the diverging empty `_` arm (codes 3 / 4 are absent from the case
    // list), so the switch picker is inert. eapCode is ALSO an enum on the same
    // env key, which already reaches every meaningful state. The inert,
    // key-colliding switch picker must be suppressed; only the enum remains.
    const eap = psdlToRenderer(PRESETS.eap!);
    const code = findField(eap.fields, "eapCode");
    expect(code, "eapCode field must exist").toBeTruthy();
    expect(code!.switchCases).toBeUndefined();
    // The enum (the canonical single control for the key) is still present.
    expect(code!.enumVariants).toBeTruthy();
    expect(Object.keys(code!.enumVariants!)).toEqual(
      expect.arrayContaining(["1", "2", "3", "4"]),
    );
    // And it didn't leak into refSwitches / freeRepeats instead.
    expect((eap.refSwitches ?? []).map((r) => r.refKey)).not.toContain(
      "eapCode",
    );
    expect((eap.freeRepeats ?? []).map((r) => r.countKey)).not.toContain(
      "eapCode",
    );
  });

  it("the suppressed handshakeType picker is genuinely inert across all arms", () => {
    // Justify the suppression: drive handshakeType over every case value — both
    // at the default env AND with tlsHandshakeBodyLen forced to 8 (the only way
    // to give the opaque body any width) — and the cell signature never changes.
    // Each arm is the same single `bytes(ref tlsHandshakeBodyLen)` body, so the
    // picker could never change the diagram. (If it could, suppressing it would
    // be wrong; this asserts it cannot.)
    const src = PRESETS.tlsHandshake!;
    const values = [1, 2, 4, 5, 8, 11, 13, 15, 20, 24];
    for (const len of [0, 8]) {
      const baseline = JSON.stringify(
        appGeometry(src, {
          handshakeType: values[0]!,
          tlsHandshakeBodyLen: len,
        }),
      );
      for (const ht of values.slice(1)) {
        expect(
          JSON.stringify(
            appGeometry(src, { handshakeType: ht, tlsHandshakeBodyLen: len }),
          ),
          `handshakeType=${ht} at bodyLen=${len} must not change the diagram`,
        ).toBe(baseline);
      }
    }
  });

  it("the suppressed eapCode switch picker is genuinely inert across its listed arms", () => {
    // Justify the suppression: the two LISTED arms 1 / 2 — the only values the
    // dropdown could ever offer — yield an identical layout, so the switch
    // picker could never change the diagram. (The diagram-changing distinction
    // lives at codes 3 / 4, which the switch list omits; the enum reaches them.)
    const src = PRESETS.eap!;
    const request = appGeometry(src, { eapCode: 1, eapLength: 16 });
    const response = appGeometry(src, { eapCode: 2, eapLength: 16 });
    expect(JSON.stringify(response)).toBe(JSON.stringify(request));
  });

  it("the eapCode enum (the surviving control) still drives the diagram", () => {
    // The enum reaches the empty `_` arm the switch picker could not: code 1
    // shows the EAP body (eapType present), code 3 (Success → `_`) drops it.
    const src = PRESETS.eap!;
    const withBody = appGeometry(src, { eapCode: 1, eapLength: 16 });
    const noBody = appGeometry(src, { eapCode: 3, eapLength: 16 });
    // Driving the single enum control adds / removes the body — a live diagram.
    expect(noBody.length).toBeLessThan(withBody.length);
    // Concretely: eapType is present at 1, absent at 3.
    const ids = (overrides: Record<string, number>): string[] => {
      const mirror = psdlToRenderer(src);
      const env = new Map<string, number>(Object.entries(overrides));
      const state = initialState(mirror);
      for (const [k, v] of Object.entries(state))
        if (!env.has(k)) env.set(k, Number(v));
      for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
      for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
      seedDynamicWidthDefaults(src, env);
      return resolveLayout(src, { env, viewMode: "semantic" }).cells.map(
        (c) => c.field.id,
      );
    };
    expect(ids({ eapCode: 1, eapLength: 16 })).toContain("eapType");
    expect(ids({ eapCode: 3, eapLength: 16 })).not.toContain("eapType");
  });

  it("keeps a multi-option picker whose arms differ (tftp opcode)", () => {
    // The positive counterpart: a Switch whose arms carry distinct shapes must
    // keep its picker. tftp's `opcode` dispatches RRQ/WRQ/DATA/ACK/ERROR onto
    // structurally different bodies, so its picker stays surfaced.
    const tftp = psdlToRenderer(PRESETS.tftp!);
    const opcode = findField(tftp.fields, "opcode");
    expect(opcode?.switchCases?.length).toBeGreaterThanOrEqual(2);
  });
});
