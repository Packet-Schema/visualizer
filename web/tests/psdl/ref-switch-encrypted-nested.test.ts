// Regression: a TOP-LEVEL Switch whose discriminator is a field declared inside
// a top-level `encrypted` block's plaintext (not inside a switch case, not
// inside a group, not inside a repeat) used to surface ZERO override control — a
// see-but-cannot-edit gap.
//
// QUIC's `quicLong` / `quicShort` presets carry a top-level `encrypted` payload
// whose plaintext is `field frameType (bits:8)` followed by
// `switch frameByType on ref(frameType)` with cases 6=CRYPTO Data /
// 2,3=ACK Ranges / 8-15=Stream Data / _=Frame Payload. In SEMANTIC view the
// encrypted plaintext expands and `resolveLayout` draws the selected frame body
// (the visible cell NAME changes: CRYPTO Data / ACK Ranges / Stream Data /
// Frame Payload), so the user clearly SEES the frame variant — yet `frameType`
// was never surfaced editably:
//   * `flattenForMirror` does NOT expose an encrypted-plaintext field as a
//     top-level renderer-mirror cell, so `attachOverrideMetadata` stamped no
//     `switchCases` widget on it;
//   * it is not in `collectSwitchCaseFieldIds` (the encrypted block is entered
//     with insideCase=false) nor in `collectGroupNestedFieldIds` (no group), so
//     the field-nested refSwitch path never qualified it.
// The discriminator therefore fell through every path: see-but-cannot-edit.
//
// CAVEAT the fix had to handle: the four QUIC frame arms are byte-identical
// (all `bits:128`, differing only by field id / NAME), so `switchArmsAllIdentical`
// returns true and the `allArmsIdentical` gate would wrongly suppress the picker.
// We relax that exactly as the snmpV2c/peek precedent does — when the arms
// render to the same geometry but differ ONLY by NAME, the picker is still a
// real, diagram-visible semantic edit (selecting it relabels the body cell), so
// it stays surfaced.
//
// Fix: `collectEncryptedNestedFieldIds` collects ids declared inside a top-level
// encrypted plaintext (excluding repeat / switch-case scopes), the field-nested
// refSwitch guard ORs it in, and `switchArmsDifferByNameOnly` keeps the picker
// alive when its arms differ only by name.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { initialState } from "@/lib/psdl/renderer-helpers";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

/** Body cell + sub-cell ids the SEMANTIC-view diagram resolves for a given env,
 *  the way the live app derives it (initialEnv defaults, then a 0-fill for every
 *  ref). The QUIC encrypted plaintext only expands in semantic view. */
function semanticCells(
  psdl: PsdlPacket,
  overrides: Record<string, number>,
): string[] {
  const env = new Map<string, number>(Object.entries(overrides));
  for (const [k, v] of initialEnv(psdl)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  return resolveLayout(psdl, { env, viewMode: "semantic" }).cells.flatMap(
    (c) => [c.field.id, ...(c.subCells ?? []).map((s) => s.subfield.id)],
  );
}

describe("encrypted-plaintext-nested switch discriminator surfaces a refSwitch", () => {
  for (const key of ["quicLong", "quicShort"] as const) {
    describe(key, () => {
      const psdl = PRESETS[key]!;

      it("surfaces a frameType refSwitch picker", () => {
        const m = psdlToRenderer(psdl);
        // The discriminator is NOT a top-level mirror cell and never carried a
        // switchCases widget — the gap this fixes.
        expect(m.fields.find((f) => f.id === "frameType")).toBeUndefined();
        const rs = (m.refSwitches ?? []).find((r) => r.refKey === "frameType");
        expect(
          rs,
          "a refSwitch keyed on the encrypted-nested `frameType` must be surfaced",
        ).toBeTruthy();
        // The listed frame types (CRYPTO=6, ACK=2, STREAM=8) are all selectable.
        const values = rs!.cases.map((c) => c.value);
        expect(values).toContain(6);
        expect(values).toContain(2);
        expect(values).toContain(8);
        // Distinct, readable labels (a relabel is the diagram-visible edit).
        expect(new Set(rs!.cases.map((c) => c.label)).size).toBe(
          rs!.cases.length,
        );
      });

      it("driving frameType changes the rendered body field id (semantic view)", () => {
        const atCrypto = semanticCells(psdl, { frameType: 6 });
        const atAck = semanticCells(psdl, { frameType: 2 });
        const atStream = semanticCells(psdl, { frameType: 8 });
        expect(atCrypto).toContain("crypto_body");
        expect(atAck).toContain("ack_body");
        expect(atStream).toContain("stream_body");
        // Each selection genuinely swaps the visible body cell — not inert.
        expect(atCrypto).not.toContain("ack_body");
        expect(atAck).not.toContain("stream_body");
        expect(atStream).not.toContain("crypto_body");
      });

      it("initialState seeds frameType to the picker's first case (a real frame on load)", () => {
        const m = psdlToRenderer(psdl);
        const rs = (m.refSwitches ?? []).find((r) => r.refKey === "frameType")!;
        const seeded = initialState(m).frameType;
        expect(seeded).toBe(rs.cases[0]!.value);
        // The load diagram shows the seeded frame's body, not an empty/default one.
        const loaded = semanticCells(psdl, { frameType: seeded });
        expect(loaded.some((id) => /_body$/.test(id))).toBe(true);
      });
    });
  }
});

describe("name-only-distinct arms keep the picker; truly inert arms stay suppressed", () => {
  // A switch on an encrypted-nested discriminator whose arms are byte-identical
  // AND identically named is inert — no picker (the diagram never changes).
  const inert: PsdlPacket = {
    name: "inert",
    rowBits: 32,
    body: [
      {
        kind: "encrypted",
        id: "enc",
        name: "Payload",
        wireBits: { kind: "lit", value: 16 },
        plaintext: {
          id: "pt",
          fields: [
            { id: "disc", name: "Disc", type: { kind: "bits", n: 8 } },
            {
              kind: "switch",
              id: "sw",
              on: { kind: "ref", field: "disc" },
              cases: {
                "0": {
                  id: "a",
                  fields: [
                    { id: "x0", name: "Body", type: { kind: "bits", n: 8 } },
                  ],
                },
                "1": {
                  id: "b",
                  fields: [
                    { id: "x1", name: "Body", type: { kind: "bits", n: 8 } },
                  ],
                },
              },
            },
          ],
        },
      },
    ],
  } as unknown as PsdlPacket;

  it("suppresses a picker whose arms are byte-identical AND identically named", () => {
    const m = psdlToRenderer(inert);
    expect((m.refSwitches ?? []).some((r) => r.refKey === "disc")).toBe(false);
  });
});
