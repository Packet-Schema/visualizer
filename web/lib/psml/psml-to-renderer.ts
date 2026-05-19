// PSML 0.3 — PSML → renderer adapter.
//
// Lowers a PSML Packet to the renderer Packet shape consumed by React
// components (DetailPanel, ControlsPanel, TlvEditor, ChainEditor,
// DependencyOverlay, …). The renderer model is intentionally lossier than
// PSML: Repeat<Switch> TLV catalogs are flattened to a `tlv` extension on a
// single variable-length placeholder Field, subfield Groups collapse to a
// `subfields[]` array, etc. The PSML Packet is still the canonical source —
// `resolveLayout(packet, …)` is the path for cell positioning, and PSML
// alone drives serialization through `lib/formats/*`.
//
// TLV catalog extraction:
//   * A Repeat whose element is a single Switch with `cases` keyed by
//     numeric strings becomes a renderer `tlv` field. The Switch's `on`
//     ref drives the discriminator name, and each case's Struct fields
//     become TlvCatalogEntry.fields.
//
// IPv6 chain extraction:
//   * The IPv6 baseline preset models the ext-header chain as
//     `Repeat<Switch on nextHeader_proto>`. We detect that by id prefix
//     (`*_chain` / `*chain`) and lower it to a renderer `chainCatalog`.
//
// Subfield extraction:
//   * Any top-level Group whose direct children are leaf fields becomes a
//     single renderer Field with subfields[].

import { evalExpr, MissingRefError } from "./expr";
import type {
  Container,
  Field as PsmlField,
  Group,
  Packet as PsmlPacket,
  Repeat,
  Struct,
  Switch,
} from "./types";
import type {
  ChainCatalogEntry as RendererChainCatalogEntry,
  Field as RendererField,
  Packet as RendererPacket,
  SubField,
  TlvCatalogEntry as RendererTlvCatalogEntry,
  TlvCatalogField,
} from "./renderer";

// Local aliases for inline references.
type ChainCatalogEntry = RendererChainCatalogEntry;
type TlvCatalogEntry = RendererTlvCatalogEntry;

function isField(c: Container): c is PsmlField {
  return !("kind" in c) || c.kind === "field";
}

function typeBits(type: PsmlField["type"]): number {
  switch (type.kind) {
    case "int":
    case "enum":
      return type.bits;
    case "bits":
      return type.n;
    case "bytes":
      try {
        return evalExpr(type.n, new Map()) * 8;
      } catch (e) {
        if (e instanceof MissingRefError) return 0;
        throw e;
      }
    case "varint":
      return 0;
    case "berLength":
      // PSML 0.4 — width is dynamic. Treat as 0 at design time; layout
      // adapters consult the env for a concrete width.
      return 0;
  }
}

function structFieldsToTlvFields(struct: Struct): TlvCatalogField[] {
  const out: TlvCatalogField[] = [];
  for (const child of struct.fields) {
    if (isField(child)) {
      const bits = typeBits(child.type);
      const entry: TlvCatalogField = { id: child.id, name: child.name, bits };
      if (child.doc) entry.description = child.doc;
      out.push(entry);
    }
    // Nested compound containers are skipped — PSML preset authors keep
    // TLV cases flat. If we encounter one, render the case as the leaves
    // we can extract.
  }
  return out;
}

/** True when this Repeat's element is just a single Switch (the PSML
 *  idiom for a TLV catalog). */
function isTlvRepeat(r: Repeat): boolean {
  if (r.element.fields.length !== 1) return false;
  const first = r.element.fields[0];
  return "kind" in first && first.kind === "switch";
}

function getSwitchFromRepeat(r: Repeat): Switch | null {
  const first = r.element.fields[0];
  if ("kind" in first && first.kind === "switch") return first;
  return null;
}

function isLikelyChainRepeat(r: Repeat): boolean {
  // The IPv6 baseline preset uses id `nextHeader_chain` for the chain Repeat.
  // Treat any repeat whose id contains `_chain` or starts with `chain` as a
  // chain. A real packet uses one or the other but never a TLV-style options
  // list — keep the heuristic surgical.
  return /(^|_)chain($|[A-Z_])/.test(r.id);
}

function switchToTlvCatalog(sw: Switch): TlvCatalogEntry[] {
  const out: TlvCatalogEntry[] = [];
  for (const [key, struct] of Object.entries(sw.cases)) {
    const kindNum = Number(key);
    if (!Number.isFinite(kindNum)) continue;
    const fields = structFieldsToTlvFields(struct);
    const bitsTotal = fields.reduce((acc, f) => acc + f.bits, 0);
    const entry: TlvCatalogEntry = {
      kind: kindNum,
      name: struct.name ?? `kind ${kindNum}`,
      fields,
    };
    if (fields.length === 0) {
      entry.bits = bitsTotal;
    }
    out.push(entry);
  }
  return out;
}

function switchToChainCatalog(sw: Switch): ChainCatalogEntry[] {
  const out: ChainCatalogEntry[] = [];
  for (const [key, struct] of Object.entries(sw.cases)) {
    const protoNum = Number(key);
    if (!Number.isFinite(protoNum)) continue;
    out.push({
      proto: protoNum,
      name: struct.name ?? `proto ${protoNum}`,
      fields: structFieldsToTlvFields(struct),
    });
  }
  return out;
}

function repeatToTlvField(r: Repeat): RendererField {
  const sw = getSwitchFromRepeat(r);
  const catalog = sw ? switchToTlvCatalog(sw) : [];
  const field: RendererField = {
    id: r.id,
    name: r.name ?? r.id,
    variable: true,
    tlv: {
      catalog,
      instances: [],
      drivesController: `${r.id}_count`,
      bytesPerUnit: 1,
      baseControllerValue: 0,
    },
    lengthFrom: `${r.id}_count`,
    formula: "psml_repeat",
    toBits: () => 0,
  };
  if (r.category) field.category = r.category;
  if (r.doc) field.description = r.doc;
  return field;
}

function repeatToChainField(r: Repeat): RendererField {
  const sw = getSwitchFromRepeat(r);
  const catalog = sw ? switchToChainCatalog(sw) : [];
  const field: RendererField = {
    id: r.id,
    name: r.name ?? r.id,
    bits: 0,
    chainCatalog: catalog,
    chainInstances: [],
  };
  if (r.category) field.category = r.category;
  if (r.doc) field.description = r.doc;
  return field;
}

function groupToSubfieldField(g: Group): RendererField | null {
  const subs: SubField[] = [];
  let total = 0;
  let category: RendererField["category"];
  for (const child of g.children) {
    if (!isField(child)) return null;
    const bits = typeBits(child.type);
    const sf: SubField = { id: child.id, name: child.name, bits };
    if (child.doc) sf.description = child.doc;
    subs.push(sf);
    total += bits;
    if (child.category && !category) category = child.category;
  }
  if (subs.length === 0) return null;
  const out: RendererField = {
    id: g.id,
    name: g.name ?? g.id,
    bits: total,
    subfields: subs,
  };
  if (category) out.category = category;
  return out;
}

function plainFieldToRenderer(f: PsmlField): RendererField {
  const out: RendererField = {
    id: f.id,
    name: f.name,
    bits: typeBits(f.type),
  };
  if (f.category) out.category = f.category;
  if (f.doc) out.description = f.doc;
  if (f.defaultValue !== undefined) out.defaultValue = f.defaultValue;
  return out;
}

/**
 * Inspect a Constraint to discover field controller relations of the form
 * `ref(fieldA) * lit(N) == ref(fieldB)` (or the symmetric form). When such a
 * shape is found, return `{ fromId: fieldA, controlsName: fieldB }` so the
 * caller can tag fieldA's renderer Field with `controlsLength: fieldB`.
 */
function constraintToController(constraint: {
  lhs: { kind: string; field?: string; op?: string; a?: unknown; b?: unknown };
  rhs: { kind: string; field?: string; op?: string; a?: unknown; b?: unknown };
}): { fromId: string; controlsName: string } | null {
  const tryMatch = (
    mul: typeof constraint.lhs,
    target: typeof constraint.rhs,
  ): { fromId: string; controlsName: string } | null => {
    if (target.kind !== "ref" || typeof target.field !== "string") return null;
    if (mul.kind === "ref" && typeof mul.field === "string") {
      return { fromId: mul.field, controlsName: target.field };
    }
    if (mul.kind === "op" && mul.op === "*") {
      const a = mul.a as { kind: string; field?: string };
      const b = mul.b as { kind: string; field?: string };
      if (a.kind === "ref" && typeof a.field === "string") {
        return { fromId: a.field, controlsName: target.field };
      }
      if (b.kind === "ref" && typeof b.field === "string") {
        return { fromId: b.field, controlsName: target.field };
      }
    }
    return null;
  };
  return (
    tryMatch(constraint.lhs, constraint.rhs) ??
    tryMatch(constraint.rhs, constraint.lhs)
  );
}

/**
 * Walk the PSML body and produce a renderer-shaped Packet. Top-level
 * Repeat<Switch> nodes that look like TLV catalogs / chain catalogs are
 * promoted to renderer fields with `tlv` / `chainCatalog` populated so
 * TlvEditor and ChainEditor keep working. Groups whose direct children are
 * all leaf fields collapse to a single subfield-bearing renderer field.
 *
 * Nested Encrypted containers are skipped here — they contribute layout
 * cells via `resolveLayout`, not editor metadata.
 */
export function psmlToRenderer(packet: PsmlPacket): RendererPacket {
  const fields: RendererField[] = [];
  for (const c of packet.body) {
    if (isField(c)) {
      fields.push(plainFieldToRenderer(c));
      continue;
    }
    if (c.kind === "group") {
      const flat = groupToSubfieldField(c);
      if (flat) fields.push(flat);
      continue;
    }
    if (c.kind === "repeat") {
      if (isLikelyChainRepeat(c)) {
        fields.push(repeatToChainField(c));
      } else if (isTlvRepeat(c)) {
        fields.push(repeatToTlvField(c));
      }
      continue;
    }
    if (c.kind === "switch") {
      // Bare Switch — flatten to a placeholder.
      fields.push({ id: c.id, name: c.name ?? c.id, bits: 0 });
      continue;
    }
    if (c.kind === "encrypted") {
      // Surface as a single field placeholder so the DetailPanel can name
      // it. The actual cell layout (and headerProtected/encrypted flags)
      // comes from `resolveLayout`, not this adapter.
      const fld: RendererField = {
        id: c.id,
        name: c.name ?? c.id,
        bits: 0,
      };
      if (c.category) fld.category = c.category;
      if (c.doc) fld.description = c.doc;
      fields.push(fld);
      continue;
    }
  }
  // Stitch controller annotations onto the renderer fields by scanning the
  // PSML constraints. This lets ControlsPanel surface IHL / Data Offset as
  // length-driving sliders the same way the legacy preset model did.
  // The slider writes its value back under the field's own id; the layout
  // step is responsible for deriving any downstream Repeat counts from it.
  if (packet.constraints) {
    for (const c of packet.constraints) {
      const match = constraintToController(
        c as Parameters<typeof constraintToController>[0],
      );
      if (!match) continue;
      const target = fields.find((f) => f.id === match.fromId);
      if (target && !target.controlsLength) {
        target.controlsLength = match.fromId;
        if (target.bits != null) {
          target.max = Math.max(target.max ?? 0, 2 ** target.bits - 1);
        }
      }
    }
  }
  return {
    name: packet.name,
    rowBits: packet.rowBits,
    fields,
    ...(packet.description ? { description: packet.description } : {}),
    ...(packet.byteOrder ? { byteOrder: packet.byteOrder } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * renderer → PSML
 *
 * Used by ImportExportDrawer to round-trip a renderer
 * packet back into a PSML Packet for the format hub. The mapping is faithful
 * but lossy: subfield Groups round-trip, TLV/chain catalogs round-trip as
 * Repeat<Switch>, plain fields round-trip as Field. Constraints and
 * Encrypted containers cannot be reconstructed from the renderer model and
 * are therefore omitted on the return trip — round-tripping is only needed
 * for renderer-authored packets (which never carry an Encrypted container).
 * ------------------------------------------------------------------ */

function rendererSubfieldsToGroup(field: RendererField): Group {
  const subs: SubField[] = field.subfields ?? [];
  return {
    kind: "group",
    id: `${field.id}_bits`,
    name: field.name,
    children: subs.map((sf) => ({
      id: `${field.id}_${sf.id}`,
      name: sf.name,
      type: { kind: "bits", n: sf.bits },
      ...(field.category ? { category: field.category } : {}),
      ...(sf.description ? { doc: sf.description } : {}),
    })),
  };
}

function tlvCatalogEntryToStruct(
  parentId: string,
  entry: TlvCatalogEntry,
): Struct {
  const baseFields =
    entry.fields ??
    (entry.bits
      ? [{ id: "raw", name: entry.name, bits: entry.bits } as TlvCatalogField]
      : []);
  return {
    id: `${parentId}_kind_${entry.kind}`,
    name: entry.name,
    fields: baseFields.map((f) => ({
      id: f.id,
      name: f.name,
      type: { kind: "bits", n: f.bits },
      ...(f.description ? { doc: f.description } : {}),
    })),
  };
}

function tlvFieldToRepeat(field: RendererField): Repeat {
  const discKey = `${field.id}_kind`;
  const cases: Record<string, Struct> = {};
  for (const entry of field.tlv?.catalog ?? []) {
    cases[String(entry.kind)] = tlvCatalogEntryToStruct(field.id, entry);
  }
  return {
    kind: "repeat",
    id: field.id,
    name: field.name,
    ...(field.category ? { category: field.category } : {}),
    ...(field.description ? { doc: field.description } : {}),
    element: {
      id: `${field.id}_record`,
      fields: [
        {
          kind: "switch",
          id: `${field.id}_byKind`,
          on: { kind: "ref", field: discKey },
          cases,
        },
      ],
    },
    count: { kind: "ref", field: `${field.id}_count` },
  };
}

function chainEntryToStruct(
  parentId: string,
  entry: ChainCatalogEntry,
): Struct {
  return {
    id: `${parentId}_proto_${entry.proto}`,
    name: entry.name,
    fields: entry.fields.map((f) => ({
      id: f.id,
      name: f.name,
      type: { kind: "bits", n: f.bits },
      ...(f.description ? { doc: f.description } : {}),
    })),
  };
}

function chainFieldToRepeat(field: RendererField): Repeat {
  const cases: Record<string, Struct> = {};
  for (const entry of field.chainCatalog ?? []) {
    cases[String(entry.proto)] = chainEntryToStruct(field.id, entry);
  }
  return {
    kind: "repeat",
    id: `${field.id}_chain`,
    name: `${field.name} (chain)`,
    category: "type",
    doc: "IPv6 extension-header chain.",
    element: {
      id: `${field.id}_chainRecord`,
      fields: [
        {
          kind: "switch",
          id: `${field.id}_byProto`,
          on: { kind: "ref", field: `${field.id}_proto` },
          cases,
        },
      ],
    },
    count: { kind: "ref", field: `${field.id}_chainCount` },
  };
}

function rendererFieldToPsml(field: RendererField): Container[] {
  if (field.tlv) return [tlvFieldToRepeat(field)];
  if (field.chainCatalog) {
    const base: Container = {
      id: field.id,
      name: field.name,
      type: { kind: "bits", n: field.bits ?? 8 },
      ...(field.category ? { category: field.category } : {}),
      ...(field.description ? { doc: field.description } : {}),
      ...(field.defaultValue !== undefined
        ? { defaultValue: field.defaultValue }
        : {}),
    };
    return [base, chainFieldToRepeat(field)];
  }
  if (field.subfields && field.subfields.length > 0) {
    return [rendererSubfieldsToGroup(field)];
  }
  if (field.variable) {
    return [];
  }
  return [
    {
      id: field.id,
      name: field.name,
      type: { kind: "bits", n: field.bits ?? 0 },
      ...(field.category ? { category: field.category } : {}),
      ...(field.description ? { doc: field.description } : {}),
      ...(field.defaultValue !== undefined
        ? { defaultValue: field.defaultValue }
        : {}),
    },
  ];
}

/** Lift a renderer-shaped Packet back to PSML (lossy for variable-length
 *  payloads without TLV metadata, and for any Encrypted/Constraint state
 *  that was never representable in the renderer model). */
export function rendererToPsml(packet: RendererPacket): PsmlPacket {
  const body: Container[] = [];
  for (const field of packet.fields) {
    body.push(...rendererFieldToPsml(field));
  }
  return {
    name: packet.name,
    rowBits: packet.rowBits,
    byteOrder: packet.byteOrder ?? "BE",
    ...(packet.description ? { description: packet.description } : {}),
    body,
  };
}
