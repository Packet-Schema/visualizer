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
// eap's `eapCode` is the COUNTER-example: its selectable arms 1 / 2 are
// identical (`enum(8)` + `bytes(eapLength - 5)`), but its `_` default arm
// (`eapNoBody`) is EMPTY, so codes 3 / 4 (Success / Failure, which fall into
// `_`) drop the entire EAP body. The diagram visibly gains / loses the body as
// `eapCode` changes, so the picker is NOT inert and MUST be surfaced.

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

  it("DOES stamp switchCases on eap's eapCode (its `_` arm differs)", () => {
    // The selectable arms 1 / 2 are identical, but the `_` default arm
    // (eapNoBody) is empty — codes 3 / 4 drop the whole EAP body. The picker is
    // meaningful and must be surfaced, not suppressed.
    const eap = psdlToRenderer(PRESETS.eap!);
    const code = findField(eap.fields, "eapCode");
    expect(code, "eapCode field must exist").toBeTruthy();
    const values = (code!.switchCases ?? []).map((c) => c.value);
    expect(values).toContain(1);
    expect(values).toContain(2);
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

  it("the surfaced eapCode picker meaningfully drives the diagram", () => {
    // Justify surfacing it: the two selectable arms 1 / 2 share a layout, but a
    // value that falls into the empty `_` default arm (3 = Success / 4 =
    // Failure) drops the entire EAP body, so the diagram shrinks. The picker is
    // NOT inert — driving eapCode changes the cell geometry.
    const src = PRESETS.eap!;
    const withBody = appGeometry(src, { eapCode: 1, eapLength: 16 });
    const responseBody = appGeometry(src, { eapCode: 2, eapLength: 16 });
    const noBody = appGeometry(src, { eapCode: 3, eapLength: 16 });
    // Request and Response arms are identical shape.
    expect(JSON.stringify(responseBody)).toBe(JSON.stringify(withBody));
    // The `_` (Success / Failure) arm yields a strictly smaller layout.
    expect(noBody.length).toBeLessThan(withBody.length);
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
