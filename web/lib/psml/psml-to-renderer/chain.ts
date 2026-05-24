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
  // Persisted chain instances ride back into the renderer mirror so the
  // IPv6 ext-header chain survives JSON / share-URL / preset round-trips
  // (symmetric to TLV `instances` — sub-agent HIGH). Unknown-proto
  // entries are filtered with a warn since the renderer can't materialise
  // them without a catalog match.
  const knownProtos = new Set(catalog.map((c) => c.proto));
  const chainInstances = r.chainInstances
    ? r.chainInstances.flatMap((inst) => {
        if (!knownProtos.has(inst.proto)) {
          console.warn(
            `[repeatToChainField] dropping chain instance with unknown proto=${inst.proto} on Repeat "${r.id}" — not present in the catalog.`,
          );
          return [];
        }
        // Carry per-instance extras through round-trip (Codex P2). The
        // PSML schema accepts them and the renderer-side ChainInstance
        // is structurally compatible — keeping them avoids a lossy
        // path through `repeatToChainField → chainFieldToRepeat`.
        return [
          {
            proto: inst.proto,
            ...(inst.extras ? { extras: { ...inst.extras } } : {}),
          },
        ];
      })
    : [];
  const field: RendererField = {
    id: r.id,
    name: r.name ?? r.id,
    bits: 0,
    chainCatalog: catalog,
    chainInstances,
  };
  if (typeof r.chainFinalProto === "number") {
    field.chainFinalProto = r.chainFinalProto;
  }
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
  // `repeatToChainField` carries the source Repeat id straight onto the
  // renderer Field, so a PSML→renderer→PSML round-trip on a chain repeat
  // ends up here with `field.id` already ending in `_chain`. Strip the
  // trailing marker so we don't emit `${name}_chain_chain` (and all of
  // its derived child ids) on the way back to PSML.
  const baseId = field.id.replace(/_chain$/, "");
  const cases: Record<string, Struct> = {};
  for (const entry of field.chainCatalog ?? []) {
    cases[String(entry.proto)] = chainEntryToStruct(baseId, entry);
  }
  // `repeatToChainField` carried the source Repeat name straight onto
  // the renderer Field, so a PSML→renderer→PSML round-trip arrives
  // here with `field.name` already ending in " (chain)". Don't double
  // the suffix — preserving the existing label keeps round-trips
  // idempotent (Copilot review).
  const repeatName = field.name.endsWith(" (chain)")
    ? field.name
    : `${field.name} (chain)`;
  // Symmetric to TLV `instances`: persist chain selections back onto
  // the PSML Repeat so JSON / share URL / "Save as preset" all carry
  // the user's chosen extension headers (sub-agent HIGH).
  const chainInstances = (field.chainInstances ?? []).map((inst) => ({
    proto: inst.proto,
  }));
  return {
    kind: "repeat",
    id: `${baseId}_chain`,
    name: repeatName,
    category: "type",
    doc: "IPv6 extension-header chain.",
    element: {
      id: `${baseId}_chainRecord`,
      fields: [
        {
          kind: "switch",
          id: `${baseId}_byProto`,
          on: { kind: "ref", field: `${baseId}_proto` },
          cases,
        },
      ],
    },
    count: { kind: "ref", field: `${baseId}_chainCount` },
    ...(chainInstances.length > 0 ? { chainInstances } : {}),
    ...(typeof field.chainFinalProto === "number"
      ? { chainFinalProto: field.chainFinalProto }
      : {}),
  };
}
