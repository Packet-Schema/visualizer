// `isLikelyChainRepeat` detects a forward-linked extension-header chain from
// the AST SHAPE (the Switch dispatches on a `ref` that each case redefines),
// not from a `*_chain` id convention — so it generalises to any forward-linked
// chain regardless of naming and never mistakes a TLV catalog for a chain.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { isLikelyChainRepeat } from "@/lib/psdl/psdl-to-renderer/chain";
import { psdlToRenderer, rendererToPsdl } from "@/lib/psdl/psdl-to-renderer";
import { validatePsdlPacket } from "@/lib/psdl/validate";
import { fromJson, toJson } from "@/lib/formats/json";
import type { Repeat } from "@/lib/psdl/types";

function repeatFrom(body: unknown): Repeat {
  const r = (body as { body: unknown[] }).body.find(
    (c): c is Repeat => (c as { kind?: string }).kind === "repeat",
  );
  if (!r) throw new Error("no top-level repeat");
  return r;
}

describe("isLikelyChainRepeat (structural)", () => {
  it("detects the IPv6 chain by shape", () => {
    expect(isLikelyChainRepeat(repeatFrom(PRESETS.ipv6!))).toBe(true);
  });

  it("does NOT treat a peek-dispatched TLV catalog as a chain", () => {
    // ipv4's options repeat is `Repeat<Switch on peek>` — a TLV, not a chain.
    const ipv4Options = (() => {
      const find = (cs: unknown[]): Repeat | null => {
        for (const c of cs as Array<Record<string, unknown>>) {
          if (c.kind === "repeat") return c as unknown as Repeat;
          if (c.kind === "bounded") {
            const hit = find(c.fields as unknown[]);
            if (hit) return hit;
          }
        }
        return null;
      };
      return find(PRESETS.ipv4!.body);
    })();
    expect(ipv4Options && isLikelyChainRepeat(ipv4Options)).toBe(false);
  });

  it("detects a forward-linked repeat even when NOT named *_chain", () => {
    // Same shape as IPv6 (switch on ref(np), each case redefines np) but the
    // repeat id has no "chain" in it — naming-based detection would miss this.
    const repeat = {
      kind: "repeat",
      id: "extHeaders",
      count: "eos",
      element: {
        id: "rec",
        fields: [
          {
            kind: "switch",
            id: "byNp",
            on: { kind: "ref", field: "np" },
            cases: {
              "0": {
                id: "a",
                fields: [
                  { id: "np", name: "Next", type: { kind: "bits", n: 8 } },
                ],
              },
            },
          },
        ],
      },
    } as unknown as Repeat;
    expect(isLikelyChainRepeat(repeat)).toBe(true);
  });

  it("does NOT treat a ref-switch whose discriminator is a sibling (not redefined) as a chain", () => {
    // TLV-with-explicit-kind: the discriminator is a sibling field, read once,
    // never redefined inside the cases → not a forward-linked chain.
    const repeat = {
      kind: "repeat",
      id: "records",
      count: "eos",
      element: {
        id: "rec",
        fields: [
          {
            kind: "switch",
            id: "byKind",
            on: { kind: "ref", field: "kind" },
            cases: {
              "1": {
                id: "a",
                fields: [
                  { id: "payload", name: "P", type: { kind: "bits", n: 8 } },
                ],
              },
            },
          },
        ],
      },
    } as unknown as Repeat;
    expect(isLikelyChainRepeat(repeat)).toBe(false);
  });
});

// The rendererToPsdl lift (the source-less export/share fallback) used to
// discriminate the chain Switch on a synthetic `${baseId}_proto` id that NO
// case re-declared, while each case kept the ORIGINAL discriminator (`nextHeader`).
// After one lift the two ids diverged, so `isLikelyChainRepeat` returned false
// on re-import and the chain degraded into a TLV — silently dropping the user's
// chosen extension headers (chainInstances) and the terminal Next-Header
// (chainFinalProto). The existing tests above only check the ORIGINAL preset;
// this pins the LIFTED form (bar #2 lossless round-trip, bar #1 stable surface).
describe("chain survives the rendererToPsdl lift → re-import", () => {
  it("keeps PRESETS.ipv6 a chain (not a TLV) and preserves chain selections", () => {
    const mirror = psdlToRenderer(PRESETS.ipv6!);
    const chain = mirror.fields.find((f) => f.chainCatalog);
    expect(chain, "ipv6 mirror should carry a chain catalog").toBeTruthy();

    // User picks a heterogeneous extension-header chain + a terminal proto.
    chain!.chainInstances = [{ proto: 43 }, { proto: 44 }];
    chain!.chainFinalProto = 59;

    // Source-less export/share fallback, then a full JSON round-trip (what a
    // recipient does on re-import).
    const lifted = rendererToPsdl(mirror);
    expect(() => validatePsdlPacket(lifted)).not.toThrow();
    const { packet: reimported } = fromJson(toJson(lifted, new Map()));

    const m2 = psdlToRenderer(reimported);
    const chain2 = m2.fields.find((f) => f.chainCatalog);
    const tlv2 = m2.fields.find((f) => f.tlv);

    // Still a chain, NOT misdetected as a TLV.
    expect(
      chain2,
      "lifted ipv6 must still expose a chain catalog",
    ).toBeTruthy();
    expect(tlv2, "lifted ipv6 must NOT degrade into a TLV").toBeFalsy();

    // The chain selections round-trip losslessly.
    expect(chain2!.chainInstances).toEqual([{ proto: 43 }, { proto: 44 }]);
    expect(chain2!.chainFinalProto).toBe(59);
  });

  it("the lifted chain Switch discriminates on the same id every case re-declares", () => {
    // The structural signature `isLikelyChainRepeat` keys on: the Switch `on`
    // ref must be a field that EACH case redefines. Assert it directly on the
    // lifted Repeat so a future refactor that re-introduces a synthetic
    // discriminator id is caught immediately.
    const mirror = psdlToRenderer(PRESETS.ipv6!);
    const lifted = rendererToPsdl(mirror);
    const repeat = lifted.body.find(
      (c): c is Repeat => (c as { kind?: string }).kind === "repeat",
    );
    expect(
      repeat,
      "lifted ipv6 body should contain a chain repeat",
    ).toBeTruthy();
    expect(isLikelyChainRepeat(repeat!)).toBe(true);
  });
});
