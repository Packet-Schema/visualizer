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

/**
 * Variable-length integer encoded per a well-known scheme.
 *
 * The on-wire bit width is not statically known — it is determined by reading
 * a prefix from the value bytes (QUIC: 2-bit length prefix → 1/2/4/8 bytes;
 * protobuf: continuation-bit per byte; CBOR: initial-byte additional-info).
 * Layout consumers may supply a concrete bit count via an env override keyed
 * by the field id, otherwise the field is treated as zero-width at design
 * time.
 */
export type TypeVarint = {
  kind: "varint";
  encoding: "quic" | "protobuf" | "cbor";
};

/** The set of varint encodings PSML 0.3 supports. */
export const VARINT_ENCODINGS = ["quic", "protobuf", "cbor"] as const;
export type VarintEncoding = (typeof VARINT_ENCODINGS)[number];

/**
 * BER length — variable-length DER/BER definite-length encoding.
 *
 * On-wire bit width is dynamic (1 byte for lengths <128, otherwise N+1 bytes).
 * Layout consumers may supply a concrete bit count via the env keyed by the
 * owning field's id, otherwise the field is treated as a 1-byte default.
 *
 * PSML 0.4 primitive — paired with `Optional` and `peek`. See issue #67.
 */
export type TypeBerLength = { kind: "berLength" };

export type Type = TypeInt | TypeBits | TypeBytes | TypeEnum | TypeVarint | TypeBerLength;

/* ------------------------------------------------------------------ *
 * Expressions
 * ------------------------------------------------------------------ */

export type BinOp = "+" | "-" | "*" | "/" | "%" | "<<" | ">>";

export type ExprLit = { kind: "lit"; value: number };
export type ExprRef = { kind: "ref"; field: string };
export type ExprOp = { kind: "op"; op: BinOp; a: Expr; b: Expr };
export type ExprCond = { kind: "cond"; test: Expr; t: Expr; f: Expr };

/**
 * Peek — read N bits from the byte stream at an offset relative to the
 * current cursor without consuming them. Used by Switch to dispatch on
 * lookahead bytes (e.g. TLS extension type before the length field). The
 * layout adapter evaluates a peek by reading a synthetic env key, falling
 * back to 0 when absent. PSML 0.4 primitive — see issue #67.
 */
export type ExprPeek = { kind: "peek"; bits: number; offset?: Expr };

export type Expr = ExprLit | ExprRef | ExprOp | ExprCond | ExprPeek;

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
  /**
   * Per-field byte order override. When set, the field's bytes are interpreted
   * in this order regardless of the enclosing Packet's byteOrder. PSML 0.4
   * primitive — used to model mixed-endian protocols (e.g. PCIe TLPs).
   */
  byteOrder?: "BE" | "LE";
};

/**
 * Optional container — emits `field` iff the `when` expression evaluates
 * truthy in the current env. PSML 0.4 primitive — see issue #67.
 */
export type Optional = {
  kind: "optional";
  id?: string;
  when: Expr;
  field: Field;
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

/**
 * Encrypted container — an opaque blob on the wire whose internal structure
 * is only knowable once decryption keys are applied (e.g. QUIC packet payload,
 * TLS 1.3 handshake records).
 *
 * Normalize/layout produce one of two shapes depending on `viewMode`:
 *   * `'wire'`     — emit a single virtual field of `wireBits` (or the sum of
 *                    plaintext field bits) tagged `encrypted: true`.
 *   * `'semantic'` — recurse into `plaintext.fields`; each emitted field
 *                    carries `encryptedParentId` and the context note, and
 *                    fields whose id is listed in `headerProtected` get
 *                    `headerProtected: true`.
 */
export type Encrypted = {
  kind: "encrypted";
  id: string;
  name?: string;
  /** Substructure that exists when 'decrypted'. */
  plaintext: Struct;
  /** Bit width of the encrypted blob on the wire (when known). */
  wireBits?: Expr;
  /** Plain-English note about key/context (e.g. 'TLS 1.3 handshake keys'). */
  contextNote: string;
  /** Field ids INSIDE plaintext that are header-protected (XOR-encrypted in QUIC). */
  headerProtected?: string[];
  category?: CategoryToken;
  doc?: string;
};

/** Any node that may appear in a Packet body or Struct field list. */
export type Container = Field | Repeat | Switch | Group | Encrypted | Optional;

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
  /**
   * Wire-mode only: this is the virtual placeholder for an Encrypted blob.
   * Renderer should display it as opaque.
   */
  encrypted?: boolean;
  /**
   * Semantic-mode only: id of the Encrypted container this plaintext field
   * was emitted from. Renderer can decorate to indicate "this only exists
   * after decryption".
   */
  encryptedParentId?: string;
  /** Plain-English context note copied from the Encrypted container. */
  encryptedContextNote?: string;
  /**
   * Semantic-mode only: true when this field is named in the parent
   * Encrypted's `headerProtected` list (XOR-encrypted in QUIC's header
   * protection layer).
   */
  headerProtected?: boolean;
  /** Per-field byte order override (PSML 0.4) — propagated from Field.byteOrder. */
  byteOrder?: "BE" | "LE";
};

export type Normalized = {
  fields: NormalizedField[];
  totalBits: number;
};

/** Runtime state — maps field id → current numeric value. */
export type PacketEnv = Map<string, number>;

/**
 * View-mode toggle for normalize/layout.
 *
 *   * `'wire'`     — show the packet as it appears on the wire (encrypted
 *                    blobs collapse to one opaque field).
 *   * `'semantic'` — show plaintext structure (encrypted blobs expand;
 *                    each interior field is tagged with its parent).
 */
export type ViewMode = "wire" | "semantic";
