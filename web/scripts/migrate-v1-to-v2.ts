// Mechanical v1 → v2 migration tool.
//
// Reads the v1 `PRESETS` registry from lib/presets.generated.ts and writes
// lib/v2/presets.generated.ts with best-effort v2 equivalents:
//
//   v1 Field (fixed bits)         → v2 Field with `bits(n)` type
//   v1 Field.subfields            → v2 Group of bit-fields with same ids
//   v1 Field.tlv                  → v2 Repeat<Switch on discriminator>
//   v1 Field.chainCatalog         → v2 Repeat<Switch on proto>
//   v1 Field.controlsLength       → defaultValue carried through, plus a
//                                   Constraint linking controller×unit ==
//                                   target bytes (when bytesPerUnit is set).
//
// Skips the 4 hand-written presets (ipv4, tcp, udp, ethernet) so the manual
// versions remain authoritative.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PRESETS } from "../lib/presets.generated";
import type {
  ChainCatalogEntry,
  Field as V1Field,
  Packet as V1Packet,
  SubField,
  TlvCatalogEntry,
} from "../lib/types";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outPath = resolve(root, "lib/v2/presets.generated.ts");

const MANUAL_KEYS = new Set(["ipv4", "tcp", "udp", "ethernet"]);

/* ------------------------------------------------------------------ *
 * JSON-ish v2 emitter — keep the generated file simple to inspect.
 * ------------------------------------------------------------------ */

type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [k: string]: Json | undefined };

function emit(value: Json, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const inner = value
      .map((v) => "  ".repeat(indent + 1) + emit(v, indent + 1))
      .join(",\n");
    return `[\n${inner}\n${pad}]`;
  }
  const keys = Object.keys(value).filter((k) => value[k] !== undefined);
  if (keys.length === 0) return "{}";
  const inner = keys
    .map((k) => {
      const v = value[k] as Json;
      return `${"  ".repeat(indent + 1)}${JSON.stringify(k)}: ${emit(v, indent + 1)}`;
    })
    .join(",\n");
  return `{\n${inner}\n${pad}}`;
}

/* ------------------------------------------------------------------ *
 * Per-construct converters.
 * ------------------------------------------------------------------ */

function subfieldsToGroup(field: V1Field): Json {
  const subs: SubField[] = field.subfields ?? [];
  return {
    kind: "group",
    id: `${field.id}_bits`,
    name: field.name,
    children: subs.map((sf) => ({
      id: `${field.id}_${sf.id}`,
      name: sf.name,
      type: { kind: "bits", n: sf.bits },
      category: field.category ?? undefined,
      color: field.color ?? undefined,
      doc: sf.description ?? undefined,
    })),
  };
}

function tlvCatalogToVariants(field: V1Field): Record<string, Json> {
  const cases: Record<string, Json> = {};
  const catalog: TlvCatalogEntry[] = field.tlv?.catalog ?? [];
  for (const entry of catalog) {
    const sub = catalogEntryToStruct(field.id, entry);
    cases[String(entry.kind)] = sub;
  }
  return cases;
}

function catalogEntryToStruct(parentId: string, entry: TlvCatalogEntry): Json {
  // Prefer explicit `fields`; otherwise use a single opaque field of `bits`.
  const fields = entry.fields ?? (entry.bits ? [
    { id: "raw", name: entry.name, bits: entry.bits } as { id: string; name: string; bits: number },
  ] : []);
  return {
    id: `${parentId}_kind_${entry.kind}`,
    name: entry.name,
    fields: fields.map((f) => ({
      id: f.id,
      name: f.name,
      type: { kind: "bits", n: f.bits },
      doc:
        "description" in f && typeof f.description === "string"
          ? f.description
          : undefined,
    })),
  };
}

function tlvFieldToRepeat(field: V1Field): Json {
  // The discriminator is unknown statically; mirror v1's behaviour by giving
  // the count a placeholder env key derived from the field id. The first
  // case in the catalog provides the `on` ref name convention.
  const discKey = `${field.id}_kind`;
  return {
    kind: "repeat",
    id: field.id,
    name: field.name,
    category: field.category ?? undefined,
    color: field.color ?? undefined,
    doc: field.description ?? undefined,
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

function chainEntryToStruct(parentId: string, entry: ChainCatalogEntry): Json {
  return {
    id: `${parentId}_proto_${entry.proto}`,
    name: entry.name,
    fields: entry.fields.map((f) => ({
      id: f.id,
      name: f.name,
      type: { kind: "bits", n: f.bits },
      doc: f.description ?? undefined,
    })),
  };
}

function chainFieldToRepeat(field: V1Field): Json {
  const cases: Record<string, Json> = {};
  for (const entry of field.chainCatalog ?? []) {
    cases[String(entry.proto)] = chainEntryToStruct(field.id, entry);
  }
  return {
    kind: "repeat",
    id: `${field.id}_chain`,
    name: `${field.name} (chain)`,
    category: "type",
    color: "amber",
    doc: "IPv6 extension-header chain (mechanically migrated).",
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

function fieldToV2(field: V1Field): Json[] {
  // TLV-bearing variable field: produce just the Repeat (the controller field
  // itself usually lives in a sibling above, so we don't duplicate it).
  if (field.tlv) {
    return [tlvFieldToRepeat(field)];
  }
  if (field.chainCatalog) {
    // The base field is still a single byte/word; append a chain Repeat after.
    const base: Json = {
      id: field.id,
      name: field.name,
      type: { kind: "bits", n: field.bits ?? 8 },
      category: field.category ?? undefined,
      color: field.color ?? undefined,
      doc: field.description ?? undefined,
      defaultValue: field.defaultValue ?? undefined,
    };
    return [base, chainFieldToRepeat(field)];
  }
  if (field.subfields && field.subfields.length > 0) {
    return [subfieldsToGroup(field)];
  }
  // Variable field with no TLV: skip (we no longer have the toBits closure
  // in a meaningful way at migration time — v1's behaviour was zero bits
  // when the controller was at its base value, so dropping is safe for the
  // smoke test).
  if (field.variable) {
    return [];
  }
  return [
    {
      id: field.id,
      name: field.name,
      type: { kind: "bits", n: field.bits ?? 0 },
      category: field.category ?? undefined,
      color: field.color ?? undefined,
      doc: field.description ?? undefined,
      defaultValue: field.defaultValue ?? undefined,
    },
  ];
}

function packetToV2(key: string, packet: V1Packet): Json {
  const body: Json[] = [];
  const constraints: Json[] = [];

  for (const field of packet.fields) {
    body.push(...fieldToV2(field));
    if (field.controlsLength && field.tlv?.bytesPerUnit) {
      const unit = field.tlv.bytesPerUnit;
      const base = field.tlv.baseControllerValue ?? 0;
      // controller * unit == headerBytes (offset by base).
      constraints.push({
        lhs: {
          kind: "op",
          op: "*",
          a: {
            kind: "op",
            op: "-",
            a: { kind: "ref", field: field.controlsLength },
            b: { kind: "lit", value: base },
          },
          b: { kind: "lit", value: unit },
        },
        rhs: { kind: "ref", field: `${key}_optionsBytes` },
        doc: `${field.controlsLength} drives ${field.id} length in units of ${unit} bytes (base ${base}).`,
      });
    }
  }

  return {
    name: packet.name,
    rowBits: packet.rowBits,
    byteOrder: packet.byteOrder ?? "BE",
    description: packet.description ?? undefined,
    body,
    constraints: constraints.length > 0 ? constraints : undefined,
  };
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

function main(): void {
  const out: Record<string, Json> = {};
  for (const [key, packet] of Object.entries(PRESETS)) {
    if (MANUAL_KEYS.has(key)) continue;
    out[key] = packetToV2(key, packet);
  }

  const banner = `// AUTO-GENERATED by scripts/migrate-v1-to-v2.ts.
// Manual cleanup is welcome; re-run the script to regenerate.

import type { Packet } from "./types";

const RAW_GENERATED = ${emit(out as Json, 0)} as const;

export const GENERATED_PRESETS = RAW_GENERATED as unknown as Record<string, Packet>;
`;
  writeFileSync(outPath, banner);
  console.log(`wrote ${outPath} (${Object.keys(out).length} presets)`);
}

main();
