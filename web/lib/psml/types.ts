// PSML 0.2 — Packet Schema Markup Language.
// Type definitions for the PSML wire format: a unified recursive packet
// schema with three composition primitives (Repeat, Switch, Group), typed
// fields, and bidirectional equality constraints.
//
// PSML carries semantic intent only — the renderer maps `category` to a CSS
// variable. There is no presentational `color` token in this schema; use
// `web/lib/render-tokens.ts` for the category → CSS-var mapping.

/* ------------------------------------------------------------------ *
 * Categories
 * ------------------------------------------------------------------ */

/**
 * Semantic role of a field. The renderer maps this to a CSS variable; the
 * mapping is renderer-side intent (`web/lib/render-tokens.ts`), never
 * encoded in the schema.
 */
export type CategoryToken =
  | "addressing"
  | "identifier"
  | "length"
  | "type"
  | "flags"
  | "reserved"
  | "checksum"
  | "variable"
  | "payload-marker";

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

/** Convenience aliases used by callers that prefer Psml-prefixed names. */
export type PsmlPacket = Packet;
export type PsmlField = Field;
export type PsmlExpr = Expr;
export type PsmlType = Type;

/* ------------------------------------------------------------------ *
 * Normalized output (the shape the renderer's cell-layout consumes)
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
