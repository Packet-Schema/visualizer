// JSON import / export — round-trip format for Packet View.
//
// Schema (version 1):
// {
//   "format": "packet-view",
//   "version": 1,
//   "name": string,
//   "rowBits": number,
//   "description"?: string,
//   "byteOrder"?: string,
//   "controllers"?: { [key]: number },
//   "fields": [
//     {
//       "id": string,
//       "name": string,
//       "bits"?: number,            // for fixed-width fields
//       "color"?: string,
//       "category"?: string,
//       "description"?: string,
//
//       // Length-controller field:
//       "controlsLength"?: string,
//       "defaultValue"?: number,
//       "min"?: number,
//       "max"?: number,
//
//       // Variable-length field:
//       "variable"?: true,
//       "lengthFrom"?: string,
//       // We prefer a registry key — kept declarative so packet definitions
//       // never serialise inline JS. Legacy `lengthFn` descriptors are still
//       // accepted on import for compatibility with older exports.
//       "formula"?: string,
//       "lengthFn"?: { kind: "linear", scale: number, offset: number, min?: number },
//
//       // Optional subfields (bit-level decomposition of a fixed field).
//       "subfields"?: Array<{ id: string; name: string; bits: number; description?: string }>,
//
//       // Optional TLV / chain descriptors. We preserve these as opaque
//       // structures so future TLV-aware editors can round-trip them, even
//       // though the current TS resolver doesn't consume them yet.
//       "tlv"?: unknown,
//       "chainCatalog"?: unknown,
//       "chainInstances"?: unknown,
//       "chainFinalProto"?: number,
//     }
//   ]
// }

import { TO_BITS_REGISTRY } from "../packet-resolver";
import type {
  CategoryToken,
  ColorToken,
  ControllerState,
  Field,
  Packet,
  SubField,
} from "../types";

const FORMAT_TAG = "packet-view";
const FORMAT_VERSION = 1;

type LinearLengthFn = {
  kind: "linear";
  scale: number;
  offset: number;
  min?: number;
};

type SerialisedField = {
  id: string;
  name: string;
  bits?: number;
  color?: string;
  category?: string;
  description?: string;
  controlsLength?: string;
  defaultValue?: number;
  min?: number;
  max?: number;
  variable?: true;
  lengthFrom?: string;
  formula?: string;
  lengthFn?: LinearLengthFn;
  subfields?: Array<{ id: string; name: string; bits: number; description?: string }>;
  tlv?: unknown;
  chainCatalog?: unknown;
  chainInstances?: unknown;
  chainFinalProto?: number;
};

type SerialisedPacket = {
  format: typeof FORMAT_TAG;
  version: typeof FORMAT_VERSION;
  name: string;
  rowBits: number;
  description?: string;
  byteOrder?: string;
  controllers?: ControllerState;
  fields: SerialisedField[];
};

/** Field with the optional `formula` key the resolver uses to attach toBits. */
type FieldWithFormula = Field & { formula?: string };

/** Field carrying the opaque TLV / chain bag we pass through unchanged. */
type FieldWithExtras = FieldWithFormula & {
  tlv?: unknown;
  chainCatalog?: unknown;
  chainInstances?: unknown;
  chainFinalProto?: number;
};

export function toJson(packet: Packet, controllers: ControllerState = {}): string {
  const out: SerialisedPacket = {
    format: FORMAT_TAG,
    version: FORMAT_VERSION,
    name: packet.name,
    rowBits: packet.rowBits,
    ...(packet.description ? { description: packet.description } : {}),
    ...(packet.byteOrder ? { byteOrder: packet.byteOrder } : {}),
    controllers: { ...controllers },
    fields: packet.fields.map(serialiseField),
  };
  return JSON.stringify(out, null, 2);
}

export function fromJson(text: string): {
  packet: Packet;
  controllers: ControllerState;
  name?: string;
} {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON: ${(e as Error).message}`);
  }
  if (!data || typeof data !== "object") {
    throw new Error("JSON root must be an object");
  }
  const raw = data as Partial<SerialisedPacket>;
  if (raw.format !== FORMAT_TAG) {
    throw new Error(`Unknown format tag: ${raw.format ?? "(missing)"}`);
  }
  if (raw.version !== FORMAT_VERSION) {
    throw new Error(`Unsupported version: ${raw.version}`);
  }
  if (!Array.isArray(raw.fields) || raw.fields.length === 0) {
    throw new Error("Packet must contain a non-empty `fields` array");
  }

  const packet: Packet = {
    name: String(raw.name || "Imported Packet"),
    rowBits: Number(raw.rowBits) || 32,
    ...(raw.description ? { description: String(raw.description) } : {}),
    ...(raw.byteOrder ? { byteOrder: String(raw.byteOrder) } : {}),
    fields: raw.fields.map(deserialiseField),
  };

  const controllers: ControllerState =
    raw.controllers && typeof raw.controllers === "object"
      ? { ...raw.controllers }
      : {};
  for (const f of packet.fields) {
    if (f.controlsLength && controllers[f.controlsLength] === undefined) {
      controllers[f.controlsLength] = f.defaultValue ?? 0;
    }
  }

  return { packet, controllers, name: packet.name };
}

function serialiseField(field: Field): SerialisedField {
  const src = field as FieldWithExtras;
  const out: SerialisedField = {
    id: field.id,
    name: field.name,
  };
  if (field.color) out.color = field.color;
  if (field.category) out.category = field.category;
  if (field.description) out.description = field.description;

  if (field.variable) {
    out.variable = true;
    if (field.lengthFrom) out.lengthFrom = field.lengthFrom;
    if (src.formula) {
      out.formula = src.formula;
    } else {
      // Best-effort linear inference for legacy / synthetic fields that
      // came in without a formula key.
      out.lengthFn = inferLengthFn(field);
    }
  } else if (typeof field.bits === "number") {
    out.bits = field.bits;
  }

  if (field.controlsLength) {
    out.controlsLength = field.controlsLength;
    if (field.defaultValue !== undefined) out.defaultValue = field.defaultValue;
    if (field.min !== undefined) out.min = field.min;
    if (field.max !== undefined) out.max = field.max;
  }
  if (field.subfields && field.subfields.length > 0) {
    out.subfields = field.subfields.map((sf) => ({
      id: sf.id,
      name: sf.name,
      bits: sf.bits,
      ...(sf.description ? { description: sf.description } : {}),
    }));
  }
  // Pass-through opaque TLV / chain extras so a future TLV editor doesn't
  // lose information on round-trip.
  if (src.tlv !== undefined) out.tlv = src.tlv;
  if (src.chainCatalog !== undefined) out.chainCatalog = src.chainCatalog;
  if (src.chainInstances !== undefined) out.chainInstances = src.chainInstances;
  if (typeof src.chainFinalProto === "number") {
    out.chainFinalProto = src.chainFinalProto;
  }
  return out;
}

function deserialiseField(raw: SerialisedField): Field {
  if (!raw || typeof raw !== "object" || !raw.id || !raw.name) {
    throw new Error("Field must have at least { id, name }");
  }
  const f: FieldWithExtras = {
    id: String(raw.id),
    name: String(raw.name),
  };
  if (raw.color) f.color = String(raw.color) as ColorToken;
  if (raw.category) f.category = String(raw.category) as CategoryToken;
  if (raw.description) f.description = String(raw.description);

  if (raw.variable) {
    f.variable = true;
    if (raw.lengthFrom) f.lengthFrom = String(raw.lengthFrom);
    if (raw.formula) {
      f.formula = String(raw.formula);
      const fn = TO_BITS_REGISTRY[f.formula];
      if (fn) {
        f.toBits = fn;
      } else {
        // Unknown formula: fall back to a zero-bits stub so layout proceeds.
        f.toBits = () => 0;
      }
    } else if (raw.lengthFn) {
      f.toBits = makeLinearFn(raw.lengthFn);
    } else {
      f.toBits = () => 0;
    }
  } else {
    if (typeof raw.bits !== "number" || !Number.isFinite(raw.bits)) {
      throw new Error(`Field "${f.id}" missing numeric bits`);
    }
    f.bits = raw.bits;
  }

  if (raw.controlsLength) {
    f.controlsLength = String(raw.controlsLength);
    if (raw.defaultValue !== undefined) f.defaultValue = Number(raw.defaultValue);
    if (raw.min !== undefined) f.min = Number(raw.min);
    if (raw.max !== undefined) f.max = Number(raw.max);
  }
  if (Array.isArray(raw.subfields)) {
    f.subfields = raw.subfields.map((sf): SubField => ({
      id: String(sf.id),
      name: String(sf.name),
      bits: Number(sf.bits),
      ...(sf.description ? { description: String(sf.description) } : {}),
    }));
  }
  // TLV / chain shapes are passed through opaquely; the resolver re-attaches
  // closures via TLV_FIELDS_REGISTRY at module load. We cast at the boundary.
  if (raw.tlv !== undefined) f.tlv = raw.tlv as Field["tlv"];
  if (raw.chainCatalog !== undefined) f.chainCatalog = raw.chainCatalog as Field["chainCatalog"];
  if (raw.chainInstances !== undefined) f.chainInstances = raw.chainInstances as Field["chainInstances"];
  if (typeof raw.chainFinalProto === "number") {
    f.chainFinalProto = raw.chainFinalProto;
  }
  return f;
}

// ----- linear fit fallback (for legacy exports without `formula`) -----

function inferLengthFn(field: Field): LinearLengthFn {
  if (typeof field.toBits !== "function") {
    return { kind: "linear", scale: 1, offset: 0, min: 0 };
  }
  const probes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 32, 64];
  const samples = probes
    .map((x) => ({ x, y: safeProbe(field.toBits!, x) }))
    .filter((s) => Number.isFinite(s.y));
  if (samples.length < 2) {
    return { kind: "linear", scale: 0, offset: 0, min: 0 };
  }
  const positives = samples.filter((s) => s.y > 0);
  let a: { x: number; y: number };
  let b: { x: number; y: number };
  if (positives.length >= 2) {
    a = positives[0];
    b = positives[positives.length - 1];
  } else {
    a = samples[0];
    b = samples[samples.length - 1];
  }
  if (b.x === a.x) {
    return { kind: "linear", scale: 0, offset: a.y, min: 0 };
  }
  const slope = (b.y - a.y) / (b.x - a.x);
  const intercept = a.y - slope * a.x;
  for (const s of samples) {
    const predicted = Math.max(0, slope * s.x + intercept);
    if (Math.abs(predicted - s.y) > 1e-6) {
      return { kind: "linear", scale: 0, offset: 0, min: 0 };
    }
  }
  return { kind: "linear", scale: slope, offset: intercept, min: 0 };
}

function safeProbe(fn: (x: number) => number, x: number): number {
  try {
    const v = fn(x);
    return typeof v === "number" ? v : NaN;
  } catch {
    return NaN;
  }
}

function makeLinearFn(desc: LinearLengthFn): (x: number) => number {
  const scale = Number(desc.scale) || 0;
  const offset = Number(desc.offset) || 0;
  const min = Number(desc.min) || 0;
  return (x: number) => Math.max(min, scale * Number(x) + offset);
}
