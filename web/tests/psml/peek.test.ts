// PSML 0.4 — `peek` Expr tests.
//
// `peek` reads N bits from the unparsed payload at a (byte) offset relative
// to the start of the packet. Offline (design-time) eval looks for the value
// under env key `__peek__<offset>__<bits>`; default 0 when absent. Useful for
// switching on a discriminator that hasn't been parsed yet.

import { describe, expect, it } from "vitest";
import { evalExpr, lit, peek, peekEnvKey, ref } from "../../lib/psml/expr";
import { normalize } from "../../lib/psml/normalize";
import { isValidExpr } from "../../lib/psml/validate";
import type { ExprPeek, Packet } from "../../lib/psml/types";

const bits = (n: number) => ({ kind: "bits" as const, n });

describe("evalExpr — peek", () => {
  it("defaults to 0 when no env entry exists", () => {
    expect(evalExpr(peek(8), new Map())).toBe(0);
  });

  it("reads from env key `__peek__0__<bits>` with no offset", () => {
    const env = new Map([[peekEnvKey(0, 8), 0xab]]);
    expect(evalExpr(peek(8), env)).toBe(0xab);
  });

  it("reads from `__peek__<offset>__<bits>` when offset is given", () => {
    const env = new Map([[peekEnvKey(4, 16), 0x1234]]);
    expect(evalExpr(peek(16, lit(4)), env)).toBe(0x1234);
  });

  it("evaluates the offset expression against the env", () => {
    const env = new Map<string, number>([
      ["base", 2],
      [peekEnvKey(2, 8), 42],
    ]);
    expect(evalExpr(peek(8, ref("base")), env)).toBe(42);
  });
});

describe("normalize — Switch.on uses peek to dispatch", () => {
  it("chooses the variant matching the peeked discriminator", () => {
    const peeked: ExprPeek = { kind: "peek", bits: 8 };
    const p: Packet = {
      name: "PeekedSwitch",
      rowBits: 32,
      body: [
        {
          kind: "switch",
          id: "sw",
          on: peeked,
          cases: {
            "1": { id: "v1", fields: [{ id: "a", name: "A", type: bits(8) }] },
            "2": { id: "v2", fields: [{ id: "b", name: "B", type: bits(16) }] },
          },
        },
      ],
    };
    const env = new Map([[peekEnvKey(0, 8), 2]]);
    const n = normalize(p, env);
    expect(n.fields.map((f) => f.id)).toEqual(["b"]);
    expect(n.totalBits).toBe(16);
  });
});

describe("isValidExpr — peek", () => {
  it("accepts peek with valid bits and no offset", () => {
    expect(isValidExpr({ kind: "peek", bits: 8 })).toBe(true);
  });

  it("accepts peek with a valid offset expression", () => {
    expect(
      isValidExpr({ kind: "peek", bits: 8, offset: { kind: "lit", value: 4 } }),
    ).toBe(true);
  });

  it("rejects bits = 0", () => {
    expect(isValidExpr({ kind: "peek", bits: 0 })).toBe(false);
  });

  it("rejects bits > 64", () => {
    expect(isValidExpr({ kind: "peek", bits: 65 })).toBe(false);
  });

  it("rejects non-integer bits", () => {
    expect(isValidExpr({ kind: "peek", bits: 8.5 })).toBe(false);
  });

  it("rejects a malformed offset expression", () => {
    expect(
      isValidExpr({ kind: "peek", bits: 8, offset: { kind: "nope" } }),
    ).toBe(false);
  });
});
