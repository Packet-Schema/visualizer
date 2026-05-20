// PSML 0.3 — renderer-facing types.
//
// The PSML schema (./types.ts) is the canonical on-wire format. This file
// defines the *internal* shape that React components consume — cells with
// TLV/subfield/chain editing affordances, layout positions, etc. PSML
// Packets are lowered to this shape by `psml-to-renderer.ts` for the UI;
// formats and the diagram layout always go through PSML directly.
//
// CategoryToken is re-exported here so callers stay on a single import path.
// ColorToken is intentionally absent from the schema; it lives in
// `web/lib/render-tokens.ts` for the per-field `color` fallback the renderer
// still consults when a category is missing.

import type { ColorToken } from "../render-tokens";
import type { CategoryToken } from "./types";

export type { ColorToken } from "../render-tokens";
export type { CategoryToken } from "./types";

export type SubField = {
  id: string;
  name: string;
  bits: number;
  description?: string;
  /** Same override hooks as Field. Populated when a Group's child is the
   *  discriminator / gate / data-dependent type — i.e. when the runtime
   *  override surface lives inside a subfield rather than a top-level
   *  Field (e.g. WebSocket's `payloadLength7` inside the byte-0 group). */
  switchCases?: { value: number; label: string }[];
  varintEncoding?: "quic" | "protobuf" | "cbor";
  isBerLength?: boolean;
  optionalGateFor?: string[];
  defaultValue?: number;
};

/** A single field inside a TLV catalog entry's positional layout. */
export type TlvCatalogField = {
  id: string;
  name: string;
  bits: number;
  description?: string;
};

/** Hints for a TLV catalog entry that supports a variable count of fixed slots. */
export type TlvVariableCount = {
  key: string;
  min: number;
  max: number;
  label?: string;
};

/**
 * A catalog entry describing one TLV record type (e.g. TCP option Kind=2 MSS,
 * or an IPv4 option Kind=7 Record Route). `fields` is the fixed positional
 * layout. If `variableCount` is set, the entry has a count-based extra that
 * drives the field list — either `fieldsFor` (in-memory closure) or
 * `fieldsFormula` (resolver-registry key) supplies the expanded slot list.
 */
export type TlvCatalogEntry = {
  kind: number;
  name: string;
  /** Optional fixed bit-width when `fields` is omitted (e.g. EOL/NOP). */
  bits?: number;
  description?: string;
  fields?: TlvCatalogField[];
  /** Defaults merged into instance.extras before computing field list. */
  defaultExtras?: Record<string, number>;
  /** Variable-count metadata (UI knob description). */
  variableCount?: TlvVariableCount;
  /** Build-time formula token; resolved to a function via TLV_FIELDS_REGISTRY. */
  fieldsFormula?: string;
  /** In-memory equivalent of `fieldsFormula`; checked first when present. */
  fieldsFor?: (extras: Record<string, number>) => TlvCatalogField[];
};

/** An instance of a TLV record currently attached to a TLV field. */
export type TlvInstance = {
  kind: number;
  extras?: Record<string, number>;
};

export type TlvSpec = {
  catalog: TlvCatalogEntry[];
  instances: TlvInstance[];
  padToBoundary?: number;
  drivesController?: string;
  bytesPerUnit?: number;
  baseControllerValue?: number;
};
/** Alias for compatibility with the TLV/Chain editor naming. */
export type TlvDescriptor = TlvSpec;

/** A chain-catalog entry (e.g. IPv6 extension header). */
export type ChainCatalogEntry = {
  proto: number;
  name: string;
  description?: string;
  fields: TlvCatalogField[];
};

/** A single chain block (extension header). */
export type ChainInstance = {
  proto: number;
};

export type Field = {
  id: string;
  name: string;
  /** Fixed bit width for non-variable fields. */
  bits?: number;
  category?: CategoryToken;
  /** Legacy per-field color token, used as a fallback when `category` is absent. */
  color?: ColorToken;
  description?: string;
  /** Marks this field as a length controller; the named key is written into state. */
  controlsLength?: string;
  defaultValue?: number;
  min?: number;
  max?: number;
  /** Variable-length flag. When true, `lengthFrom` + `toBits` are required. */
  variable?: boolean;
  lengthFrom?: string;
  /** Build-time formula token; resolved to a function via TO_BITS_REGISTRY. */
  formula?: string;
  /**
   * Computes the bit width for a variable field given the current value of the
   * controller it references. Re-attached at build time via the resolver registry.
   */
  toBits?: (controlValue: number) => number;
  subfields?: SubField[];
  /** TLV container metadata (e.g. TCP/IPv4 options, TLS extensions). */
  tlv?: TlvSpec;
  /** Chain container metadata (e.g. IPv6 Next Header). */
  chainCatalog?: ChainCatalogEntry[];
  chainInstances?: ChainInstance[];
  /** Final next-header value when no extension headers are attached. */
  chainFinalProto?: number;
  /**
   * Case list when this field is the discriminator of a top-level PSML
   * `Switch` whose `on` is `ref(<this field id>)`. Each entry pairs the
   * discriminator value with a human-readable label (the case struct's
   * `name` or the bare key). Populated by `psmlToRenderer`.
   */
  switchCases?: { value: number; label: string }[];
  /**
   * Encoding kind when this field's PSML type is `varint`. Drives the
   * width picker in OverridePanel. The runtime width is the env value
   * keyed by this field's id (the same convention PSML normalize uses).
   */
  varintEncoding?: "quic" | "protobuf" | "cbor";
  /** True when this field's PSML type is `berLength`. Same env override
   *  convention as `varintEncoding`. */
  isBerLength?: boolean;
  /**
   * List of Optional containers whose `when` expression is
   * `ref(<this field id>)`. Each entry is the inner field's name so the
   * toggle UI can show what it gates. Populated by `psmlToRenderer`.
   */
  optionalGateFor?: string[];
};

export type Packet = {
  name: string;
  rowBits: number;
  description?: string;
  byteOrder?: string;
  fields: Field[];
};

/** A laid-out cell within a row. May span multiple rows via segmentation. */
export type SubCell = {
  parentField: Field;
  subfield: SubField;
  id: string;
  startBit: number;
  endBit: number;
  isFirst: boolean;
  isLast: boolean;
  bitsTotal: number;
};

export type Cell = {
  field: Field;
  bitsTotal: number;
  row: number;
  startBit: number;
  endBit: number;
  segmentIndex: number;
  totalSegments: number;
  isFirst: boolean;
  isLast: boolean;
  fieldStartOffset: number;
  fieldEndOffset: number;
  subCells?: SubCell[];
  /**
   * PSML 0.3 encryption-decoration flags, propagated from NormalizedField.
   * Renderers may use these to display lock icons, dashed borders, or a
   * tooltip with `encryptedContextNote`. All optional and ignored by code
   * that predates PSML 0.3.
   */
  encrypted?: boolean;
  encryptedParentId?: string;
  encryptedContextNote?: string;
  headerProtected?: boolean;
  /**
   * PSML 0.4 per-field byte order override, propagated from
   * NormalizedField.byteOrder. Renderers may decorate cells with a `[LE]`
   * marker when this differs from the enclosing packet's byteOrder.
   */
  byteOrder?: "BE" | "LE";
};

export type ResolvedLayout = {
  cells: Cell[];
  totalBits: number;
};

/** Maps a controller key (`field.controlsLength`) to its current numeric value. */
export type ControllerState = Record<string, number>;

/** Preset registry keyed by short identifier (e.g. "ipv4", "tcp"). */
export type PacketRegistry = Record<string, Packet>;

/** A resolved TLV block (one rendered record within a TLV field). */
export type TlvBlock = {
  kind: number | null;
  name: string;
  bits: number;
  fields: TlvCatalogField[];
  extras: Record<string, number>;
  description?: string;
  variableCount?: TlvCatalogEntry["variableCount"] | null;
  isPadding?: boolean;
};

export type ResolvedTlv = {
  totalBits: number;
  blocks: TlvBlock[];
};

/** A resolved chain block (one IPv6 extension header instance). */
export type ChainBlock = {
  chainOwnerFieldId: string;
  chainIndex: number;
  proto: number;
  name: string;
  bits: number;
  fields: TlvCatalogField[];
  description?: string;
};
