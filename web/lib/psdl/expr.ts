// PSDL 0.2 — Packet Schema Definition Language.
// Pure expression evaluator. No `eval`, no `Function` — every operation is a
// deliberate switch case.
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
export const peek = (bits: number, offset?: Expr): Expr =>
  offset === undefined
    ? { kind: "peek", bits }
    : { kind: "peek", bits, offset };

/** Synthetic env key for a `peek` expression: `__peek__<offset>__<bits>`. */
export function peekEnvKey(offset: number, bits: number): string {
  return `__peek__${offset}__${bits}`;
}

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
    case "peek": {
      // PSDL 0.4 — read a lookahead value from a synthetic env key. The
      // adapter that handles a peek call (e.g. a Switch on a peek expression)
      // is expected to seed `__peek__<offset>__<bits>` (or just
      // `__peek__<bits>` when offset is 0/absent). Falls back to 0 so layout
      // can still proceed with the default Switch case.
      const offsetVal =
        expr.offset !== undefined ? evalExpr(expr.offset, env) : 0;
      const key = `__peek__${offsetVal}__${expr.bits}`;
      const v = env.get(key);
      return v ?? 0;
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
    case "peek":
      if (expr.offset !== undefined) walk(expr.offset, out);
      return;
    default: {
      // Exhaustiveness guard — a new `Expr` variant should surface here
      // as a tsc error, not as a silent miss that leaves its refs out of
      // `exprRefs` (and so out of the propagator's dependency graph).
      const _exhaustive: never = expr;
      throw new Error(
        `exprRefs.walk: unhandled Expr kind ${String((_exhaustive as { kind?: string }).kind)}`,
      );
    }
  }
}
