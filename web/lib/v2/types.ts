// Packet View v2 data model.
//
// Unified recursive schema replacing the half-rigid v1 Field/Tlv/Chain/SubField
// model. Three primitive composition rules:
//   * Repeat   — N copies of an element struct, where N is an expression
//                evaluated against the current packet state.
//   * Switch   — pick one of several variant structs based on a discriminator
//                expression.
//   * Group    — flat ordering glue when you simply need to splice nodes.
//
// Everything else is either a Field (a leaf with a Type) or a top-level
// Constraint expressing a bidirectional equality between two expressions.
//
// The v1 model lives untouched in ../types.ts; v2 deliberately does not import
// from v1 so a Wave B cut-over can swap files cleanly.

import type { CategoryToken, ColorToken } from "../types";

// Re-export category/color tokens so consumers can stay on v2 alone.
export type { CategoryToken, ColorToken } from "../types";

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/** Fixed-width integer (signed or unsigned, big-endian on the wire). */
export type TypeInt = { kind: "int"; bits: number; signed?: boolean };

/** Raw N-bit slot — used for opaque flags, reserved fields, etc. */
export type TypeBits = { kind: "bits"; n: number };

/** Variable byte string whose length (in bytes) is computed from `n`. */
export type TypeBytes = { kind: "bytes"; n: Expr };

/** Fixed-width enum mapping value → label. */
export type TypeEnum = {
  kind: "enum";
  bits: number;
  variants: Record<number, string>;
};

export type Type = TypeInt | TypeBits | TypeBytes | TypeEnum;

/* ------------------------------------------------------------------ *
 * Expressions
 * ------------------------------------------------------------------ */

export type BinOp = "+" | "-" | "*" | "/" | "%" | "<<" | ">>";

export type ExprLit = { kind: "lit"; value: number };
export type ExprRef = { kind: "ref"; field: string };
export type ExprOp = { kind: "op"; op: BinOp; a: Expr; b: Expr };
export type ExprCond = { kind: "cond"; test: Expr; t: Expr; f: Expr };

export type Expr = ExprLit | ExprRef | ExprOp | ExprCond;

/* ------------------------------------------------------------------ *
 * Schema nodes
 * ------------------------------------------------------------------ */

/** A leaf value in the packet schema. */
export type Field = {
  kind?: "field"; // optional discriminator; absent on most callers
  id: string;
  name: string;
  type: Type;
  doc?: string;
  category?: CategoryToken;
  color?: ColorToken;
  /** Optional default value for normalization/UI; consumed by the resolver. */
  defaultValue?: number;
};

/** A named struct of ordered fields. */
export type Struct = {
  id: string;
  name?: string;
  fields: Container[];
};

/** Repeat: N copies of a struct, where N is computed each layout pass. */
export type Repeat = {
  kind: "repeat";
  id: string;
  name?: string;
  element: Struct;
  /** Number of repetitions — either a fixed expression, an `until` predicate,
   *  or `'eos'` meaning "consume the rest of the parent". */
  count: Expr | "eos" | { until: Expr };
  category?: CategoryToken;
  color?: ColorToken;
  doc?: string;
};

/** Switch: choose a variant struct by evaluating a discriminator. */
export type Switch = {
  kind: "switch";
  id: string;
  name?: string;
  on: Expr;
  cases: Record<string, Struct>;
  default?: Struct;
  doc?: string;
};

/** Simple ordering group — children are spliced inline. */
export type Group = {
  kind: "group";
  id: string;
  name?: string;
  children: Container[];
};

/** Any node that may appear in a Packet body or Struct field list. */
export type Container = Field | Repeat | Switch | Group;

/* ------------------------------------------------------------------ *
 * Constraints
 * ------------------------------------------------------------------ */

/**
 * Bidirectional equality between two expressions.
 *
 * The solver supports the simple form where at least one side reduces to a
 * single `ref` after partial evaluation. When the user mutates either side's
 * underlying field, the other is recomputed from the new state.
 */
export type Constraint = {
  lhs: Expr;
  rhs: Expr;
  doc?: string;
};

/* ------------------------------------------------------------------ *
 * Packet
 * ------------------------------------------------------------------ */

export type Packet = {
  name: string;
  rowBits: number;
  body: Container[];
  constraints?: Constraint[];
  byteOrder?: "BE" | "LE" | string;
  description?: string;
};

/* ------------------------------------------------------------------ *
 * Normalized output (the shape v1's cell-layout consumes)
 * ------------------------------------------------------------------ */

export type NormalizedField = {
  id: string;
  name: string;
  bits: number;
  absoluteBitOffset: number;
  /** Slash-joined path of containers (Struct/Repeat/Switch/Group ids) that
   *  produced this field. Useful for grouping in the renderer. */
  originalContainerPath: string;
  category?: CategoryToken;
  color?: ColorToken;
  doc?: string;
  /** When the producer is a Repeat, the zero-based copy index. */
  repeatIndex?: number;
  /** When the producer is a Switch, the chosen case key. */
  switchCase?: string;
};

export type Normalized = {
  fields: NormalizedField[];
  totalBits: number;
};

/** Runtime state — maps field id → current numeric value. */
export type PacketEnv = Map<string, number>;
