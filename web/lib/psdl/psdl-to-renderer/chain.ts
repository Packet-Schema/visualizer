// IPv6 chain-catalog extraction (PSDL → renderer) and round-trip back.
//
// The IPv6 baseline preset models the extension-header chain as
// `Repeat<Switch on nextHeader_proto>`. We detect that by id prefix
// (`*_chain` / `*chain`) and lower it to a renderer `chainCatalog`.

import type { Repeat, Struct, Switch } from "../types";
import type {
  ChainCatalogEntry as RendererChainCatalogEntry,
  Field as RendererField,
} from "../renderer";

import { isField } from "../utils";
import {
  firstCaseKeyValue,
  getSwitchFromRepeat,
  structFieldsToTlvFields,
} from "./shared";

type ChainCatalogEntry = RendererChainCatalogEntry;

/**
 * Structural test for a forward-linked chain repeat (IPv6 extension headers).
 *
 * A chain is a `Repeat<Switch>` whose Switch dispatches on a `ref(X)` where X
 * is a field that EACH CASE redefines — i.e. every record carries its own copy
 * of the discriminator, forward-linking to the next iteration (IPv6's
 * "Next Header" points at what FOLLOWS). This is detected from the AST shape,
 * not a `*_chain` id convention, so it generalises to any forward-linked header
 * chain regardless of naming.
 *
 * A TLV catalog (the other `Repeat<Switch>` idiom) differs structurally: it
 * dispatches on a `peek` of the wire, or on a sibling field read once per
 * record — never on a discriminator that the cases themselves redefine.
 */
export function isLikelyChainRepeat(r: Repeat): boolean {
  const sw = getSwitchFromRepeat(r);
  if (!sw || sw.on.kind !== "ref") return false;
  const discId = sw.on.field;
  return Object.values(sw.cases).some((struct) =>
    struct.fields.some((f) => isField(f) && f.id === discId),
  );
}

/** A readable label for a chain case: explicit `name`, else the leading phrase
 *  of its `doc` (the IPv6 preset puts "Routing" / "Fragment" / "Destination
 *  Options" there), else the bare proto number. Shared with the diagram
 *  expansion (`apply-chain.ts`) so the editor and cells show the same label. */
export function chainCaseLabel(
  struct: { name?: string; doc?: string },
  proto: number,
): string {
  if (struct.name) return struct.name;
  const lead = struct.doc?.split(/[.[(]/, 1)[0]?.trim();
  return lead && lead.length > 0 ? lead : `Proto ${proto}`;
}

export function switchToChainCatalog(sw: Switch): ChainCatalogEntry[] {
  const out: ChainCatalogEntry[] = [];
  for (const [key, struct] of Object.entries(sw.cases)) {
    const protoNum = firstCaseKeyValue(key);
    if (protoNum === null) continue;
    out.push({
      proto: protoNum,
      name: chainCaseLabel(struct, protoNum),
      fields: structFieldsToTlvFields(struct),
      ...(struct.doc ? { description: struct.doc } : {}),
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
        // PSDL schema accepts them and the renderer-side ChainInstance
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
 * renderer → PSDL
 * ----------------------------------------------------------------- */

export function chainEntryToStruct(
  parentId: string,
  entry: ChainCatalogEntry,
): Struct {
  return {
    id: `${parentId}_proto_${entry.proto}`,
    name: entry.name,
    // Drop width-0 fields rather than emit invalid {kind:"bits", n:0} (see
    // tlvCatalogEntryToStruct).
    fields: entry.fields
      .filter((f) => f.bits > 0)
      .map((f) => ({
        id: f.id,
        name: f.name,
        type: { kind: "bits", n: f.bits } as const,
        ...(f.description ? { doc: f.description } : {}),
      })),
  };
}

export function chainFieldToRepeat(field: RendererField): Repeat {
  // `repeatToChainField` carries the source Repeat id straight onto the
  // renderer Field, so a PSDL→renderer→PSDL round-trip on a chain repeat
  // ends up here with `field.id` already ending in `_chain`. Strip the
  // trailing marker so we don't emit `${name}_chain_chain` (and all of
  // its derived child ids) on the way back to PSDL.
  const baseId = field.id.replace(/_chain$/, "");
  const cases: Record<string, Struct> = {};
  for (const entry of field.chainCatalog ?? []) {
    cases[String(entry.proto)] = chainEntryToStruct(baseId, entry);
  }
  // `repeatToChainField` carried the source Repeat name straight onto
  // the renderer Field, so a PSDL→renderer→PSDL round-trip arrives
  // here with `field.name` already ending in " (chain)". Don't double
  // the suffix — preserving the existing label keeps round-trips
  // idempotent (Copilot review).
  const repeatName = field.name.endsWith(" (chain)")
    ? field.name
    : `${field.name} (chain)`;
  // Symmetric to TLV `instances`: persist chain selections back onto
  // the PSDL Repeat so JSON / share URL / "Save as preset" all carry
  // the user's chosen extension headers (sub-agent HIGH).
  // Carry per-instance `extras` through the renderer→PSDL lift as well
  // so PSDL packets that hand-author chain extras (e.g.
  // `chainInstances:[{proto:0,extras:{hdrExtLen:1}}]`) round-trip
  // through ImportExportDrawer / share / save without loss. The
  // PSDL→renderer side of this carry already lives in
  // `repeatToChainField`; without this mirror, the lift was
  // asymmetric and silently dropped extras (Round 8 HIGH).
  const chainInstances = (field.chainInstances ?? []).map((inst) => ({
    proto: inst.proto,
    ...(inst.extras ? { extras: { ...inst.extras } } : {}),
  }));
  return {
    kind: "repeat",
    id: `${baseId}_chain`,
    name: repeatName,
    // Carry the source category/doc that repeatToChainField preserved on the
    // Field, rather than hardcoding an IPv6-specific literal — keeps the lift
    // consistent with the shape-preserving merge path and stops clobbering the
    // source's (richer) doc (override-design-audit).
    category: field.category ?? "type",
    ...(field.description
      ? { doc: field.description }
      : { doc: "Extension-header chain." }),
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
