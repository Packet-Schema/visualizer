// Type definitions for the Packet View data model.
//
// These mirror the shapes used in the legacy packets.js / renderer.js so the
// resolver behaviour is preserved across the port to TypeScript.

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

export type ColorToken =
  | "blue"
  | "indigo"
  | "violet"
  | "teal"
  | "green"
  | "amber"
  | "orange"
  | "rose"
  | "slate";

export type SubField = {
  id: string;
  name: string;
  bits: number;
  description?: string;
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
