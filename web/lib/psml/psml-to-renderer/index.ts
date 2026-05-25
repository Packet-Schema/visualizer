// PSML 0.3 — PSML → renderer adapter (top-level).
//
// Lowers a PSML Packet to the renderer Packet shape consumed by React
// components (DetailPanel, ControlsPanel, TlvEditor, ChainEditor, …).
// The renderer model is intentionally lossier than
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
export { applyTlvInstances } from "./apply-tlv";
export { mergeInstancesIntoPsml } from "./merge-instances";

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
    if (mul.kind !== "op") return null;
    // `*` / `+` / `-` are the supported single-operator inversions. Anything
    // richer (multi-operator, `/` / `%` / shifts, peek-based discriminators)
    // is left alone — the slider semantics only make sense when one operand
    // is a compile-time literal that the solver can peel off.
    if (mul.op !== "*" && mul.op !== "+" && mul.op !== "-") return null;
    if (mul.a.kind === "ref" && mul.b.kind === "lit") return mul.a.field;
    // `-` is non-commutative, but `lit - ref` still nominates the ref as
    // the controller (the solver inverts both directions for additive
    // forms).
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
          // Forward the terminal Next-Header pick to the base field too —
          // `syncChainControllers` later reads `field.chainFinalProto`
          // and without this hand-off the value silently reverts to the
          // catalog default on every reload / re-export (Codex P1).
          if (typeof chainField.chainFinalProto === "number") {
            baseField.chainFinalProto = chainField.chainFinalProto;
          }
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
  const freeRepeats = collectFreeRepeats(packet.body, fields);
  const peekSwitches = collectPeekSwitches(packet.body);
  return {
    name: packet.name,
    rowBits: packet.rowBits,
    fields,
    ...(packet.description ? { description: packet.description } : {}),
    ...(packet.byteOrder ? { byteOrder: packet.byteOrder } : {}),
    ...(freeRepeats.length > 0 ? { freeRepeats } : {}),
    ...(peekSwitches.length > 0 ? { peekSwitches } : {}),
  };
}

/**
 * Find Repeats whose count isn't already covered by an existing override:
 *   * Not a TLV / chain Repeat (those get list editors).
 *   * Their `count: ref(X)` doesn't land on a field with `controlsLength`
 *     (= a slider) or any other widget-bearing field.
 * Surface them as packet-level "Repeats" steppers in OverridePanel.
 * Also covers `eos` / `{ until: Expr }` shapes where the count env key is
 * the Repeat's own id (per normalize.ts).
 */
function collectFreeRepeats(
  body: PsmlPacket["body"],
  fields: RendererField[],
): NonNullable<RendererPacket["freeRepeats"]> {
  const out: NonNullable<RendererPacket["freeRepeats"]> = [];
  const visit = (containers: PsmlPacket["body"]): void => {
    for (const c of containers) {
      if (c.kind === "repeat") {
        if (!isLikelyChainRepeat(c) && !isTlvRepeat(c)) {
          let countKey: string | null = null;
          let label = c.name ?? c.id;
          if (
            c.count === "eos" ||
            (typeof c.count === "object" && "until" in c.count)
          ) {
            countKey = c.id;
            label = `${label} (${c.count === "eos" ? "eos" : "until"})`;
          } else if (typeof c.count === "object" && c.count.kind === "ref") {
            // Only surface when no existing field-bearing widget covers it.
            const ref = c.count.field;
            const covered = fields.find(
              (f) =>
                f.id === ref &&
                (f.controlsLength || f.switchCases || f.enumVariants),
            );
            if (!covered) countKey = ref;
          }
          if (countKey) out.push({ name: label, countKey });
        }
        visit(c.element.fields);
        continue;
      }
      if (c.kind === "group") {
        visit(c.children);
        continue;
      }
      if (c.kind === "switch") {
        for (const struct of Object.values(c.cases)) visit(struct.fields);
        if (c.default) visit(c.default.fields);
        continue;
      }
      if (c.kind === "optional") {
        visit([c.field]);
        continue;
      }
      if (c.kind === "encrypted") {
        visit(c.plaintext.fields);
        continue;
      }
    }
  };
  visit(body);
  return out;
}

/**
 * Find Switches whose `on` is a `peek` expression (TLS extension type
 * dispatch etc). The peek synthesizes an env key
 * `__peek__<offset>__<bits>` per the PSML spec. We expose this so
 * OverridePanel can render a synthetic case picker — there's no real cell
 * to attach to since `peek` doesn't consume bytes.
 */
function collectPeekSwitches(
  body: PsmlPacket["body"],
): NonNullable<RendererPacket["peekSwitches"]> {
  const out: NonNullable<RendererPacket["peekSwitches"]> = [];
  const visit = (containers: PsmlPacket["body"]): void => {
    for (const c of containers) {
      if (c.kind === "switch") {
        if (c.on.kind === "peek") {
          const cases: { value: number; label: string }[] = [];
          for (const [key, struct] of Object.entries(c.cases)) {
            const v = Number(key);
            if (!Number.isFinite(v)) continue;
            cases.push({ value: v, label: struct.name ?? `case ${key}` });
          }
          if (cases.length > 0) {
            const peek = c.on;
            // Only surface peek switches whose offset is a compile-time
            // literal (or implicitly 0). Non-literal offsets evaluate at
            // layout time to a value we don't know here, so the
            // `__peek__<offset>__<bits>` key we'd publish wouldn't match
            // what normalize actually reads — the picker would write to
            // a dead env key and the diagram wouldn't update. Codex P2.
            const offset = peek.offset;
            if (offset && offset.kind !== "lit") {
              // Skip: surfacing this peek would be misleading.
            } else {
              const offsetValue = offset?.kind === "lit" ? offset.value : 0;
              out.push({
                id: c.id,
                name: c.name ?? c.id,
                cases,
                peekKey: `__peek__${offsetValue}__${peek.bits}`,
              });
            }
          }
        }
        for (const struct of Object.values(c.cases)) visit(struct.fields);
        if (c.default) visit(c.default.fields);
        continue;
      }
      if (c.kind === "group") {
        visit(c.children);
        continue;
      }
      if (c.kind === "repeat") {
        visit(c.element.fields);
        continue;
      }
      if (c.kind === "optional") {
        visit([c.field]);
        continue;
      }
      if (c.kind === "encrypted") {
        visit(c.plaintext.fields);
        continue;
      }
    }
  };
  visit(body);
  return out;
}

/**
 * Recursively walk PSML containers and attach override metadata to the
 * renderer mirror fields (or to a Group's subfields when the target lives
 * inside a Group). Handles:
 *   * `Switch` whose `on` is `ref(X)` → `X.switchCases` carries the case
 *     list. Also walks each case Struct (variant) to find nested overrides.
 *     `peek`-based discriminators land on the parent Switch's id as a
 *     synthetic peek widget target (no real cell — surfaced via
 *     `peekSwitches`).
 *   * `Optional` whose `when` is `ref(X)` → push the inner field's name
 *     onto `X.optionalGateFor`. Also recurses into the inner field.
 *   * Group / Repeat children — walked recursively so nested Switch /
 *     Optional / data-dependent types are surfaced.
 *   * Each `op` / `cond` Expr that contains a single `ref` extracts that
 *     ref as a best-effort controller (complex expressions don't get a
 *     widget but their primary ref still surfaces something).
 */
function attachOverrideMetadata(
  body: PsmlPacket["body"],
  fields: RendererField[],
): void {
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

  // Try to pull a single ref id out of an Expr — `ref(X)` returns X,
  // `op` / `cond` walks operands recursively and returns the first ref
  // found. Complex expressions with multiple refs are accepted but the
  // first ref wins ("primary" controller).
  const primaryRef = (expr: import("../types").Expr): string | null => {
    if (expr.kind === "ref") return expr.field;
    if (expr.kind === "lit") return null;
    if (expr.kind === "peek") return null;
    if (expr.kind === "op") {
      return primaryRef(expr.a) ?? primaryRef(expr.b);
    }
    if (expr.kind === "cond") {
      return primaryRef(expr.test) ?? primaryRef(expr.t) ?? primaryRef(expr.f);
    }
    return null;
  };

  const visit = (containers: PsmlPacket["body"]): void => {
    for (const c of containers) {
      if (c.kind === "switch") {
        const cases: { value: number; label: string }[] = [];
        for (const [key, struct] of Object.entries(c.cases)) {
          const v = Number(key);
          if (Number.isFinite(v)) {
            cases.push({ value: v, label: struct.name ?? `case ${key}` });
          }
          // Recurse into each variant's fields.
          visit(struct.fields);
        }
        if (c.default) visit(c.default.fields);
        if (cases.length === 0) continue;
        if (c.on.kind === "ref") {
          const t = findTarget(c.on.field);
          if (t) {
            if (t.kind === "field") t.field.switchCases = cases;
            else t.sub.switchCases = cases;
          }
        } else if (c.on.kind === "op" || c.on.kind === "cond") {
          // Complex expr — fall back to the primary ref so the user still
          // has *something* to drive. The widget label notes the indirection.
          const primary = primaryRef(c.on);
          if (primary) {
            const t = findTarget(primary);
            if (t) {
              if (t.kind === "field") t.field.switchCases = cases;
              else t.sub.switchCases = cases;
            }
          }
        }
        // `peek`-based discriminator: surfaced via the Switch's own id on
        // the packet (no real cell), see `peekSwitches` below.
        continue;
      }
      if (c.kind === "optional") {
        const gated = c.field.name || c.field.id;
        const ref = c.when.kind === "ref" ? c.when.field : primaryRef(c.when);
        if (ref) {
          const t = findTarget(ref);
          if (t) {
            if (t.kind === "field") {
              t.field.optionalGateFor = [
                ...(t.field.optionalGateFor ?? []),
                gated,
              ];
            } else {
              t.sub.optionalGateFor = [...(t.sub.optionalGateFor ?? []), gated];
            }
          }
        }
        // Recurse into the inner field (treat it as a 1-element body).
        visit([c.field]);
        continue;
      }
      if (c.kind === "group") {
        visit(c.children);
        continue;
      }
      if (c.kind === "repeat") {
        // Repeat's element is a Struct (single variant body).
        visit(c.element.fields);
        continue;
      }
      if (c.kind === "encrypted") {
        visit(c.plaintext.fields);
        continue;
      }
    }
  };

  visit(body);
}
