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
  /**
   * Computes the bit width for a variable field given the current value of the
   * controller it references. Re-attached at build time via the resolver registry.
   */
  toBits?: (controlValue: number) => number;
  subfields?: SubField[];
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
