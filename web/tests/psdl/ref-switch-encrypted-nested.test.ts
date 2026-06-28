// Regression: a Switch whose discriminator is a field declared inside an
// `encrypted` block's plaintext that the diagram renders as OPAQUE ciphertext
// must surface NO override control — surfacing one would be a permanently-inert
// picker that contradicts the opaque blob the diagram shows.
//
// QUIC's `quicLong` / `quicShort` presets carry an `encrypted` payload with a
// FIXED `wireBits` footprint (136 bits) whose plaintext is `field frameType
// (bits:8)` followed by `switch frameByType on ref(frameType)` with cases
// 6=CRYPTO Data / 2,3=ACK Ranges / 8-15=Stream Data / _=Frame Payload.
//
// Because `wireBits` is set, `resolveLayout` renders the node as an OPAQUE
// ciphertext blob in the default (wire) view — the plaintext `frameByType`
// switch is never instantiated, so the CRYPTO/ACK/STREAM frame-body cells never
// appear and EVERY frameType value yields a byte-identical diagram. A
// `frameType` refSwitch picker would therefore be permanently inert: a visible
// Stream/Crypto/Ack control with no possible effect, its label contradicting the
// opaque payload the diagram shows. It must NOT be surfaced.
//
// Fix: `collectEncryptedNestedFieldIds` (and the `collectPeekSwitches` encrypted
// descent) skip the plaintext of an opaque (`wireBits`-bounded) encrypted node,
// so its discriminators are never collected and no refSwitch/peek picker leaks.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

/** Body cell + sub-cell ids the DEFAULT (wire) diagram resolves for a given env,
 *  the way the live app derives it (initialEnv defaults, then a 0-fill for every
 *  ref). The QUIC encrypted payload renders as opaque ciphertext in wire view. */
function wireCells(
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

describe("opaque encrypted plaintext discriminator surfaces NO refSwitch", () => {
  for (const key of ["quicLong", "quicShort"] as const) {
    describe(key, () => {
      const psdl = PRESETS[key]!;

      it("does NOT surface a frameType refSwitch picker", () => {
        const m = psdlToRenderer(psdl);
        // The discriminator is NOT a top-level mirror cell (it lives inside the
        // opaque encrypted plaintext)...
        expect(m.fields.find((f) => f.id === "frameType")).toBeUndefined();
        // ...and it must surface NO packet-level picker on any path: the diagram
        // renders the payload as opaque ciphertext, so a picker would be inert.
        const refKeys = (m.refSwitches ?? []).map((r) => r.refKey);
        expect(refKeys).not.toContain("frameType");
        const peekKeys = (m.peekSwitches ?? []).map((p) => p.peekKey);
        expect(peekKeys.some((k) => k.includes("frameType"))).toBe(false);
      });

      it("the frame switch is genuinely inert in the rendered (wire) diagram", () => {
        // Justifies the suppression: in the default (wire) view the diagram
        // renders opaque `payload` ciphertext cells and ZERO frame-body cells,
        // identical for every frameType — so no picker over frameType could ever
        // change it.
        const layouts = [2, 6, 8].map((ft) =>
          wireCells(psdl, { frameType: ft }),
        );
        for (const ids of layouts) {
          expect(
            ids.some((id) =>
              /crypto_body|ack_body|stream_body|frame_body/.test(id),
            ),
          ).toBe(false);
        }
        expect(layouts[1]).toEqual(layouts[0]);
        expect(layouts[2]).toEqual(layouts[0]);
      });
    });
  }
});

describe("opaque-encrypted-nested switches stay suppressed regardless of arm shape", () => {
  // A switch on a discriminator inside an opaque (`wireBits`-bounded) encrypted
  // node is suppressed whether its arms are byte-identical or distinct: the
  // diagram never instantiates the plaintext, so no value can change anything.
  function opaqueWith(
    caseAName: string,
    caseBName: string,
    caseABits: number,
    caseBBits: number,
  ): PsdlPacket {
    return {
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
                      {
                        id: "x0",
                        name: caseAName,
                        type: { kind: "bits", n: caseABits },
                      },
                    ],
                  },
                  "1": {
                    id: "b",
                    fields: [
                      {
                        id: "x1",
                        name: caseBName,
                        type: { kind: "bits", n: caseBBits },
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
      ],
    } as unknown as PsdlPacket;
  }

  it("suppresses a picker whose arms are byte-identical AND identically named", () => {
    const m = psdlToRenderer(opaqueWith("Body", "Body", 8, 8));
    expect((m.refSwitches ?? []).some((r) => r.refKey === "disc")).toBe(false);
  });

  it("suppresses a picker even when its arms differ (opaque blob hides them)", () => {
    // The pre-fix behaviour surfaced a name-only-distinct picker here. Now the
    // opaque-ciphertext exclusion suppresses it unconditionally — the plaintext
    // never renders, so neither a relabel nor a width change is observable.
    const m = psdlToRenderer(opaqueWith("Alpha", "Beta", 8, 24));
    expect((m.refSwitches ?? []).some((r) => r.refKey === "disc")).toBe(false);
  });
});
