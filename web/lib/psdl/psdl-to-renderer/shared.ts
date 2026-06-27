// Shared helpers for the PSDL ↔ renderer adapter.
//
// `psdlToRenderer` is split into responsibility-specific modules (tlv,
// chain, subfield, to-psdl). The pieces that more than one module needs
// live here so we don't have a cycle through `index.ts`.

import { evalExpr, MissingRefError } from "../expr";
import { isBytesDelimited } from "../normalize";
import { isField } from "../utils";
import type { Field as PsdlField, Repeat, Struct, Switch } from "../types";
import type { TlvCatalogField } from "../renderer";

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
  return flattenContainersToTlvFields(struct.fields);
}

function flattenContainersToTlvFields(
  containers: Struct["fields"],
): TlvCatalogField[] {
  const out: TlvCatalogField[] = [];
  for (const child of containers) {
    if (isField(child)) {
      const bits = typeBits(child.type);
      const entry: TlvCatalogField = { id: child.id, name: child.name, bits };
      if (child.doc) entry.description = child.doc;
      out.push(entry);
      continue;
    }
    switch (child.kind) {
      case "group":
        out.push(...flattenContainersToTlvFields(child.children));
        break;
      case "switch": {
        // Representative shape: prefer the explicit default branch (the "_"
        // case in 0.5); otherwise take the first numerically-keyed case.
        // Anything else would need user-driven dispatch which TLV editing
        // doesn't currently expose.
        const repr = child.cases["_"] ?? Object.values(child.cases)[0] ?? null;
        if (repr) out.push(...flattenContainersToTlvFields(repr.fields));
        break;
      }
      case "optional":
        // Treat the inner container as always-present for catalog purposes.
        out.push(...flattenContainersToTlvFields([child.container]));
        break;
      // `repeat` / `encrypted` inside a TLV case body would need real
      // dispatch metadata; skip silently for now (no shipping preset
      // exercises them).
      default:
        break;
    }
  }
  return out;
}
