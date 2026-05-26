// PSML constraint solver tests — bidirectional propagation, conflict
// detection, ref-only direction, and validate().

import { describe, expect, it } from "vitest";
import { lit, op, ref } from "@/lib/psml/expr";
import { propagate, validate } from "@/lib/psml/constraint";
import type { Constraint, PacketEnv } from "@/lib/psml/types";

const ihlConstraint: Constraint = {
  lhs: op("*", ref("ihl"), lit(4)),
  rhs: ref("headerBytes"),
};

describe("propagate — IHL ⇔ headerBytes", () => {
  it("forward: ihl=7 → headerBytes=28", () => {
    const start: PacketEnv = new Map([
      ["ihl", 7],
      ["headerBytes", 20],
    ]);
    const r = propagate([ihlConstraint], start, "ihl");
    if ("conflict" in r) throw new Error(r.conflict);
    expect(r.ok.get("headerBytes")).toBe(28);
  });

  it("inverse: headerBytes=32 → ihl=8", () => {
    const start: PacketEnv = new Map([
      ["ihl", 5],
      ["headerBytes", 32],
    ]);
    const r = propagate([ihlConstraint], start, "headerBytes");
    if ("conflict" in r) throw new Error(r.conflict);
    expect(r.ok.get("ihl")).toBe(8);
  });

  it("propagation is a no-op when the changed key isn't referenced", () => {
    const start: PacketEnv = new Map([
      ["ihl", 5],
      ["headerBytes", 20],
    ]);
    const r = propagate([ihlConstraint], start, "unrelated");
    if ("conflict" in r) throw new Error(r.conflict);
    expect(r.ok.get("ihl")).toBe(5);
    expect(r.ok.get("headerBytes")).toBe(20);
  });
});

describe("propagate — operator inversion coverage", () => {
  it("inverts addition (left operand unknown)", () => {
    // unknown + 3 == y  =>  unknown = y - 3
    const c: Constraint = { lhs: op("+", ref("x"), lit(3)), rhs: ref("y") };
    const r = propagate(
      [c],
      new Map([
        ["x", 0],
        ["y", 10],
      ]),
      "y",
    );
    if ("conflict" in r) throw new Error(r.conflict);
    expect(r.ok.get("x")).toBe(7);
  });

  it("inverts subtraction (right operand unknown)", () => {
    // 10 - unknown == y  =>  unknown = 10 - y
    const c: Constraint = { lhs: op("-", lit(10), ref("x")), rhs: ref("y") };
    const r = propagate(
      [c],
      new Map([
        ["x", 0],
        ["y", 4],
      ]),
      "y",
    );
    if ("conflict" in r) throw new Error(r.conflict);
    expect(r.ok.get("x")).toBe(6);
  });

  it("inverts shift", () => {
    const c: Constraint = { lhs: op("<<", ref("x"), lit(3)), rhs: ref("y") };
    const r = propagate(
      [c],
      new Map([
        ["x", 1],
        ["y", 64],
      ]),
      "y",
    );
    if ("conflict" in r) throw new Error(r.conflict);
    expect(r.ok.get("x")).toBe(8);
  });

  it("declines to invert modulo (no-op write to the dependent ref)", () => {
    const c: Constraint = { lhs: op("%", ref("x"), lit(3)), rhs: ref("y") };
    const r = propagate(
      [c],
      new Map([
        ["x", 5],
        ["y", 99],
      ]),
      "y",
    );
    if ("conflict" in r) throw new Error(r.conflict);
    // unchanged because % is not invertible
    expect(r.ok.get("x")).toBe(5);
  });
});

describe("propagate — conflict detection", () => {
  it("flags explicit conflict when both sides are non-trivial", () => {
    // Both LHS and RHS are computed expressions of the changedKey, no single
    // ref to write to — comparison fails.
    const c: Constraint = {
      lhs: op("+", ref("a"), ref("b")),
      rhs: op("*", ref("a"), ref("b")),
    };
    const env = new Map([
      ["a", 2],
      ["b", 3],
    ]);
    const r = propagate([c], env, "a");
    expect("conflict" in r).toBe(true);
  });

  it("validate() detects an inconsistent env", () => {
    const env = new Map([
      ["ihl", 5],
      ["headerBytes", 99],
    ]);
    const v = validate([ihlConstraint], env);
    expect("conflict" in v).toBe(true);
  });

  it("validate() returns ok when both sides agree (or one side is unknown)", () => {
    expect(
      validate(
        [ihlConstraint],
        new Map([
          ["ihl", 5],
          ["headerBytes", 20],
        ]),
      ),
    ).toEqual({ ok: true });
    // One side missing → silently ok.
    expect(validate([ihlConstraint], new Map([["ihl", 5]]))).toEqual({
      ok: true,
    });
  });
});

describe("propagate — non-invertible inverse path", () => {
  it("symmetric write when the changed key is on the RHS and LHS is a single ref", () => {
    const c: Constraint = { lhs: ref("a"), rhs: op("+", ref("b"), lit(2)) };
    const r = propagate(
      [c],
      new Map([
        ["a", 0],
        ["b", 5],
      ]),
      "b",
    );
    if ("conflict" in r) throw new Error(r.conflict);
    expect(r.ok.get("a")).toBe(7);
  });

  it("symmetric inversion when the changed key is on the LHS as a non-ref expression", () => {
    // unknown changed; lhs has the unknown wrapped
    const c: Constraint = {
      lhs: op("*", ref("ihl"), lit(4)),
      rhs: ref("headerBytes"),
    };
    const r = propagate(
      [c],
      new Map([
        ["ihl", 5],
        ["headerBytes", 0],
      ]),
      "headerBytes",
    );
    if ("conflict" in r) throw new Error(r.conflict);
    expect(r.ok.get("ihl")).toBe(0);
  });
});

describe("propagate — refs that can't yet be evaluated", () => {
  it("skips a constraint when the changed-side expression refers to missing values", () => {
    const c: Constraint = {
      lhs: op("+", ref("a"), ref("missing")),
      rhs: ref("b"),
    };
    const env = new Map([
      ["a", 1],
      ["b", 0],
    ]);
    const r = propagate([c], env, "a");
    if ("conflict" in r) throw new Error(r.conflict);
    // b unchanged because lhs couldn't evaluate
    expect(r.ok.get("b")).toBe(0);
  });
});
