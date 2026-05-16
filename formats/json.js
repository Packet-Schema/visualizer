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
    ...(packet.byteOrder ? { byteOrder: packet.byteOrder } : {}),
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
    ...(data.byteOrder ? { byteOrder: String(data.byteOrder) } : {}),
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
  if (field.category) out.category = field.category;
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
  if (field.subfields && field.subfields.length > 0) {
    out.subfields = field.subfields.map((sf) => ({
      id: sf.id,
      name: sf.name,
      bits: sf.bits,
      ...(sf.description ? { description: sf.description } : {}),
    }));
  }
  if (field.tlv) {
    out.tlv = serializeTlv(field.tlv);
  }
  if (field.chainCatalog) {
    out.chainCatalog = field.chainCatalog.map((c) => ({
      proto: c.proto,
      name: c.name,
      ...(c.description ? { description: c.description } : {}),
      fields: c.fields.map((f) => ({ id: f.id, name: f.name, bits: f.bits })),
    }));
    out.chainInstances = (field.chainInstances || []).map((inst) => ({ proto: inst.proto }));
    if (typeof field.chainFinalProto === "number") {
      out.chainFinalProto = field.chainFinalProto;
    }
  }
  return out;
}

// Serialise a TLV descriptor. Catalog entries are serialised statically using
// a snapshot of their default fields (we don't transport the dynamic
// fieldsFor() closure — instead we record `variableCount` so a deserialiser
// can re-render at a different count). Instances carry their kind + extras.
function serializeTlv(tlv) {
  return {
    catalog: tlv.catalog.map((c) => {
      const out = {
        kind: c.kind,
        name: c.name,
        ...(c.description ? { description: c.description } : {}),
      };
      const sampleExtras = c.defaultExtras || {};
      const fields = typeof c.fieldsFor === "function"
        ? c.fieldsFor(sampleExtras)
        : c.fields;
      out.fields = (fields || []).map((f) => ({
        id: f.id, name: f.name, bits: f.bits,
      }));
      if (c.defaultExtras) out.defaultExtras = { ...c.defaultExtras };
      if (c.variableCount) out.variableCount = { ...c.variableCount };
      return out;
    }),
    instances: (tlv.instances || []).map((inst) => ({
      kind: inst.kind,
      ...(inst.extras ? { extras: { ...inst.extras } } : {}),
    })),
    ...(tlv.padToBoundary ? { padToBoundary: tlv.padToBoundary } : {}),
    ...(tlv.drivesController ? { drivesController: tlv.drivesController } : {}),
    ...(tlv.bytesPerUnit ? { bytesPerUnit: tlv.bytesPerUnit } : {}),
    ...(tlv.baseControllerValue !== undefined ? { baseControllerValue: tlv.baseControllerValue } : {}),
  };
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
  if (raw.category) f.category = String(raw.category);
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
  if (Array.isArray(raw.subfields)) {
    f.subfields = raw.subfields.map((sf) => ({
      id: String(sf.id),
      name: String(sf.name),
      bits: Number(sf.bits),
      ...(sf.description ? { description: String(sf.description) } : {}),
    }));
  }
  if (raw.tlv && typeof raw.tlv === "object") {
    f.tlv = deserializeTlv(raw.tlv);
  }
  if (Array.isArray(raw.chainCatalog)) {
    f.chainCatalog = raw.chainCatalog.map((c) => ({
      proto: Number(c.proto),
      name: String(c.name || `proto ${c.proto}`),
      ...(c.description ? { description: String(c.description) } : {}),
      fields: (c.fields || []).map((cf) => ({
        id: String(cf.id), name: String(cf.name), bits: Number(cf.bits),
      })),
    }));
    f.chainInstances = Array.isArray(raw.chainInstances)
      ? raw.chainInstances.map((inst) => ({ proto: Number(inst.proto) }))
      : [];
    if (typeof raw.chainFinalProto === "number") {
      f.chainFinalProto = raw.chainFinalProto;
    }
  }
  return f;
}

function deserializeTlv(raw) {
  const catalog = (raw.catalog || []).map((c) => {
    const entry = {
      kind: Number(c.kind),
      name: String(c.name || `kind ${c.kind}`),
      ...(c.description ? { description: String(c.description) } : {}),
      fields: (c.fields || []).map((cf) => ({
        id: String(cf.id), name: String(cf.name), bits: Number(cf.bits),
      })),
    };
    if (c.defaultExtras) entry.defaultExtras = { ...c.defaultExtras };
    if (c.variableCount) {
      entry.variableCount = { ...c.variableCount };
      // Rebuild a fieldsFor() that scales the named slot field count linearly.
      // It mimics the runtime catalog entries: [type, length, pointer, ...N slots].
      // Heuristic: any field id matching /^addr\d+$|^ts\d+$|^slot\d+$/ in the
      // baseline is treated as the per-slot template; we reproduce it N times.
      const baseline = entry.fields;
      const baseCount = c.defaultExtras?.count ?? 1;
      const fixedPrefix = baseline.slice(0, baseline.length - baseCount);
      const template = baseline[baseline.length - 1] || { id: "slot", name: "Slot", bits: 32 };
      entry.fieldsFor = ({ count }) => [
        ...fixedPrefix.map((f) => ({ ...f })),
        ...Array.from({ length: count }, (_, i) => ({
          id: template.id.replace(/\d+$/, "") + i,
          name: template.name.replace(/\d+/, String(i + 1)),
          bits: template.bits,
        })),
      ];
    }
    return entry;
  });
  return {
    catalog,
    instances: (raw.instances || []).map((inst) => ({
      kind: Number(inst.kind),
      ...(inst.extras ? { extras: { ...inst.extras } } : {}),
    })),
    ...(raw.padToBoundary ? { padToBoundary: Number(raw.padToBoundary) } : {}),
    ...(raw.drivesController ? { drivesController: String(raw.drivesController) } : {}),
    ...(raw.bytesPerUnit ? { bytesPerUnit: Number(raw.bytesPerUnit) } : {}),
    ...(raw.baseControllerValue !== undefined ? { baseControllerValue: Number(raw.baseControllerValue) } : {}),
  };
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
