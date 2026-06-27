// PSDL 0.3 — renderer-facing types.
//
// The PSDL schema (./types.ts) is the canonical on-wire format. This file
// defines the *internal* shape that React components consume — cells with
// TLV/subfield/chain editing affordances, layout positions, etc. PSDL
// Packets are lowered to this shape by `psdl-to-renderer.ts` for the UI;
// formats and the diagram layout always go through PSDL directly.
//
// CategoryToken is re-exported here so callers stay on a single import path.
// ColorToken is intentionally absent from the schema; it lives in
// `web/lib/render-tokens.ts` for the per-field `color` fallback the renderer
// still consults when a category is missing.

import type { ColorToken } from "../render-tokens";
import type { CategoryToken, Expr, VarintEncoding } from "./types";

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
  varintEncoding?: VarintEncoding;
  isBerLength?: boolean;
  /** True when this subfield's PSDL type is a delimiter-terminated `bytes`.
   *  Its width env value is a BYTE count (not bits), keyed by id. */
  isDelimited?: boolean;
  optionalGateFor?: string[];
  enumVariants?: Record<number, string>;
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
  /** Per-instance numeric extras parallel to `TlvInstance.extras`. The
   *  PSDL schema accepts them on `Repeat.chainInstances`; carrying the
   *  field on the renderer mirror prevents `chain.ts` round-trip from
   *  silently dropping data (Codex P2). Most renderer call sites only
   *  read `proto`. */
  extras?: Record<string, number>;
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
   * Case list when this field is the discriminator of a top-level PSDL
   * `Switch` whose `on` is `ref(<this field id>)`. Each entry pairs the
   * discriminator value with a human-readable label (the case struct's
   * `name` or the bare key). Populated by `psdlToRenderer`.
   */
  switchCases?: { value: number; label: string }[];
  /**
   * Encoding kind when this field's PSDL type is `varint`. Drives the
   * width picker in OverridePanel. The runtime width is the env value
   * keyed by this field's id (the same convention PSDL normalize uses).
   */
  varintEncoding?: VarintEncoding;
  /** True when this field's PSDL type is `berLength`. Same env override
   *  convention as `varintEncoding`. */
  isBerLength?: boolean;
  /** True when this field's PSDL type is a delimiter-terminated `bytes`.
   *  The width override is a BYTE count keyed by this field's id (bridged
   *  to `__bytesDelimLen__<id>` in layout.ts). */
  isDelimited?: boolean;
  /**
   * List of Optional containers whose `when` expression is
   * `ref(<this field id>)`. Each entry is the inner field's name so the
   * toggle UI can show what it gates. Populated by `psdlToRenderer`.
   */
  optionalGateFor?: string[];
  /**
   * Enum variant table when this field's PSDL type is `enum`. Drives the
   * EnumDropdown widget so users can pick a known value (e.g. `Protocol=6
   * → TCP`) instead of typing a raw integer. Populated by `psdlToRenderer`.
   */
  enumVariants?: Record<number, string>;
  /** Per-field byte order override (PSDL 0.4). When set, OverridePanel
   *  surfaces a BE / LE toggle for this field. The mutation goes through
   *  StudioPanel's edit-reducer because byteOrder is a schema attribute,
   *  not an env override. */
  byteOrder?: "BE" | "LE";
};

export type Packet = {
  name: string;
  rowBits: number;
  description?: string;
  byteOrder?: string;
  fields: Field[];
  /** Non-TLV / non-chain Repeat counts the user can drive via OverridePanel.
   *  Surfaced as a "Repeats" stepper section because these counts don't
   *  belong to a single field (they're synthetic env keys).
   *  `defaultCount`, when set, seeds an initial iteration count so the diagram
   *  shows a representative record on load instead of an empty section. Only
   *  set for eos/until repeats NOT nested in a `bounded` byte-scope (seeding a
   *  bounded-nested repeat would over-consume its budget).
   *
   *  `transform`, when set, means `countKey` is a real wire field (not a
   *  synthetic env key) whose value drives the record count through an affine
   *  relation `recordCount = env[countKey] * mul + add` (e.g. SRv6's
   *  `repeat … count={ref(srhLastEntry) + 1}` → mul=1, add=1). The stepper then
   *  DISPLAYS the record count but WRITES the inverted controller value
   *  `env[countKey] = round((recordCount - add) / mul)` so the diagram's count
   *  becomes the requested N. Without it the stepper shows/writes the raw env
   *  value (the existing eos/until and bare-ref cases). */
  freeRepeats?: {
    name: string;
    countKey: string;
    defaultCount?: number;
    transform?: { mul: number; add: number };
  }[];
  /** Switches whose `on` is a `peek` expression — discriminator can't be
   *  surfaced via a real cell, so OverridePanel offers a synthetic
   *  case-picker. */
  peekSwitches?: {
    id: string;
    name: string;
    cases: { value: number; label: string }[];
    peekKey: string;
  }[];
  /** Switches inside a plain (non-TLV/non-chain) repeat whose `on` is a
   *  `ref` to a discriminator field. That repeat is not lifted into the mirror,
   *  so the discriminator has no override widget — surface a packet-level
   *  variant picker keyed on the discriminator's env id instead (override-audit
   *  A2). Selecting a case sets which variant the repeated records display. */
  refSwitches?: {
    id: string;
    name: string;
    cases: { value: number; label: string }[];
    refKey: string;
  }[];
  /** Length-controller sliders for `bounded.bytes` scopes whose driving field
   *  is NOT a top-level cell (e.g. nested in a Group, like babel's
   *  `babelBodyLength`). Such a field can't host its own slider, so surface a
   *  packet-level one; raising it grows the bounded budget and the enclosed
   *  eos/until repeat fills it (override-design-audit). Each carries
   *  `controlsLength` so it renders through the normal slider widget. */
  lengthControllers?: Field[];
  /** eos/until repeats nested in a single-ref `bounded.bytes` scope. core reads
   *  an eos count from `env[countKey]`, NOT from the budget, so the layout must
   *  DERIVE the count from the budget: `floor(env[lengthKey] / perRecordBytes)`.
   *  This makes the length slider the single intuitive control — raising it
   *  fills the scope with records — instead of a separate (over-consuming) count
   *  stepper (override-design-audit). `perRecordBytes` is a conservative
   *  (over-)estimate so the derived count never exceeds the budget. */
  boundedRepeats?: {
    countKey: string;
    /** The single ref the budget depends on — the slider field the user drives.
     *  (The budget itself is `bytesExpr`, which may be `field*k - c`.) */
    lengthKey: string;
    /** The scope's `bounded.bytes` Expr, evaluated against the live env to get
     *  the actual byte budget (handles `ref` and `field*k - c` forms). */
    bytesExpr: Expr;
    perRecordBytes: number;
    /** Fixed bytes the enclosing bounded scope consumes BESIDES the records
     *  (sibling fields), subtracted from the budget before deriving the count
     *  so the records don't over-consume the scope. */
    prefixBytes: number;
    /** Per-record inner-scope length fields to seed so the DEFAULT record fits.
     *  A TLV-style record can itself wrap a nested `bounded` sized by a
     *  PER-RECORD length field (tlsClientHello's extensions: each record is
     *  [extType, extLen, bounded extData(ref extLen){switch}]). That inner
     *  length defaults to 0, so the representative arm (cases[0]) would
     *  over-consume the empty inner scope the instant a record is derived. Each
     *  entry seeds the inner length to a value that fits the representative arm
     *  — surfaced via `initialState` so the diagram shows a complete default
     *  record (and the length CELL stays user-editable). `perRecordBytes`
     *  already accounts for the seeded inner bytes, so the derived count never
     *  over-consumes the ENCLOSING scope either. */
    innerScopeSeeds?: { key: string; value: number }[];
  }[];
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
  /** Per-child decoration flags propagated from the source NormalizedField.
   *  When a Group collapse spans children with non-uniform encryption /
   *  byteOrder, the parent cell stays neutral and these per-sub-cell flags
   *  drive the visual treatment (lock icon, [LE] suffix etc.) instead. */
  encrypted?: boolean;
  encryptedParentId?: string;
  encryptedContextNote?: string;
  headerProtected?: boolean;
  byteOrder?: "BE" | "LE";
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
   * PSDL 0.3 encryption-decoration flags, propagated from NormalizedField.
   * Renderers may use these to display lock icons, dashed borders, or a
   * tooltip with `encryptedContextNote`. All optional and ignored by code
   * that predates PSDL 0.3.
   */
  encrypted?: boolean;
  encryptedParentId?: string;
  encryptedContextNote?: string;
  headerProtected?: boolean;
  /**
   * PSDL 0.4 per-field byte order override, propagated from
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
