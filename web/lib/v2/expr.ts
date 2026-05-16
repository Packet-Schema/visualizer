// Pure expression evaluator for the v2 model.
//
// No `eval`, no `Function`-constructor — every operation is a deliberate
// switch case. Refs are looked up in a `Map<string, number>` environment;
// unknown refs throw so the caller can decide whether to default or surface
// the error.

import type { Expr, PacketEnv } from "./types";

/** Construct convenience helpers — also used by presets so they stay readable. */
export const lit = (value: number): Expr => ({ kind: "lit", value });
export const ref = (field: string): Expr => ({ kind: "ref", field });
export const op = (
  o: "+" | "-" | "*" | "/" | "%" | "<<" | ">>",
  a: Expr,
  b: Expr,
): Expr => ({ kind: "op", op: o, a, b });
export const cond = (test: Expr, t: Expr, f: Expr): Expr => ({
  kind: "cond",
  test,
  t,
  f,
});

export class MissingRefError extends Error {
  constructor(public readonly field: string) {
    super(`evalExpr: missing reference "${field}"`);
    this.name = "MissingRefError";
  }
}

/**
 * Evaluate an expression to a number.
 *
 * Numeric semantics: integer arithmetic — division floors, shifts are 32-bit
 * (matching JavaScript's `<<`/`>>`), `%` is the JS remainder operator. The
 * condition test is truthy iff the result is non-zero.
 */
export function evalExpr(expr: Expr, env: PacketEnv): number {
  switch (expr.kind) {
    case "lit":
      return expr.value;
    case "ref": {
      const v = env.get(expr.field);
      if (v === undefined) throw new MissingRefError(expr.field);
      return v;
    }
    case "op": {
      const a = evalExpr(expr.a, env);
      const b = evalExpr(expr.b, env);
      switch (expr.op) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          if (b === 0) throw new Error("evalExpr: division by zero");
          return Math.trunc(a / b);
        case "%":
          if (b === 0) throw new Error("evalExpr: modulo by zero");
          return a % b;
        case "<<":
          return (a << b) | 0;
        case ">>":
          return a >> b;
        default: {
          // Exhaustiveness guard: cast lets us name the bad operator in the
          // thrown message without disabling the type checker.
          const bad = expr.op as string;
          throw new Error(`evalExpr: unknown operator "${bad}"`);
        }
      }
    }
    case "cond": {
      const t = evalExpr(expr.test, env);
      return t !== 0 ? evalExpr(expr.t, env) : evalExpr(expr.f, env);
    }
    default: {
      // Exhaustiveness: never type narrows away every legal kind.
      const _exhaustive: never = expr;
      throw new Error(
        `evalExpr: unknown expression kind "${(_exhaustive as { kind: string }).kind}"`,
      );
    }
  }
}

/** Collect all `ref` field ids used inside an expression. */
export function exprRefs(expr: Expr): string[] {
  const out: string[] = [];
  walk(expr, out);
  return out;
}

function walk(expr: Expr, out: string[]): void {
  switch (expr.kind) {
    case "lit":
      return;
    case "ref":
      out.push(expr.field);
      return;
    case "op":
      walk(expr.a, out);
      walk(expr.b, out);
      return;
    case "cond":
      walk(expr.test, out);
      walk(expr.t, out);
      walk(expr.f, out);
      return;
  }
}
