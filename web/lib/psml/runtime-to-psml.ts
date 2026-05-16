// PSML 0.2 — runtime → PSML adapter.
//
// Converts a runtime Packet (the v1-shaped renderer model with TLV/chain/
// subfield extras) into a PSML Packet for the format hub. The mapping is
// deliberately faithful, not creative: subfields become a Group of bit-
// fields, TLV-bearing fields become a Repeat<Switch on disc> over the
// catalog, IPv6 chains become a Repeat<Switch on proto>. Variable-length
// fields without a TLV (e.g. payloads) collapse to an empty placeholder
// because the runtime expressed length via a closure (`toBits`) which has
// no PSML equivalent without re-deriving it from the packet text.
//
// PSML carries semantic intent only — `color` is intentionally dropped on
// conversion. The renderer's category → CSS variable mapping lives in
// `web/lib/render-tokens.ts`.

import type {
  ChainCatalogEntry,
  Field as RuntimeField,
  Packet as RuntimePacket,
  SubField,
  TlvCatalogEntry,
} from "./runtime-types";
import type {
  Container,
  Group,
  Packet as PsmlPacket,
  Repeat,
  Struct,
} from "./types";

/* ------------------------------------------------------------------ *
 * Per-construct converters
 * ------------------------------------------------------------------ */

function subfieldsToGroup(field: RuntimeField): Group {
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

function tlvCatalogToVariants(field: RuntimeField): Record<string, Struct> {
  const cases: Record<string, Struct> = {};
  const catalog: TlvCatalogEntry[] = field.tlv?.catalog ?? [];
  for (const entry of catalog) {
    cases[String(entry.kind)] = catalogEntryToStruct(field.id, entry);
  }
  return cases;
}

function catalogEntryToStruct(parentId: string, entry: TlvCatalogEntry): Struct {
  const baseFields = entry.fields ??
    (entry.bits
      ? [{ id: "raw", name: entry.name, bits: entry.bits }]
      : []);
  return {
    id: `${parentId}_kind_${entry.kind}`,
    name: entry.name,
    fields: baseFields.map((f) => ({
      id: f.id,
      name: f.name,
      type: { kind: "bits", n: f.bits },
      ...("description" in f && f.description ? { doc: f.description } : {}),
    })),
  };
}

function tlvFieldToRepeat(field: RuntimeField): Repeat {
  const discKey = `${field.id}_kind`;
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
          cases: tlvCatalogToVariants(field),
        },
      ],
    },
    count: { kind: "ref", field: `${field.id}_count` },
  };
}

function chainEntryToStruct(parentId: string, entry: ChainCatalogEntry): Struct {
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

function chainFieldToRepeat(field: RuntimeField): Repeat {
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

function fieldToPsml(field: RuntimeField): Container[] {
  if (field.tlv) return [tlvFieldToRepeat(field)];
  if (field.chainCatalog) {
    const base: Container = {
      id: field.id,
      name: field.name,
      type: { kind: "bits", n: field.bits ?? 8 },
      ...(field.category ? { category: field.category } : {}),
      ...(field.description ? { doc: field.description } : {}),
      ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
    };
    return [base, chainFieldToRepeat(field)];
  }
  if (field.subfields && field.subfields.length > 0) {
    return [subfieldsToGroup(field)];
  }
  if (field.variable) {
    // Variable field without TLV — the runtime expressed length via a closure
    // which has no PSML equivalent at conversion time. Skip; for a true
    // round-trip the PSML schema would carry the controller relation.
    return [];
  }
  return [
    {
      id: field.id,
      name: field.name,
      type: { kind: "bits", n: field.bits ?? 0 },
      ...(field.category ? { category: field.category } : {}),
      ...(field.description ? { doc: field.description } : {}),
      ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
    },
  ];
}

/** Convert a runtime Packet (v1-shape) to a PSML Packet. */
export function runtimeToPsml(packet: RuntimePacket): PsmlPacket {
  const body: Container[] = [];
  for (const field of packet.fields) {
    body.push(...fieldToPsml(field));
  }
  return {
    name: packet.name,
    rowBits: packet.rowBits,
    byteOrder: packet.byteOrder ?? "BE",
    ...(packet.description ? { description: packet.description } : {}),
    body,
  };
}
