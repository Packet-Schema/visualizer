// JSON import / export — round-trip format for Packet View.
//
// Schema (version 1):
// {
//   "format": "packet-view",
//   "version": 1,
//   "name": string,                 // human-readable packet name
//   "rowBits": number,              // diagram width in bits (typically 32)
//   "description"?: string,
//   "controllers"?: { [key]: number }, // current controller numeric values
//   "fields": [
//     {
//       "id": string,
//       "name": string,
//       "bits"?: number,            // for fixed-width fields
//       "color"?: string,
//       "description"?: string,
//
//       // Variable-length controller (this field's value drives others):
//       "controlsLength"?: string,  // controller key
//       "defaultValue"?: number,
//       "min"?: number,
//       "max"?: number,
//
//       // Variable-length field (driven by another controller):
//       "variable"?: true,
//       "lengthFrom"?: string,      // controller key
//       // The bits-from-controller relationship is encoded as a small
//       // descriptor so we don't have to serialize a function:
//       //   { kind: "linear", scale: number, offset: number, min?: number }
//       //   bits = max(min ?? 0, controllerValue * scale + offset)
//       "lengthFn"?: { kind: "linear", scale: number, offset: number, min?: number },
//     }
//   ]
// }
//
// Round-trip: toJson(packet, controllers) -> string ;
//             fromJson(string)             -> { packet, controllers }
//
// The returned packet is structurally identical to a PACKETS entry
// (variable fields rebuild a `toBits` closure from `lengthFn`).

const FORMAT_TAG = "packet-view";
const FORMAT_VERSION = 1;

export function toJson(packet, controllers = {}) {
  const out = {
    format: FORMAT_TAG,
    version: FORMAT_VERSION,
    name: packet.name,
    rowBits: packet.rowBits,
    ...(packet.description ? { description: packet.description } : {}),
    controllers: { ...controllers },
    fields: packet.fields.map(serializeField),
  };
  return JSON.stringify(out, null, 2);
}

export function fromJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e.message}`);
  }
  if (!data || typeof data !== "object") {
    throw new Error("JSON root must be an object");
  }
  if (data.format !== FORMAT_TAG) {
    throw new Error(`Unknown format tag: ${data.format ?? "(missing)"}`);
  }
  if (data.version !== FORMAT_VERSION) {
    throw new Error(`Unsupported version: ${data.version}`);
  }
  if (!Array.isArray(data.fields) || data.fields.length === 0) {
    throw new Error("Packet must contain a non-empty `fields` array");
  }

  const packet = {
    name: String(data.name || "Imported Packet"),
    rowBits: Number(data.rowBits) || 32,
    description: data.description || "",
    fields: data.fields.map(deserializeField),
  };
  const controllers =
    data.controllers && typeof data.controllers === "object"
      ? { ...data.controllers }
      : {};
  // Backfill missing controller defaults from controlsLength fields.
  for (const f of packet.fields) {
    if (f.controlsLength && controllers[f.controlsLength] === undefined) {
      controllers[f.controlsLength] = f.defaultValue ?? 0;
    }
  }
  return { packet, controllers };
}

function serializeField(field) {
  const out = {
    id: field.id,
    name: field.name,
  };
  if (field.color) out.color = field.color;
  if (field.description) out.description = field.description;

  if (field.variable) {
    out.variable = true;
    if (field.lengthFrom) out.lengthFrom = field.lengthFrom;
    out.lengthFn = inferLengthFn(field);
  } else if (typeof field.bits === "number") {
    out.bits = field.bits;
  }

  if (field.controlsLength) {
    out.controlsLength = field.controlsLength;
    if (field.defaultValue !== undefined) out.defaultValue = field.defaultValue;
    if (field.min !== undefined) out.min = field.min;
    if (field.max !== undefined) out.max = field.max;
  }
  return out;
}

function deserializeField(raw) {
  if (!raw || typeof raw !== "object" || !raw.id || !raw.name) {
    throw new Error("Field must have at least { id, name }");
  }
  const f = {
    id: String(raw.id),
    name: String(raw.name),
  };
  if (raw.color) f.color = String(raw.color);
  if (raw.description) f.description = String(raw.description);

  if (raw.variable) {
    f.variable = true;
    f.lengthFrom = raw.lengthFrom ? String(raw.lengthFrom) : null;
    const fn = raw.lengthFn || { kind: "linear", scale: 1, offset: 0, min: 0 };
    f.toBits = makeLinearFn(fn);
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
  return f;
}

// Try to infer linear (scale, offset, min) from a runtime toBits().
// We assume the function has the shape  bits = max(0, scale*x + offset).
// Strategy: probe a range of inputs; pick two probes where the *output* is
// strictly positive and distinct so the max-clamp doesn't distort the fit.
// If we can't find two such points, the function is effectively constant,
// emit { scale: 0, offset: <observed>, min: 0 }.
function inferLengthFn(field) {
  if (typeof field.toBits !== "function") {
    return { kind: "linear", scale: 1, offset: 0, min: 0 };
  }
  const probes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 32, 64];
  const samples = probes
    .map((x) => ({ x, y: safeProbe(field.toBits, x) }))
    .filter((s) => Number.isFinite(s.y));
  if (samples.length < 2) {
    return { kind: "linear", scale: 0, offset: 0, min: 0 };
  }
  // Prefer two positive, distinct-y samples for the fit.
  const positives = samples.filter((s) => s.y > 0);
  let a, b;
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
  // Verify linearity (with the max(0, ...) clamp) across all samples.
  for (const s of samples) {
    const predicted = Math.max(0, slope * s.x + intercept);
    if (Math.abs(predicted - s.y) > 1e-6) {
      // Non-linear; safe fallback (constant 0).
      return { kind: "linear", scale: 0, offset: 0, min: 0 };
    }
  }
  return { kind: "linear", scale: slope, offset: intercept, min: 0 };
}

function safeProbe(fn, x) {
  try {
    const v = fn(x);
    return typeof v === "number" ? v : NaN;
  } catch {
    return NaN;
  }
}

function makeLinearFn(desc) {
  const scale = Number(desc.scale) || 0;
  const offset = Number(desc.offset) || 0;
  const min = Number(desc.min) || 0;
  return (x) => Math.max(min, scale * Number(x) + offset);
}
