// PSML 0.2 — Packet Schema Markup Language.
// Simple bidirectional equality-constraint solver.
//
// Each Constraint expresses `lhs == rhs` where exactly one side reduces to a
// single field reference. After the user mutates that reference (the
// `changedKey`), we recompute the other side's expression against the new
// env and write the result back into the corresponding ref on the opposite
// side. If both sides reduce to non-ref expressions and disagree, that's a
// conflict.
//
// We also support the inverse case for the canonical IHL ⇔ headerBytes:
// if `headerBytes` is what changed, solving `IHL * 4 == headerBytes` for IHL
// requires inverting `* 4` into `/ 4`. The solver knows how to invert a
// limited family of single-operator expressions (the ones used by our
// presets).

import { evalExpr, MissingRefError } from "./expr";
import type { Constraint, Expr, PacketEnv } from "./types";

export type PropagateOk = { ok: PacketEnv };
export type PropagateConflict = { conflict: string };
export type PropagateResult = PropagateOk | PropagateConflict;

/** Find the single field ref this expression reduces to, or null. */
function singleRef(expr: Expr): string | null {
  if (expr.kind === "ref") return expr.field;
  return null;
}

/**
 * Try to invert `expr` so it solves for `targetRef`, assuming `expr == known`.
 * Returns the numeric value that should be assigned to `targetRef`, or null
 * if we cannot invert this shape.
 *
 * Supported shapes:
 *   ref                                   → known
 *   ref op lit / lit op ref               → invert one of +,-,*,/,%,<<,>>
 *   (expr containing exactly one ref)     → traverse, peeling one operator
 *                                            at a time.
 */
function solveFor(
  expr: Expr,
  targetRef: string,
  known: number,
  env: PacketEnv,
): number | null {
  if (expr.kind === "ref") {
    return expr.field === targetRef ? known : null;
  }
  if (expr.kind === "lit") return null;
  if (expr.kind === "cond") return null;
  if (expr.kind === "peek") return null;
  // expr.kind === 'op'
  const aHas = containsRef(expr.a, targetRef);
  const bHas = containsRef(expr.b, targetRef);
  if (aHas === bHas) return null; // ambiguous or absent on both sides.

  if (aHas) {
    // Evaluate the constant side, then peel the operator.
    const bVal = evalConst(expr.b, env);
    if (bVal === null) return null;
    const peeled = invertLeft(expr.op, known, bVal);
    if (peeled === null) return null;
    return solveFor(expr.a, targetRef, peeled, env);
  } else {
    const aVal = evalConst(expr.a, env);
    if (aVal === null) return null;
    const peeled = invertRight(expr.op, known, aVal);
    if (peeled === null) return null;
    return solveFor(expr.b, targetRef, peeled, env);
  }
}

function containsRef(expr: Expr, target: string): boolean {
  if (expr.kind === "ref") return expr.field === target;
  if (expr.kind === "lit") return false;
  if (expr.kind === "cond")
    return (
      containsRef(expr.test, target) ||
      containsRef(expr.t, target) ||
      containsRef(expr.f, target)
    );
  if (expr.kind === "peek") {
    return expr.offset !== undefined && containsRef(expr.offset, target);
  }
  return containsRef(expr.a, target) || containsRef(expr.b, target);
}

/** Evaluate `expr` only if it doesn't depend on `MissingRef` lookups. */
function evalConst(expr: Expr, env: PacketEnv): number | null {
  try {
    return evalExpr(expr, env);
  } catch (e) {
    if (e instanceof MissingRefError) return null;
    throw e;
  }
}

// Given `unknown OP known == result`, recover `unknown`.
function invertLeft(o: string, result: number, known: number): number | null {
  switch (o) {
    case "+":
      return result - known;
    case "-":
      return result + known;
    case "*":
      if (known === 0) return null;
      return Math.trunc(result / known);
    case "/":
      return result * known;
    case "%":
      return null; // not invertible
    case "<<":
      return result >> known;
    case ">>":
      return (result << known) | 0;
  }
  return null;
}

// Given `known OP unknown == result`, recover `unknown`.
function invertRight(o: string, result: number, known: number): number | null {
  switch (o) {
    case "+":
      return result - known;
    case "-":
      return known - result;
    case "*":
      if (known === 0) return null;
      return Math.trunc(result / known);
    case "/":
      if (result === 0) return null;
      return Math.trunc(known / result);
    case "%":
      return null;
    case "<<":
      return null; // result = known << unknown; rarely needed.
    case ">>":
      return null;
  }
  return null;
}

/**
 * Propagate the change at `changedKey` across every constraint. We pick the
 * "winning" side as the one that contains the changed key (or reduces to it
 * directly), and assign the recomputed value to the opposite side's single
 * ref if it has one. Conflicts surface when both sides already have values
 * and they disagree.
 */
export function propagate(
  constraints: Constraint[],
  env: PacketEnv,
  changedKey: string,
): PropagateResult {
  const next: PacketEnv = new Map(env);
  for (const c of constraints) {
    const lhsRef = singleRef(c.lhs);
    const rhsRef = singleRef(c.rhs);
    const lhsHas = containsRef(c.lhs, changedKey);
    const rhsHas = containsRef(c.rhs, changedKey);
    if (!lhsHas && !rhsHas) continue;

    // Direction A: changedKey on LHS, solve RHS or write through a direct
    // RHS ref.
    if (lhsHas) {
      const lhsVal = evalConst(c.lhs, next);
      if (lhsVal === null) continue;
      if (rhsRef) {
        const existing = next.get(rhsRef);
        if (existing !== undefined && existing !== lhsVal) {
          // Try solving for rhsRef in case the rhs was a literal-bearing
          // expression — but here rhs IS a single ref so just set.
        }
        next.set(rhsRef, lhsVal);
      } else {
        // RHS is an expression with one ref — solve for that ref.
        const targets = uniqueRefs(c.rhs);
        if (targets.length === 1) {
          const solved = solveFor(c.rhs, targets[0], lhsVal, next);
          if (solved !== null) next.set(targets[0], solved);
        } else {
          // Can't invert; compare both sides directly.
          const rhsVal = evalConst(c.rhs, next);
          if (rhsVal !== null && rhsVal !== lhsVal) {
            return {
              conflict: `Constraint failed: lhs=${lhsVal} rhs=${rhsVal}`,
            };
          }
        }
      }
      continue;
    }

    // Direction B: changedKey on RHS, mirror.
    if (rhsHas) {
      const rhsVal = evalConst(c.rhs, next);
      if (rhsVal === null) continue;
      if (lhsRef) {
        next.set(lhsRef, rhsVal);
      } else {
        const targets = uniqueRefs(c.lhs);
        if (targets.length === 1) {
          const solved = solveFor(c.lhs, targets[0], rhsVal, next);
          if (solved !== null) next.set(targets[0], solved);
        } else {
          const lhsVal = evalConst(c.lhs, next);
          if (lhsVal !== null && lhsVal !== rhsVal) {
            return {
              conflict: `Constraint failed: lhs=${lhsVal} rhs=${rhsVal}`,
            };
          }
        }
      }
    }
  }
  return { ok: next };
}

function uniqueRefs(expr: Expr): string[] {
  const set = new Set<string>();
  collectRefs(expr, set);
  return [...set];
}

function collectRefs(expr: Expr, set: Set<string>): void {
  switch (expr.kind) {
    case "lit":
      return;
    case "ref":
      set.add(expr.field);
      return;
    case "op":
      collectRefs(expr.a, set);
      collectRefs(expr.b, set);
      return;
    case "cond":
      collectRefs(expr.test, set);
      collectRefs(expr.t, set);
      collectRefs(expr.f, set);
      return;
  }
}

/** Validate that the current env satisfies every constraint. */
export function validate(
  constraints: Constraint[],
  env: PacketEnv,
): { ok: true } | { conflict: string } {
  for (const c of constraints) {
    const l = evalConst(c.lhs, env);
    const r = evalConst(c.rhs, env);
    if (l === null || r === null) continue;
    if (l !== r) {
      return { conflict: `Constraint failed: lhs=${l} rhs=${r}` };
    }
  }
  return { ok: true };
}
