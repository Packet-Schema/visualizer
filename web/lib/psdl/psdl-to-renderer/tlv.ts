// TLV catalog extraction (PSDL → renderer) and round-trip back to PSDL.
//
// A PSDL `Repeat<Switch>` whose Switch cases are keyed by integer strings
// is promoted to a renderer "TLV" field — a single variable-length
// placeholder that carries a `tlv.catalog` for the editor.

import type { Repeat, Struct, Switch } from "../types";
import type {
  Field as RendererField,
  TlvCatalogEntry as RendererTlvCatalogEntry,
  TlvCatalogField,
} from "../renderer";

import {
  firstCaseKeyValue,
  getSwitchFromRepeat,
  structFieldsToTlvFields,
} from "./shared";

/** Pretty-print a camelCase identifier as "Camel Case". Returns null for
 *  empty / non-string input so callers can chain a final fallback. */
function prettifyId(id: string | undefined): string | null {
  if (!id) return null;
  const trimmed = id.trim();
  if (!trimmed) return null;
  return trimmed
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^./, (ch) => ch.toUpperCase());
}

type TlvCatalogEntry = RendererTlvCatalogEntry;

/** True when this Repeat's element is just a single Switch (the PSDL
 *  idiom for a TLV catalog). */
export function isTlvRepeat(r: Repeat): boolean {
  if (r.element.fields.length !== 1) return false;
  const first = r.element.fields[0];
  return "kind" in first && first.kind === "switch";
}

export function switchToTlvCatalog(sw: Switch): TlvCatalogEntry[] {
  const out: TlvCatalogEntry[] = [];
  for (const [key, struct] of Object.entries(sw.cases)) {
    const kindNum = firstCaseKeyValue(key);
    if (kindNum === null) continue;
    const fields = structFieldsToTlvFields(struct);
    const entry: TlvCatalogEntry = {
      kind: kindNum,
      // Pretty fallback: when the PSDL case struct doesn't declare a
      // `name`, prefer its id (e.g. `recordRoute` → "Record Route")
      // over the bare `kind N` label that ends up on the diagram cell.
      name: struct.name ?? prettifyId(struct.id) ?? `kind ${kindNum}`,
    };
    // `fields` is optional on the catalog type; omit it when empty so
    // downstream helpers (which use fields-presence to decide whether
    // to render a payload row) can take the empty-fields fast path.
    // We don't synthesise a bits-only entry here — the previous code
    // wrote `entry.bits = bitsTotal` in the empty branch, but
    // `bitsTotal` is derived from `fields` and so was always 0; that
    // branch only ever produced a useless `bits: 0`. Hand-crafted
    // catalogs that need bits-only entries (EOL/NOP wire-marker
    // shapes) supply the catalog directly, not via a PSDL Switch.
    if (fields.length > 0) entry.fields = fields;
    out.push(entry);
  }
  return out;
}

export function repeatToTlvField(r: Repeat): RendererField {
  const sw = getSwitchFromRepeat(r);
  const catalog = sw ? switchToTlvCatalog(sw) : [];
  // Persisted instances on the PSDL side travel back into the renderer
  // mirror so a user's record selections survive JSON / share-URL /
  // "Save as preset" round-trips. Filter out unknown-kind entries up
  // front so a malformed / catalog-mismatched share URL doesn't ride
  // the populated branch in `applyTlvInstances` and silently render an
  // empty Repeat (Codex P2). The unknown entries are also unrecoverable
  // — without a catalog match we can't reify the per-record fields.
  const knownKinds = new Set(catalog.map((c) => c.kind));
  const instances = r.instances
    ? r.instances.flatMap((inst) => {
        if (!knownKinds.has(inst.kind)) {
          console.warn(
            `[repeatToTlvField] dropping instance with unknown kind=${inst.kind} on Repeat "${r.id}" — not present in the catalog.`,
          );
          return [];
        }
        return [
          {
            kind: inst.kind,
            ...(inst.extras ? { extras: { ...inst.extras } } : {}),
          },
        ];
      })
    : [];
  const field: RendererField = {
    id: r.id,
    name: r.name ?? r.id,
    variable: true,
    tlv: {
      catalog,
      instances,
      drivesController: `${r.id}_count`,
      bytesPerUnit: 1,
      baseControllerValue: 0,
    },
    lengthFrom: `${r.id}_count`,
    formula: "psdl_repeat",
    toBits: () => 0,
  };
  if (r.category) field.category = r.category;
  if (r.doc) field.description = r.doc;
  return field;
}

/* ----------------------------------------------------------------- *
 * renderer → PSDL
 * ----------------------------------------------------------------- */

export function tlvCatalogEntryToStruct(
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

export function tlvFieldToRepeat(field: RendererField): Repeat {
  const discKey = `${field.id}_kind`;
  const cases: Record<string, Struct> = {};
  for (const entry of field.tlv?.catalog ?? []) {
    cases[String(entry.kind)] = tlvCatalogEntryToStruct(field.id, entry);
  }
  // Persist the user-chosen records so the JSON / share-URL / saved-
  // preset all round-trip with full state. Without this the catalog
  // round-trips but `tlv.instances` is silently dropped at every
  // export boundary.
  const instances = (field.tlv?.instances ?? []).map((inst) => ({
    kind: inst.kind,
    ...(inst.extras ? { extras: { ...inst.extras } } : {}),
  }));
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
    ...(instances.length > 0 ? { instances } : {}),
  };
}
