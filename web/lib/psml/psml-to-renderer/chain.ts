// IPv6 chain-catalog extraction (PSML → renderer) and round-trip back.
//
// The IPv6 baseline preset models the extension-header chain as
// `Repeat<Switch on nextHeader_proto>`. We detect that by id prefix
// (`*_chain` / `*chain`) and lower it to a renderer `chainCatalog`.

import type { Repeat, Struct, Switch } from "../types";
import type {
  ChainCatalogEntry as RendererChainCatalogEntry,
  Field as RendererField,
} from "../renderer";

import { getSwitchFromRepeat, structFieldsToTlvFields } from "./shared";

type ChainCatalogEntry = RendererChainCatalogEntry;

/**
 * True when `r.id` looks like the IPv6 extension-header chain repeat. The
 * heuristic matches the literal "chain" word so we never confuse a regular
 * Repeat<Switch> (TLV catalog) with the chain shape.
 */
export function isLikelyChainRepeat(r: Repeat): boolean {
  return /(^|_)chain($|[A-Z_])/.test(r.id);
}

export function switchToChainCatalog(sw: Switch): ChainCatalogEntry[] {
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

export function repeatToChainField(r: Repeat): RendererField {
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

/* ----------------------------------------------------------------- *
 * renderer → PSML
 * ----------------------------------------------------------------- */

export function chainEntryToStruct(
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

export function chainFieldToRepeat(field: RendererField): Repeat {
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
