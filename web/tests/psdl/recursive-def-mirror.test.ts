// Regression: a user-authored PSDL whose `defs` contains a self- (or cycle-)
// referential ref reachable through `switchCaseLeafGate`'s `scanStruct` walk
// must NOT crash `psdlToRenderer` (the override mirror).
//
// The defect: `validatePsdlPacket` passes (no throw) and core's normalize/
// `resolveLayout` bounds the recursion by budget so the DIAGRAM renders fine
// (one cell). But every other ref-descent in psdl-to-renderer carries a
// `*RefSeen`/`seenDefs` cycle guard EXCEPT the `scanStruct` closure inside
// `switchCaseLeafGate`, which descended into `defs[child.ref]` with no
// seen-set. A def that references itself (here via `optional{ container:
// ref(self) }`) therefore recursed forever →
// `RangeError: Maximum call stack size exceeded`. Because OverridePanel /
// StudioPanel are built entirely from the mirror, the whole override subsystem
// died for a packet the user can SEE rendered — violating the "no crashes for
// arbitrary PSDL" bar and the roundtrip bar (it could not be edited/exported
// through the studio at all).

import { describe, it, expect } from "vitest";

import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { validatePsdlPacket } from "@/lib/psdl/validate";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

// `node` references itself through `optional{ container: ref('node') }`. The
// gate `when: ref('val')` makes the optional reachable from
// `switchCaseLeafGate`'s container descent.
const recursivePsdl = {
  name: "rec",
  rowBits: 32,
  defs: {
    node: {
      id: "node",
      fields: [
        {
          kind: "field",
          id: "val",
          name: "val",
          type: { kind: "int", bits: 8 },
        },
        {
          kind: "optional",
          id: "o",
          when: { kind: "ref", field: "val" },
          container: { kind: "ref", ref: "node", id: "child" },
        },
      ],
    },
  },
  body: [{ kind: "ref", ref: "node", id: "root" }],
} as unknown as PsdlPacket;

describe("recursive/self-referential def — override mirror", () => {
  it("validatePsdlPacket accepts it (matches the original repro)", () => {
    expect(() => validatePsdlPacket(recursivePsdl)).not.toThrow();
  });

  it("the diagram renders fine (core normalize bounds the recursion)", () => {
    const env = new Map<string, number>();
    for (const [k, v] of initialEnv(recursivePsdl)) env.set(k, v);
    for (const r of collectPsdlRefs(recursivePsdl))
      if (!env.has(r)) env.set(r, 0);
    const layout = resolveLayout(recursivePsdl, { env });
    // Budget-bounded: at least the root `val` cell renders, no infinite loop.
    expect(layout.cells.length).toBeGreaterThan(0);
  });

  it("psdlToRenderer does NOT throw a stack overflow (cycle guard in scanStruct)", () => {
    expect(() => psdlToRenderer(recursivePsdl)).not.toThrow();
  });
});
