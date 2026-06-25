// `isLikelyChainRepeat` detects a forward-linked extension-header chain from
// the AST SHAPE (the Switch dispatches on a `ref` that each case redefines),
// not from a `*_chain` id convention — so it generalises to any forward-linked
// chain regardless of naming and never mistakes a TLV catalog for a chain.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { isLikelyChainRepeat } from "@/lib/psdl/psdl-to-renderer/chain";
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
