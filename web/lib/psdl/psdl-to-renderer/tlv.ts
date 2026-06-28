// TLV catalog extraction (PSDL → renderer) and round-trip back to PSDL.
//
// A PSDL `Repeat<Switch>` whose Switch cases are keyed by integer strings
// is promoted to a renderer "TLV" field — a single variable-length
// placeholder that carries a `tlv.catalog` for the editor.

import type { Field as PsdlField, Repeat, Struct, Switch } from "../types";
import type {
  Field as RendererField,
  TlvCatalogEntry as RendererTlvCatalogEntry,
  TlvCatalogField,
} from "../renderer";

import {
  firstCaseKeyValue,
  getSwitchFromRepeat,
  prettifyId,
  structToTlvCatalogShape,
} from "./shared";

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
    const shape = structToTlvCatalogShape(struct);
    const fields = shape.fields;
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
    // A case arm with a variable-LENGTH value member (e.g. dhcpv4 Code=3
    // `routerAddresses` = bytes(ref optionLength)) carries per-instance
    // byte-count knobs + a `fieldsFor` closure that sizes the value from
    // `extras`, plus the seeded `defaultExtras` so the value renders a
    // VISIBLE cell the moment a record is added (instead of a permanently
    // zero-width, uneditable field).
    if (shape.variableBytes && shape.variableBytes.length > 0) {
      entry.variableBytes = shape.variableBytes;
      entry.defaultExtras = shape.defaultExtras;
      entry.fieldsFor = shape.fieldsFor;
    }
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
  // A catalog field with a `variableBytes` knob is a variable-LENGTH value
  // member (`bytes(ref L)` / delimited / varint) the catalog collapsed to
  // bits<=0. Re-emit it as `bytes(ref L)` (keyed to its sibling length field)
  // so the round-trip through PSDL keeps the field AND its length linkage —
  // re-import then rebuilds the variableBytes knob and the per-instance
  // `extras` (which carry the user's byte count) drive its width again. This
  // path is only reached for imported packets WITHOUT a source PSDL; presets
  // round-trip through `mergeInstancesIntoPsdl` against their retained source.
  const variableByFieldId = new Map(
    (entry.variableBytes ?? []).map((vb) => [vb.fieldId, vb]),
  );
  const fields: PsdlField[] = [];
  for (const f of baseFields) {
    const vb = variableByFieldId.get(f.id);
    if (vb) {
      const type: PsdlField["type"] = vb.lengthFieldId
        ? { kind: "bytes", n: { kind: "ref", field: vb.lengthFieldId } }
        : { kind: "bytes", n: { kind: "lit", value: Math.max(1, vb.min) } };
      fields.push({
        id: f.id,
        name: f.name,
        type,
        ...(f.description ? { doc: f.description } : {}),
      });
      continue;
    }
    // Drop any remaining bits<=0 field with no variable metadata: emitting
    // {kind:"bits", n:0} produces PSDL the validator rejects ("bits must have
    // positive n"). Mirrors the plain-field guard in to-psdl.ts.
    if (f.bits <= 0) continue;
    fields.push({
      id: f.id,
      name: f.name,
      type: { kind: "bits", n: f.bits },
      ...(f.description ? { doc: f.description } : {}),
    });
  }
  return {
    id: `${parentId}_kind_${entry.kind}`,
    name: entry.name,
    fields,
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
