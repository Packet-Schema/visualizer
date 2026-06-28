// Audit gap (medium): two sibling `ref`s to the SAME `def` collided in the
// renderer mirror. `flattenForMirror` inlined a RefContainer's def fields into
// `mirror.fields` WITHOUT qualifying their ids by the ref id, so a body of
// `[ref addr as src, ref addr as dst]` produced mirror field ids
// `["a1","a2","a1","a2"]` (duplicates) while the diagram cells were correctly
// qualified (`src.a1`, `dst.a1`). Every editor lookup uses `Array.find()` on the
// bare id, so editing the SECOND ref instance always resolved onto the FIRST: a
// TLV record / byteOrder flip meant for `dst` landed on `src`, and merge wrote
// the single shared def once so both refs exported identically — the second ref
// was visible but could not be edited independently.
//
// The fix qualifies the inlined ids with the ref id
// (`flattenForMirrorQualified`, matching core's `<refId>.<fieldId>` cell-id
// scheme) so each ref instance owns a unique mirror field; apply-tlv /
// apply-chain / apply-byte-order mint qualified synthetic ids, and the lift
// (`mergeInstancesIntoPsdl`) forks a per-ref def clone so each instance's edits
// export onto its own def copy. No built-in preset has two refs to one def, so
// this is an arbitrary-PSDL gap.

import { describe, it, expect } from "vitest";

import { peek } from "@/lib/psdl/expr";
import {
  psdlToRenderer,
  applyTlvInstances,
  applyByteOrderOverrides,
  mergeInstancesIntoPsdl,
} from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import type {
  Container,
  NamedStruct,
  Packet as PsdlPacket,
} from "@/lib/psdl/types";

const bits = (n: number) => ({ kind: "bits" as const, n });

// body: [ ref addr as src, ref addr as dst ]; def addr = { a1:8, a2:8 }.
function mkAddrPacket(): PsdlPacket {
  const addr: NamedStruct = {
    id: "addr",
    fields: [
      { id: "a1", name: "Octet 1", type: bits(8) },
      { id: "a2", name: "Octet 2", type: bits(8) },
    ],
  } as unknown as NamedStruct;
  return {
    name: "TwoAddr",
    rowBits: 32,
    body: [
      { kind: "ref", id: "src", ref: "addr" },
      { kind: "ref", id: "dst", ref: "addr" },
    ],
    defs: { addr },
  } as unknown as PsdlPacket;
}

// body: [ ref opts as blk1, ref opts as blk2 ]; def opts = TLV repeat.
function mkTlvPacket(): PsdlPacket {
  const optsDef: NamedStruct = {
    id: "opts",
    fields: [
      {
        kind: "repeat",
        id: "opts",
        count: "eos",
        element: {
          id: "optStruct",
          fields: [
            {
              kind: "switch",
              id: "optSw",
              on: peek(8),
              cases: {
                "1": {
                  id: "optA",
                  name: "Opt A",
                  fields: [
                    { id: "aType", name: "A Type", type: bits(8) },
                    { id: "aVal", name: "A Value", type: bits(8) },
                  ],
                },
                "2": {
                  id: "optB",
                  name: "Opt B",
                  fields: [
                    { id: "bType", name: "B Type", type: bits(8) },
                    { id: "bVal", name: "B Value", type: bits(8) },
                  ],
                },
              },
            },
          ],
        },
      },
    ],
  } as unknown as NamedStruct;
  return {
    name: "TwoTlv",
    rowBits: 32,
    body: [
      { kind: "ref", id: "blk1", ref: "opts" },
      { kind: "ref", id: "blk2", ref: "opts" },
    ],
    defs: { opts: optsDef },
  } as unknown as PsdlPacket;
}

function renderCellIds(psdl: PsdlPacket): string[] {
  const env = new Map<string, number>();
  for (const [k, v] of initialEnv(psdl)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  return resolveLayout(psdl, { env }).cells.map((c) => c.field.id);
}

describe("two refs to one def edit independently (no mirror id collision)", () => {
  it("surfaces distinct, ref-qualified mirror fields (no duplicate ids)", () => {
    const mirror = psdlToRenderer(mkAddrPacket());
    const ids = mirror.fields.map((f) => f.id);
    // The bug produced ["a1","a2","a1","a2"]; the fix qualifies by ref id.
    expect(ids).toEqual(["src.a1", "src.a2", "dst.a1", "dst.a2"]);
    // And they match the diagram's cell ids exactly (key-shape parity).
    expect(new Set(renderCellIds(mkAddrPacket()))).toEqual(new Set(ids));
  });

  it("surfaces distinct TLV fields for two refs to the same TLV def", () => {
    const mirror = psdlToRenderer(mkTlvPacket());
    const tlvIds = mirror.fields.filter((f) => f.tlv).map((f) => f.id);
    // The bug produced ["opts","opts"]; the fix qualifies them.
    expect(tlvIds.sort()).toEqual(["blk1.opts", "blk2.opts"]);
  });

  it("a byteOrder flip on the SECOND ref does not touch the first", () => {
    const psdl = mkAddrPacket();
    const mirror = psdlToRenderer(psdl);
    // Flip dst.a1 only (the second ref instance).
    const dstA1 = mirror.fields.find((f) => f.id === "dst.a1")!;
    dstA1.byteOrder = "LE";
    mirror.byteOrderOverrides = { "dst.a1": "LE" };

    // Live diagram: only dst's a1 carries the flip, via a forked def clone.
    const laid = applyByteOrderOverrides(psdl, mirror);
    const srcRefName = (
      laid.body.find(
        (c): c is Extract<Container, { kind: "ref" }> =>
          "kind" in c && c.kind === "ref" && c.id === "src",
      ) as { ref: string }
    ).ref;
    const dstRefName = (
      laid.body.find(
        (c): c is Extract<Container, { kind: "ref" }> =>
          "kind" in c && c.kind === "ref" && c.id === "dst",
      ) as { ref: string }
    ).ref;
    // src still references the shared def; dst forked a clone with the flip.
    expect(srcRefName).toBe("addr");
    expect(dstRefName).not.toBe("addr");
    const dstA1Field = laid.defs![dstRefName].fields.find(
      (c) => (c as { id?: string }).id === "a1",
    ) as { byteOrder?: "BE" | "LE" };
    const srcA1Field = laid.defs!.addr.fields.find(
      (c) => (c as { id?: string }).id === "a1",
    ) as { byteOrder?: "BE" | "LE" };
    expect(dstA1Field.byteOrder).toBe("LE");
    expect(srcA1Field.byteOrder).toBeUndefined();

    // Export/lift forks a per-ref clone for EACH ref of a multiply-referenced
    // def (so each round-trips independently). dst's clone carries the flip;
    // src's clone does not — and the shared source `addr` is never mutated.
    const merged = mergeInstancesIntoPsdl(psdl, mirror);
    const mDst = (
      merged.body.find(
        (c): c is Extract<Container, { kind: "ref" }> =>
          "kind" in c && c.kind === "ref" && c.id === "dst",
      ) as { ref: string }
    ).ref;
    const mSrc = (
      merged.body.find(
        (c): c is Extract<Container, { kind: "ref" }> =>
          "kind" in c && c.kind === "ref" && c.id === "src",
      ) as { ref: string }
    ).ref;
    expect(mDst).not.toBe(mSrc);
    const a1Of = (defName: string) =>
      (
        merged.defs![defName].fields.find(
          (c) => (c as { id?: string }).id === "a1",
        ) as { byteOrder?: "BE" | "LE" }
      ).byteOrder;
    expect(a1Of(mDst)).toBe("LE");
    expect(a1Of(mSrc)).toBeUndefined();
    // The shared source def is untouched.
    expect(a1Of("addr")).toBeUndefined();
  });

  it("a TLV record added to the SECOND ref renders + exports only on it", () => {
    const psdl = mkTlvPacket();
    const mirror = psdlToRenderer(psdl);
    const blk2 = mirror.fields.find((f) => f.id === "blk2.opts")!;
    // Add one Opt-B record to blk2 only.
    blk2.tlv!.instances = [{ kind: 2 }];

    // Diagram: only blk2's record materialises (blk1 stays empty).
    const out = applyTlvInstances(psdl, mirror, {});
    const ids = renderCellIds(out);
    expect(ids.some((id) => id.startsWith("blk2.opts__inst_"))).toBe(true);
    expect(ids.some((id) => id.startsWith("blk1.opts__inst_"))).toBe(false);

    // Export: the per-ref clone for blk2 carries the instance; blk1's does not.
    const merged = mergeInstancesIntoPsdl(psdl, mirror);
    const refName = (id: string) =>
      (
        merged.body.find(
          (c): c is Extract<Container, { kind: "ref" }> =>
            "kind" in c && c.kind === "ref" && c.id === id,
        ) as { ref: string }
      ).ref;
    const blk1Def = merged.defs![refName("blk1")];
    const blk2Def = merged.defs![refName("blk2")];
    const repOf = (def: NamedStruct) =>
      def.fields.find(
        (c): c is Extract<Container, { kind: "repeat" }> =>
          "kind" in c && c.kind === "repeat" && c.id === "opts",
      );
    expect(repOf(blk2Def)!.instances).toEqual([{ kind: 2 }]);
    expect(repOf(blk1Def)!.instances).toBeUndefined();
  });
});
