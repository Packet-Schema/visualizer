// PSDL expression evaluator tests — covers every operator, ref lookup,
// conditional branching, error paths, and exprRefs collection.

import { describe, expect, it } from "vitest";
import {
  cond,
  evalExpr,
  exprRefs,
  lit,
  MissingRefError,
  op,
  ref,
} from "../../lib/psdl/expr";
import type { Expr, PacketEnv } from "../../lib/psdl/types";

const env: PacketEnv = new Map([
  ["a", 5],
  ["b", 3],
  ["zero", 0],
]);

describe("evalExpr — operator coverage", () => {
  it("evaluates a literal", () => {
    expect(evalExpr(lit(42), env)).toBe(42);
  });

  it("looks up a ref", () => {
    expect(evalExpr(ref("a"), env)).toBe(5);
  });

  it("addition", () => {
    expect(evalExpr(op("+", ref("a"), ref("b")), env)).toBe(8);
  });

  it("subtraction", () => {
    expect(evalExpr(op("-", ref("a"), ref("b")), env)).toBe(2);
  });

  it("multiplication", () => {
    expect(evalExpr(op("*", ref("a"), lit(4)), env)).toBe(20);
  });

  it("division (integer truncation)", () => {
    expect(evalExpr(op("/", ref("a"), ref("b")), env)).toBe(1);
    expect(evalExpr(op("/", lit(-7), lit(2)), env)).toBe(-3);
  });

  it("modulo", () => {
    expect(evalExpr(op("%", ref("a"), ref("b")), env)).toBe(2);
  });

  it("left shift", () => {
    expect(evalExpr(op("<<", ref("a"), lit(2)), env)).toBe(20);
  });

  it("right shift", () => {
    expect(evalExpr(op(">>", lit(20), lit(2)), env)).toBe(5);
  });
});

describe("evalExpr — conditionals", () => {
  it("picks the truthy branch", () => {
    expect(evalExpr(cond(ref("a"), lit(11), lit(22)), env)).toBe(11);
  });

  it("picks the falsy branch when the test evaluates to zero", () => {
    expect(evalExpr(cond(ref("zero"), lit(11), lit(22)), env)).toBe(22);
  });
});

describe("evalExpr — deep nesting", () => {
  it("evaluates nested arithmetic", () => {
    // ((a + b) * 2) - (a / b) == 16 - 1 == 15
    const expr: Expr = op(
      "-",
      op("*", op("+", ref("a"), ref("b")), lit(2)),
      op("/", ref("a"), ref("b")),
    );
    expect(evalExpr(expr, env)).toBe(15);
  });

  it("conditional branches can themselves be expressions", () => {
    const expr: Expr = cond(
      op(">>", lit(8), lit(3)),
      op("+", ref("a"), ref("b")),
      op("-", ref("a"), ref("b")),
    );
    // 8 >> 3 == 1 (truthy) → 5 + 3 == 8
    expect(evalExpr(expr, env)).toBe(8);
  });
});

describe("evalExpr — error paths", () => {
  it("throws MissingRefError on unknown refs", () => {
    expect(() => evalExpr(ref("nope"), env)).toThrow(MissingRefError);
    try {
      evalExpr(ref("nope"), env);
    } catch (e) {
      expect(e).toBeInstanceOf(MissingRefError);
      expect((e as MissingRefError).field).toBe("nope");
      expect((e as MissingRefError).name).toBe("MissingRefError");
      expect((e as MissingRefError).message).toContain("nope");
    }
  });

  it("throws on division by zero", () => {
    expect(() => evalExpr(op("/", lit(1), lit(0)), env)).toThrow(
      /division by zero/,
    );
  });

  it("throws on modulo by zero", () => {
    expect(() => evalExpr(op("%", lit(1), lit(0)), env)).toThrow(
      /modulo by zero/,
    );
  });

  it("throws on an unknown operator", () => {
    const bogus = {
      kind: "op",
      op: "??",
      a: lit(1),
      b: lit(1),
    } as unknown as Expr;
    expect(() => evalExpr(bogus, env)).toThrow(/unknown operator/);
  });

  it("throws on an unknown expression kind", () => {
    const bogus = { kind: "weird" } as unknown as Expr;
    expect(() => evalExpr(bogus, env)).toThrow(/unknown expression/);
  });
});

describe("exprRefs", () => {
  it("collects refs from a literal (none)", () => {
    expect(exprRefs(lit(7))).toEqual([]);
  });

  it("collects a single ref", () => {
    expect(exprRefs(ref("foo"))).toEqual(["foo"]);
  });

  it("collects refs from binary operators", () => {
    expect(exprRefs(op("+", ref("a"), ref("b")))).toEqual(["a", "b"]);
  });

  it("collects refs from conditionals", () => {
    expect(exprRefs(cond(ref("t"), ref("y"), ref("n")))).toEqual([
      "t",
      "y",
      "n",
    ]);
  });

  it("collects refs from deep nesting", () => {
    const e = op(
      "*",
      cond(ref("x"), ref("y"), op("+", ref("z"), lit(1))),
      lit(2),
    );
    expect(exprRefs(e)).toEqual(["x", "y", "z"]);
  });
});
