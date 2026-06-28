// Shared helpers for the PSDL ↔ renderer adapter.
//
// `psdlToRenderer` is split into responsibility-specific modules (tlv,
// chain, subfield, to-psdl). The pieces that more than one module needs
// live here so we don't have a cycle through `index.ts`.

import { evalExpr, MissingRefError } from "../expr";
import { isBytesDelimited } from "../normalize";
import { isField } from "../utils";
import type { Field as PsdlField, Repeat, Struct, Switch } from "../types";
import type { TlvCatalogField, TlvVariableBytes } from "../renderer";
import {
  DELIMITED_DEFAULT_BYTES,
  VARINT_DEFAULT_BITS,
} from "../dynamic-width-defaults";

/**
 * Parse a Switch case key to its representative numeric value for a picker /
 * catalog entry. PSDL 0.5 case keys may be a single int ("3"), a comma-list
 * ("1,2"), or a range ("8-15") — core's `selectArm` matches any member. The
 * override surfaces only need ONE selectable value per case (setting the
 * discriminator to it selects the whole case), so we take the first member.
 * Returns null for the "_" default arm or any non-numeric key — the previous
 * `Number(key)` returned NaN for comma/range keys and silently dropped them,
 * losing the override surface entirely (override-design-audit).
 */
export function firstCaseKeyValue(key: string): number | null {
  const first = key.split(",")[0]?.trim() ?? "";
  const range = first.match(/^(\d+)-(\d+)$/);
  const n = Number(range ? range[1] : first);
  return Number.isInteger(n) ? n : null;
}

/**
 * True when a LISTED (non-`_`) Switch case `key` matches the integer `value`.
 * Mirrors core's `selectArm` grammar (§5): a single int ("3"), a comma-list
 * ("1,2,3"), or an inclusive range ("8-15"). The "_" default key never matches
 * here — it is the fallthrough, not a listed case. Used to compute a sentinel
 * discriminator value that is guaranteed NOT covered by any listed case (so
 * core's `selectArm` falls through to the `_` arm), which lets the override
 * pickers offer a "default" option that actually reaches the default-arm
 * layout.
 */
export function caseKeyCoversValue(key: string, value: number): boolean {
  if (key === "_") return false;
  for (const part of key.split(",")) {
    const member = part.trim();
    const range = member.match(/^(\d+)-(\d+)$/);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (lo <= hi && value >= lo && value <= hi) return true;
      continue;
    }
    const n = Number(member);
    if (Number.isInteger(n) && n === value) return true;
  }
  return false;
}

/**
 * Smallest non-negative integer not covered by any of the given LISTED
 * (non-`_`) case keys. Setting a Switch discriminator to this value forces
 * core's `selectArm` to fall through to the `_` arm, so it is a safe sentinel
 * for a synthetic "default" picker option that reaches the default-arm layout.
 */
export function defaultArmSentinel(caseKeys: readonly string[]): number {
  let v = 0;
  while (caseKeys.some((k) => caseKeyCoversValue(k, v))) v += 1;
  return v;
}

/**
 * Pretty-print a camelCase / snake_case identifier as "Camel Case". Returns
 * null for empty / non-string input so callers can chain a final fallback
 * (e.g. `struct.name ?? prettifyId(struct.id) ?? \`case ${key}\``). Shared by
 * the TLV catalog and the refSwitch / peekSwitch variant pickers so an
 * id-only switch case (the common 0.5 idiom, no `name`) gets a readable
 * label instead of a bare "case N".
 */
export function prettifyId(id: string | undefined): string | null {
  if (!id) return null;
  const trimmed = id.trim();
  if (!trimmed) return null;
  return trimmed
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^./, (ch) => ch.toUpperCase());
}

/**
 * Best-effort static bit width for a PSDL `Type`. Used only for renderer
 * shape construction — runtime width (varint, berLength, bytes with
 * env-dependent `n`) comes through `lib/psdl/normalize.typeBits`.
 */
export function typeBits(type: PsdlField["type"]): number {
  switch (type.kind) {
    case "int":
    case "enum":
      return type.bits;
    case "bits":
      return type.n;
    case "bytes":
      // 0.5 — `n` may be a delimiter spec instead of an Expr; delimited
      // length is dynamic, so treat it as zero-width at design time.
      if (isBytesDelimited(type.n)) return 0;
      try {
        return evalExpr(type.n, new Map()) * 8;
      } catch (e) {
        if (e instanceof MissingRefError) return 0;
        throw e;
      }
    case "varint":
      return 0;
    case "berLength":
      // PSDL 0.4 — width is dynamic. Treat as 0 at design time; layout
      // adapters consult the env for a concrete width.
      return 0;
  }
}

/**
 * If `r.element` is a Struct that contains a single Switch as its only
 * child, return that Switch. The TLV / chain detectors both rely on this.
 */
export function getSwitchFromRepeat(r: Repeat): Switch | null {
  const first = r.element.fields[0];
  if (first && "kind" in first && first.kind === "switch") return first;
  return null;
}

/**
 * Flatten a Switch case body to a `TlvCatalogField[]`. Compound nested
 * children are spliced — common case: CoAP `Delta=13` wraps a nested
 * `Switch` for the Length nibble, and dropping it (as the legacy
 * leaf-only implementation did) left the catalog with a single 4-bit
 * field even though the on-wire record is several bytes. The recursion
 * uses each nested Switch's `default` (else first numeric case) as the
 * canonical shape — Switches in TLV bodies are dispatched by the wire
 * record's own bytes, so the renderer just needs one representative
 * layout for the catalog editor.
 */
export function structFieldsToTlvFields(struct: Struct): TlvCatalogField[] {
  return flattenContainersToTlvFields(struct.fields).fields;
}

/** Default byte count seeded for a variable value field so it renders a
 *  representative, VISIBLE cell the moment a record is added. Mirrors the
 *  dynamic-width-default convention (delimited → 4 B); a `bytes(ref L)` value
 *  with no other signal also gets a small representative width. */
const VARIABLE_VALUE_DEFAULT_BYTES = DELIMITED_DEFAULT_BYTES;

type VariableBytesSeed = TlvVariableBytes & { defaultBytes: number };

/**
 * If `field` is a variable-LENGTH value member (a `bytes(ref L)` / delimited
 * `bytes` / varint that `typeBits` collapses to 0 at design time), return a
 * `TlvVariableBytes` descriptor wiring a per-instance byte-count knob to it —
 * keyed `<id>__bytes`, sized between 1 and a generous cap, defaulting to a
 * representative width. Returns null for a fixed-width member. A `bytes(ref L)`
 * value records its sibling length field id so the editor / lift can keep the
 * two in sync. Used to give such a value a width AND an editor control instead
 * of a permanently zero-width, uneditable cell.
 */
function variableValueExtra(field: PsdlField): VariableBytesSeed | null {
  const t = field.type;
  let isVariable = false;
  let lengthFieldId: string | undefined;
  let defaultBytes = VARIABLE_VALUE_DEFAULT_BYTES;
  if (t.kind === "bytes") {
    if (isBytesDelimited(t.n)) {
      isVariable = true;
    } else if (t.n.kind === "ref") {
      isVariable = true;
      lengthFieldId = t.n.field;
    } else if (t.n.kind !== "lit") {
      // A dynamic `bytes(<expr>)` whose length is a computed expression rather
      // than a bare `ref` — e.g. tcp `optionGeneric.value` = `bytes(length-2)`
      // (an `op`), or any `cond`/`peek`/`remaining`-sized value. `typeBits`
      // collapses these to 0 at design time, so without a knob the value cell
      // is permanently zero-width and invisible (see-but-cannot-edit). Seed a
      // representative width + per-instance byte knob. We can't extract a single
      // sibling-length field id from an arbitrary expression, so omit
      // `lengthFieldId` — the value carries its own byte count via `extras`.
      isVariable = true;
    }
    // A `bytes(lit N)` is fixed-width — typeBits already sized it.
  } else if (t.kind === "varint" || t.kind === "berLength") {
    isVariable = true;
    // varint/berLength widths are bit-quantised; a 1-byte default keeps the
    // value visible without over-claiming.
    defaultBytes = Math.max(1, Math.ceil(VARINT_DEFAULT_BITS / 8));
  }
  if (!isVariable) return null;
  const extra: VariableBytesSeed = {
    key: `${field.id}__bytes`,
    fieldId: field.id,
    min: 1,
    max: 255,
    label: `${field.name} length (B)`,
    defaultBytes,
  };
  if (lengthFieldId) extra.lengthFieldId = lengthFieldId;
  return extra;
}

type FlattenResult = {
  fields: TlvCatalogField[];
  /** Variable-length value knobs collected from the flattened members. */
  variableBytes: VariableBytesSeed[];
};

function flattenContainersToTlvFields(
  containers: Struct["fields"],
): FlattenResult {
  const out: TlvCatalogField[] = [];
  const variableBytes: VariableBytesSeed[] = [];
  for (const child of containers) {
    if (isField(child)) {
      const bits = typeBits(child.type);
      const entry: TlvCatalogField = { id: child.id, name: child.name, bits };
      if (child.doc) entry.description = child.doc;
      out.push(entry);
      if (bits <= 0) {
        const vb = variableValueExtra(child);
        if (vb) variableBytes.push(vb);
      }
      continue;
    }
    const mergeNested = (res: FlattenResult): void => {
      out.push(...res.fields);
      variableBytes.push(...res.variableBytes);
    };
    switch (child.kind) {
      case "group":
        mergeNested(flattenContainersToTlvFields(child.children));
        break;
      case "switch": {
        // Representative shape: prefer the explicit default branch (the "_"
        // case in 0.5); otherwise take the first numerically-keyed case.
        // Anything else would need user-driven dispatch which TLV editing
        // doesn't currently expose.
        const repr = child.cases["_"] ?? Object.values(child.cases)[0] ?? null;
        if (repr) mergeNested(flattenContainersToTlvFields(repr.fields));
        break;
      }
      case "optional":
        // Treat the inner container as always-present for catalog purposes.
        mergeNested(flattenContainersToTlvFields([child.container]));
        break;
      // `repeat` / `encrypted` inside a TLV case body would need real
      // dispatch metadata; skip silently for now (no shipping preset
      // exercises them).
      default:
        break;
    }
  }
  return { fields: out, variableBytes };
}

/**
 * Build the full TLV catalog shape for one Switch case `struct`: the flattened
 * positional `fields`, plus — for every variable-LENGTH value member — the
 * `variableBytes` knobs, the seeded `defaultExtras`, and a `fieldsFor` closure
 * that sizes those members from `extras`. Returns `fieldsFor === undefined`
 * when the struct has no variable members (every field is statically sized), so
 * the common fixed-shape catalog path is untouched.
 */
export function structToTlvCatalogShape(struct: Struct): {
  fields: TlvCatalogField[];
  variableBytes?: TlvVariableBytes[];
  defaultExtras?: Record<string, number>;
  fieldsFor?: (extras: Record<string, number>) => TlvCatalogField[];
} {
  const { fields, variableBytes } = flattenContainersToTlvFields(struct.fields);
  if (variableBytes.length === 0) return { fields };

  const defaultExtras: Record<string, number> = {};
  const cleanVariableBytes: TlvVariableBytes[] = variableBytes.map((vb) => {
    defaultExtras[vb.key] = vb.defaultBytes;
    const out: TlvVariableBytes = {
      key: vb.key,
      fieldId: vb.fieldId,
      min: vb.min,
      max: vb.max,
    };
    if (vb.label) out.label = vb.label;
    if (vb.lengthFieldId) out.lengthFieldId = vb.lengthFieldId;
    return out;
  });
  const byFieldId = new Map(cleanVariableBytes.map((vb) => [vb.fieldId, vb]));

  const fieldsFor = (extras: Record<string, number>): TlvCatalogField[] =>
    fields.map((f) => {
      const vb = byFieldId.get(f.id);
      if (!vb) return f;
      const bytes = Math.max(
        vb.min,
        Math.min(vb.max, Math.floor(extras[vb.key] ?? vb.min)),
      );
      return { ...f, bits: bytes * 8 };
    });

  return {
    fields,
    variableBytes: cleanVariableBytes,
    defaultExtras,
    fieldsFor,
  };
}
