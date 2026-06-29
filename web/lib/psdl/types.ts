// PSDL types — visualizer-facing surface over @packet-schema/core (PSDL 0.5).
//
// The PSDL *theory* (wire types, expressions, normalize/layout/constraint) now
// lives in `@packet-schema/core`. This module re-exports core's type surface and
// layers the visualizer-only authoring/persistence extensions on top:
//
//   * `Repeat.instances` / `chainInstances` / `chainFinalProto` — persisted TLV
//     and IPv6-extension-header selections, so the user's choices round-trip
//     through JSON / share-URL / "Save as preset" (see psdl-to-renderer).
//   * `Constraint._uid` — a UI-only stable React key, ignored by validators.
//
// Because these extensions thread through the recursive container shape, the
// recursive nodes (Struct / Group / Optional / Bounded / Repeat / Switch /
// Encrypted / Container / Packet) are redefined here as core-compatible
// supersets. Leaf and output types are re-exported from core verbatim.
//
// PSDL carries semantic intent only — the renderer maps `category` to a CSS
// variable. There is no presentational `color` token in this schema; use
// `web/lib/render-tokens.ts` for the category → CSS-var mapping.

import type * as Core from "@packet-schema/core";

/* ------------------------------------------------------------------ *
 * Direct re-exports from core (no visualizer extension needed)
 * ------------------------------------------------------------------ */

export type {
  // Categories
  CategoryToken,
  // Wire types
  TypeInt,
  TypeBits,
  TypeBytes,
  TypeEnum,
  TypeVarint,
  TypeBerLength,
  BytesDelimited,
  Type,
  VarintEncoding,
  EnumVariant,
  EnumVariantObj,
  Subfield,
  ValueEntry,
  ChecksumAlgorithm,
  ChecksumParams,
  PseudoHeader,
  DisplayHint,
  NormativeLevel,
  RfcRef,
  UpdateRef,
  FieldMeta,
  // Expressions
  BinOp,
  ExprLit,
  ExprRef,
  ExprOp,
  ExprCond,
  ExprPeek,
  ExprLookup,
  ExprWireSize,
  ExprPrevIter,
  ExprRemaining,
  ExprEnclosingBits,
  ExprEnclosingField,
  Expr,
  // Leaf / non-recursive schema nodes
  Field,
  Virtual,
  Align,
  RefContainer,
  RepeatCount,
  NamedStruct,
  // Packet-level metadata
  PacketMeta,
  ImportEntry,
  RendererHints,
  RendererSection,
  // Convenience aliases
  PsdlField,
  PsdlExpr,
  PsdlType,
  // Normalized output / layout
  NormalizedField,
  Normalized,
  LayoutField,
  LayoutSubField,
  Cell,
  SubCell,
  ResolvedLayout,
  PacketEnv,
  ViewMode,
} from "@packet-schema/core";

export { VARINT_ENCODINGS } from "@packet-schema/core";

/* ------------------------------------------------------------------ *
 * Visualizer-only persistence payloads
 * ------------------------------------------------------------------ */

/** A single TLV record currently attached to a `Repeat<Switch>` body.
 *  Mirrors `TlvInstance` from the renderer model so PSDL can persist the
 *  user's chosen records (kind + per-instance extras) across export /
 *  share / save boundaries. Stripping this on round-trip is a known
 *  cause of "instances vanish on JSON re-import" — see the
 *  `instances` field on `Repeat`. */
export type TlvInstancePsdl = {
  kind: number;
  extras?: Record<string, number>;
};

/** A single IPv6-extension-header entry currently attached to a chain
 *  `Repeat<Switch on proto>`. The shape parallels `TlvInstancePsdl` but
 *  keys on `proto` (the wire's Next-Header value) rather than TLV `kind`
 *  so the schema reads naturally. Lifted separately on the renderer side
 *  via `chainInstances`. */
export type ChainInstancePsdl = {
  proto: number;
  extras?: Record<string, number>;
};

/* ------------------------------------------------------------------ *
 * Recursive schema nodes — core-compatible supersets that thread the
 * visualizer's persistence extensions through the container tree.
 * ------------------------------------------------------------------ */

/** Anonymous struct used as Repeat.element / Switch arm / Encrypted.plaintext. */
export type Struct = Omit<Core.Struct, "fields"> & {
  name?: string;
  fields: Container[];
};

/** Simple ordering group — children are spliced inline. */
export type Group = Omit<Core.Group, "children"> & {
  children: Container[];
};

/** Optional container — emits `container` iff `when` is truthy (§10.8). */
export type Optional = Omit<Core.Optional, "container"> & {
  container: Container;
};

/** Constrains parsing of its contents to a declared byte count (§5). */
export type Bounded = Omit<Core.Bounded, "fields"> & {
  fields: Container[];
};

/** Switch: choose a variant struct by evaluating a discriminator.
 *  The "_" case key is the default arm in PSDL 0.5. */
export type Switch = Omit<Core.Switch, "cases"> & {
  cases: Record<string, Struct>;
};

/** Encrypted container — opaque on the wire, structured once decrypted. */
export type Encrypted = Omit<Core.Encrypted, "plaintext"> & {
  plaintext: Struct;
};

/** Repeat: N copies of a struct, where N is computed each layout pass. */
export type Repeat = Omit<Core.Repeat, "element"> & {
  element: Struct;
  /** Persisted TLV instance list. When the Repeat is a TLV catalog
   *  (`Repeat<Switch on ref(...)>` whose cases are integer-keyed), the
   *  renderer materialises one record per entry here and the diagram
   *  layout pre-resolves each variant's leaf fields. Carrying the list
   *  inside PSDL itself (rather than only in the runtime renderer
   *  mirror) lets JSON / share URL / "Save as preset" round-trip the
   *  user's selections faithfully. Non-TLV Repeats may leave this
   *  undefined. Ignored by `@packet-schema/core`. */
  instances?: TlvInstancePsdl[];
  /** Persisted chain instance list (IPv6 extension-header style). Same
   *  reason as `instances`: without persisting the user's choices on
   *  the PSDL body, every export path that goes through
   *  `rendererToPsdl` silently drops the chain. */
  chainInstances?: ChainInstancePsdl[];
  /** Terminal Next-Header value after the last chain entry (IPv6's
   *  "what comes after all the extension headers?"). Optional; only
   *  meaningful on chain Repeats. */
  chainFinalProto?: number;
};

/** Any node that may appear in a Packet body or Struct field list. */
export type Container =
  | Core.Field
  | Core.Virtual
  | Group
  | Optional
  | Repeat
  | Switch
  | Core.Align
  | Bounded
  | Encrypted
  | Core.RefContainer;

/**
 * Bidirectional equality between two expressions, with a visualizer-only
 * stable identity (`_uid`) preserved across `structuredClone` so the editor
 * can give each row a React key that survives reorder / insert / delete.
 * `_uid` is not part of the on-wire PSDL contract; validators ignore it.
 */
export type Constraint = Core.Constraint & {
  _uid?: string;
};

/* ------------------------------------------------------------------ *
 * Packet
 * ------------------------------------------------------------------ */

export type Packet = Omit<
  Core.Packet,
  "body" | "constraints" | "defs" | "rowBits"
> & {
  /** Visualizer invariant: presets and authored packets always carry an
   *  explicit `rowBits`. (Core treats it as optional / deprecated in favour
   *  of `rendererHints.rowBits`.) */
  rowBits: number;
  body: Container[];
  constraints?: Constraint[];
  defs?: Record<string, Core.NamedStruct>;
  /** Persisted packet env (controller / freeRepeat / discriminator picks).
   *  Mirrors the JSON wire format's `env` block (see `lib/formats/json.ts`):
   *  the non-default subset of the live `controllers` map baked onto the
   *  packet so "Save as preset" round-trips the same env state that Share
   *  preserves. Ignored by `@packet-schema/core`; consumed when re-loading
   *  a custom preset to seed `controllers`. */
  env?: Record<string, number>;
};

/** Convenience aliases used by callers that prefer Psdl-prefixed names. */
export type PsdlPacket = Packet;
