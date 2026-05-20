// Shared helpers for the PSML ↔ renderer adapter.
//
// `psmlToRenderer` is split into responsibility-specific modules (tlv,
// chain, subfield, to-psml). The pieces that more than one module needs
// live here so we don't have a cycle through `index.ts`.

import { evalExpr, MissingRefError } from "../expr";
import { isField } from "../utils";
import type { Field as PsmlField, Repeat, Struct, Switch } from "../types";
import type { TlvCatalogField } from "../renderer";

/**
 * Best-effort static bit width for a PSML `Type`. Used only for renderer
 * shape construction — runtime width (varint, berLength, bytes with
 * env-dependent `n`) comes through `lib/psml/normalize.typeBits`.
 */
export function typeBits(type: PsmlField["type"]): number {
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
 * children are skipped — PSML preset authors keep TLV cases flat by
 * convention.
 */
export function structFieldsToTlvFields(struct: Struct): TlvCatalogField[] {
  const out: TlvCatalogField[] = [];
  for (const child of struct.fields) {
    if (isField(child)) {
      const bits = typeBits(child.type);
      const entry: TlvCatalogField = { id: child.id, name: child.name, bits };
      if (child.doc) entry.description = child.doc;
      out.push(entry);
    }
  }
  return out;
}
