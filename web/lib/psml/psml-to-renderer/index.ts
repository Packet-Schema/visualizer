// PSML 0.3 — PSML → renderer adapter (top-level).
//
// Lowers a PSML Packet to the renderer Packet shape consumed by React
// components (DetailPanel, ControlsPanel, TlvEditor, ChainEditor,
// DependencyOverlay, …). The renderer model is intentionally lossier than
// PSML: Repeat<Switch> TLV catalogs are flattened to a `tlv` extension on a
// single variable-length placeholder Field, subfield Groups collapse to a
// `subfields[]` array, etc. The PSML Packet is still the canonical source —
// `resolveLayout(packet, …)` is the path for cell positioning, and PSML
// alone drives serialization through `lib/formats/*`.
//
// The transformation is split across:
//   - `./tlv.ts`       — TLV catalog detection & round-trip
//   - `./chain.ts`     — IPv6 extension-header chain detection & round-trip
//   - `./subfield.ts`  — Group → subfield collapse + plain leaf transform
//   - `./to-psml.ts`   — renderer → PSML lift (`rendererToPsml`)
//   - `./shared.ts`    — `typeBits` + helpers used across the modules

import { isField } from "../utils";
import type { Constraint, Expr, Packet as PsmlPacket } from "../types";
import type {
  Field as RendererField,
  Packet as RendererPacket,
} from "../renderer";

import { isLikelyChainRepeat, repeatToChainField } from "./chain";
import { groupToSubfieldField, plainFieldToRenderer } from "./subfield";
import { isTlvRepeat, repeatToTlvField } from "./tlv";

export { rendererToPsml } from "./to-psml";

/**
 * Inspect a Constraint of the form `ref(fieldA) * lit(N) == ref(fieldB)`
 * (or the symmetric form) and return the *controller* field's id (fieldA).
 *
 * fieldA is the one the user moves through a slider (IHL, Data Offset, …);
 * `Field.controlsLength = fieldA.id` is what `ControlsPanel` keys its UI
 * by, and `controllers[fieldA.id]` is the bound numeric state. fieldB —
 * the multiplied length on the RHS — is not needed here because layout
 * derivation of `fieldB` happens later via `resolveLayout`'s own ref
 * walking; the constraint only tells us "fieldA is a length controller".
 *
 * Uses the discriminated `Expr` union directly — no structural casts — so
 * adding a new Expr variant surfaces here as a tsc error rather than a
 * silent miss at runtime.
 */
function constraintToController(constraint: Constraint): string | null {
  // Match strictly the documented shape: one side is `ref(fieldA) * lit(N)`
  // (or the literal-first symmetric form `lit(N) * ref(fieldA)`), the
  // other side is `ref(fieldB)`. Anything else — bare `ref == ref`, a
  // `ref * ref` product, additive forms, peek-based discriminators —
  // would otherwise be promoted to a UI slider even though the slider
  // semantics (`length = controller × N`) only make sense when N is a
  // compile-time literal scale factor.
  const tryMatch = (mul: Expr, target: Expr): string | null => {
    if (target.kind !== "ref") return null;
    if (mul.kind !== "op" || mul.op !== "*") return null;
    if (mul.a.kind === "ref" && mul.b.kind === "lit") return mul.a.field;
    if (mul.b.kind === "ref" && mul.a.kind === "lit") return mul.b.field;
    return null;
  };
  return (
    tryMatch(constraint.lhs, constraint.rhs) ??
    tryMatch(constraint.rhs, constraint.lhs)
  );
}

/**
 * Walk the PSML body and produce a renderer-shaped Packet. Top-level
 * Repeat<Switch> nodes that look like TLV catalogs / chain catalogs are
 * promoted to renderer fields with `tlv` / `chainCatalog` populated so
 * TlvEditor and ChainEditor keep working. Groups whose direct children are
 * all leaf fields collapse to a single subfield-bearing renderer field.
 *
 * Nested Encrypted containers are skipped here — they contribute layout
 * cells via `resolveLayout`, not editor metadata.
 */
export function psmlToRenderer(packet: PsmlPacket): RendererPacket {
  const fields: RendererField[] = [];
  for (const c of packet.body) {
    if (isField(c)) {
      fields.push(plainFieldToRenderer(c));
      continue;
    }
    if (c.kind === "group") {
      const flat = groupToSubfieldField(c);
      if (flat) fields.push(flat);
      continue;
    }
    if (c.kind === "repeat") {
      if (isLikelyChainRepeat(c)) {
        // IPv6-style preset: a plain 8-bit `nextHeader` Field is followed by
        // a `nextHeader_chain` Repeat. The renderer mirror is happier when
        // those two surface as ONE field — the visible cell carries the
        // chain editor as its override. If we can't find a matching base
        // field, fall back to emitting the chain as its own (invisible)
        // field so the catalog is still discoverable.
        const chainField = repeatToChainField(c);
        const baseId = chainField.id.replace(/_chain$/, "");
        const baseField =
          baseId !== chainField.id
            ? fields.find((f) => f.id === baseId)
            : undefined;
        if (baseField) {
          baseField.chainCatalog = chainField.chainCatalog;
          baseField.chainInstances = chainField.chainInstances;
        } else {
          fields.push(chainField);
        }
      } else if (isTlvRepeat(c)) {
        fields.push(repeatToTlvField(c));
      }
      continue;
    }
    if (c.kind === "switch") {
      // Bare Switch — flatten to a placeholder.
      fields.push({ id: c.id, name: c.name ?? c.id, bits: 0 });
      continue;
    }
    if (c.kind === "encrypted") {
      // Surface as a single field placeholder so the DetailPanel can name
      // it. The actual cell layout (and headerProtected/encrypted flags)
      // comes from `resolveLayout`, not this adapter.
      const fld: RendererField = {
        id: c.id,
        name: c.name ?? c.id,
        bits: 0,
      };
      if (c.category) fld.category = c.category;
      if (c.doc) fld.description = c.doc;
      fields.push(fld);
      continue;
    }
  }
  // Stitch controller annotations onto the renderer fields by scanning the
  // PSML constraints. This lets ControlsPanel surface IHL / Data Offset as
  // length-driving sliders the same way the legacy preset model did.
  // The slider writes its value back under the field's own id; the layout
  // step is responsible for deriving any downstream Repeat counts from it.
  if (packet.constraints) {
    for (const c of packet.constraints) {
      const fromId = constraintToController(c);
      if (!fromId) continue;
      const target = fields.find((f) => f.id === fromId);
      if (target && !target.controlsLength) {
        target.controlsLength = fromId;
        if (target.bits != null) {
          target.max = Math.max(target.max ?? 0, 2 ** target.bits - 1);
        }
      }
    }
  }
  attachOverrideMetadata(packet.body, fields);
  return {
    name: packet.name,
    rowBits: packet.rowBits,
    fields,
    ...(packet.description ? { description: packet.description } : {}),
    ...(packet.byteOrder ? { byteOrder: packet.byteOrder } : {}),
  };
}

/**
 * Walk top-level PSML containers and attach override metadata to the
 * renderer mirror fields (or to a Group's subfields when the target lives
 * inside a Group):
 *   * `Switch` whose `on` is `ref(X)` → `X.switchCases` carries the case
 *     list, so OverridePanel can render a dropdown when X is selected.
 *   * `Optional` whose `when` is `ref(X)` → push the inner field's name
 *     onto `X.optionalGateFor`, so OverridePanel can render a toggle.
 * Nested Repeat / Switch containers are not walked recursively — PSML
 * idiomatically surfaces these primitives at the top level. Extend when
 * a real preset needs deeper lookup.
 */
function attachOverrideMetadata(
  body: PsmlPacket["body"],
  fields: RendererField[],
): void {
  // The lookup target may be either a top-level Field or a SubField inside
  // a Group-collapsed Field. We try the top level first, then fall back
  // to a subfield scan.
  const findTarget = (
    id: string,
  ):
    | { kind: "field"; field: RendererField }
    | { kind: "subfield"; sub: NonNullable<RendererField["subfields"]>[number] }
    | null => {
    const f = fields.find((x) => x.id === id);
    if (f) return { kind: "field", field: f };
    for (const parent of fields) {
      const sub = parent.subfields?.find((s) => s.id === id);
      if (sub) return { kind: "subfield", sub };
    }
    return null;
  };
  for (const c of body) {
    if (c.kind === "switch") {
      const on = c.on;
      if (on.kind !== "ref") continue;
      const t = findTarget(on.field);
      if (!t) continue;
      const cases: { value: number; label: string }[] = [];
      for (const [key, struct] of Object.entries(c.cases)) {
        const v = Number(key);
        if (!Number.isFinite(v)) continue;
        cases.push({ value: v, label: struct.name ?? `case ${key}` });
      }
      if (cases.length === 0) continue;
      if (t.kind === "field") t.field.switchCases = cases;
      else t.sub.switchCases = cases;
      continue;
    }
    if (c.kind === "optional") {
      const when = c.when;
      if (when.kind !== "ref") continue;
      const t = findTarget(when.field);
      if (!t) continue;
      const gated = c.field.name || c.field.id;
      if (t.kind === "field") {
        t.field.optionalGateFor = [...(t.field.optionalGateFor ?? []), gated];
      } else {
        t.sub.optionalGateFor = [...(t.sub.optionalGateFor ?? []), gated];
      }
      continue;
    }
  }
}
