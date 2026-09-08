// Audit gap (critical): a user-supplied PSDL whose `defs` reference themselves —
// directly (a def whose body contains a `ref` back to the same def, the standard
// `optional{ref self}` idiom for DNS name-compression / ASN.1 nesting / LISP /
// any self-describing format) or mutually (def A refs B, B refs A) — made the
// override mirror `psdlToRenderer` throw `RangeError: Maximum call stack size
// exceeded`. The ~20 collector ref-descent sites in psdl-to-renderer/index.ts
// recursed into `defs[c.ref].fields` (and the `visit`/`walk` closures
// re-flattened a nested `ref` on every recursion) with NO visited-set guard, so
// a cycle recursed forever — while `validatePsdlPacket` ACCEPTS such PSDL and
// core `resolveLayout` renders it correctly (the recursion terminates at the
// `optional` whose `when` is 0). So the diagram drew but the whole edit screen
// froze/errored: see-but-cannot-edit + frozen diagram for valid, renderable
// PSDL. No built-in preset uses recursive defs, so it is an arbitrary-PSDL gap.
//
// The fix threads a path-scoped `seen`/`refPath` set through every collector's
// def-descent (mirroring merge-instances' `mergeRefDef` cycle guard), so a `ref`
// already on the current path is skipped. This locks in: psdlToRenderer does not
// throw, the mirror is non-empty, core still renders, and the result round-trips
// through the lift (mergeInstancesIntoPsdl) without crashing.

import { describe, it, expect } from "vitest";

import { lit } from "@/lib/psdl/expr";
import {
  psdlToRenderer,
  mergeInstancesIntoPsdl,
} from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { validatePsdlPacket } from "@/lib/psdl/validate";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

// node = [val:int8, optional{when: lit 0, ref node}]; body = [ref node].
// The self-ref lives behind an `optional` whose `when` is 0, so the recursion
// terminates in core (the optional is absent) but the mirror collectors used to
// recurse forever resolving `ref node` → `optional{ref node}` → `ref node` → …
const selfRef = {
  name: "SelfRecursiveDef",
  rowBits: 32,
  body: [{ kind: "ref", id: "n", ref: "node" }],
  defs: {
    node: {
      id: "node",
      recursive: true,
      fields: [
        { id: "val", name: "Val", type: { kind: "int", bits: 8 } },
        {
          kind: "optional",
          id: "next",
          when: lit(0),
          container: { kind: "ref", id: "nNext", ref: "node" },
        },
      ],
    },
  },
} as unknown as PsdlPacket;

// Same, without the `recursive` flag (core renders either way; the mirror must
// not depend on the flag to terminate).
const selfRefNoFlag = {
  name: "SelfRecursiveDefNoFlag",
  rowBits: 32,
  body: [{ kind: "ref", id: "n", ref: "node" }],
  defs: {
    node: {
      id: "node",
      fields: [
        { id: "val", name: "Val", type: { kind: "int", bits: 8 } },
        {
          kind: "optional",
          id: "next",
          when: lit(0),
          container: { kind: "ref", id: "nNext", ref: "node" },
        },
      ],
    },
  },
} as unknown as PsdlPacket;

// Mutual recursion: a refs b, b refs a (each behind a `when: 0` optional).
const mutualRef = {
  name: "MutualRecursiveDefs",
  rowBits: 32,
  body: [{ kind: "ref", id: "a0", ref: "a" }],
  defs: {
    a: {
      id: "a",
      fields: [
        { id: "av", name: "AV", type: { kind: "int", bits: 8 } },
        {
          kind: "optional",
          id: "aOpt",
          when: lit(0),
          container: { kind: "ref", id: "b0", ref: "b" },
        },
      ],
    },
    b: {
      id: "b",
      fields: [
        { id: "bv", name: "BV", type: { kind: "int", bits: 8 } },
        {
          kind: "optional",
          id: "bOpt",
          when: lit(0),
          container: { kind: "ref", id: "a1", ref: "a" },
        },
      ],
    },
  },
} as unknown as PsdlPacket;

function cellCount(psdl: PsdlPacket): number {
  const env = new Map<string, number>(initialEnv(psdl));
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  return resolveLayout(psdl, { env }).cells.length;
}

describe("recursive / cyclic defs do not crash the override mirror", () => {
  for (const [label, psdl] of [
    ["self-referential def", selfRef],
    ["self-referential def without the `recursive` flag", selfRefNoFlag],
    ["mutually recursive defs", mutualRef],
  ] as const) {
    it(`${label}: validatePsdlPacket accepts and core renders it`, () => {
      // The premise: this PSDL is valid and the diagram DRAWS (the recursion
      // terminates at the `when: 0` optional), so the user can SEE it.
      expect(() => validatePsdlPacket(psdl)).not.toThrow();
      expect(cellCount(psdl)).toBeGreaterThan(0);
    });

    it(`${label}: psdlToRenderer does not stack-overflow and yields a non-empty mirror`, () => {
      let mirror: ReturnType<typeof psdlToRenderer> | undefined;
      expect(() => {
        mirror = psdlToRenderer(psdl);
      }).not.toThrow();
      // The mirror is the surface the user edits — it must not be empty for a
      // packet whose cells render (no see-but-cannot-edit).
      expect(mirror!.fields.length).toBeGreaterThan(0);
    });

    it(`${label}: the mirror lifts back into PSDL without crashing (round-trip)`, () => {
      const mirror = psdlToRenderer(psdl);
      expect(() => mergeInstancesIntoPsdl(psdl, mirror)).not.toThrow();
    });
  }
});
