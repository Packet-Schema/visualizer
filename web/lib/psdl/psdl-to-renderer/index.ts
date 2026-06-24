// PSDL 0.3 — PSDL → renderer adapter (top-level).
//
// Lowers a PSDL Packet to the renderer Packet shape consumed by React
// components (DetailPanel, ControlsPanel, TlvEditor, ChainEditor, …).
// The renderer model is intentionally lossier than
// PSDL: Repeat<Switch> TLV catalogs are flattened to a `tlv` extension on a
// single variable-length placeholder Field, subfield Groups collapse to a
// `subfields[]` array, etc. The PSDL Packet is still the canonical source —
// `resolveLayout(packet, …)` is the path for cell positioning, and PSDL
// alone drives serialization through `lib/formats/*`.
//
// The transformation is split across:
//   - `./tlv.ts`       — TLV catalog detection & round-trip
//   - `./chain.ts`     — IPv6 extension-header chain detection & round-trip
//   - `./subfield.ts`  — Group → subfield collapse + plain leaf transform
//   - `./to-psdl.ts`   — renderer → PSDL lift (`rendererToPsdl`)
//   - `./shared.ts`    — `typeBits` + helpers used across the modules

import { isField } from "../utils";
import { exprRefs } from "../expr";
import type {
  Constraint,
  Container,
  Expr,
  NamedStruct,
  Packet as PsdlPacket,
} from "../types";
import type {
  Field as RendererField,
  Packet as RendererPacket,
} from "../renderer";

/**
 * Flatten PSDL 0.5 transparent scope containers (`bounded`, resolved `ref`)
 * into an inline container list for the renderer mirror. The mirror cares
 * about override targets and TLV/chain catalogs, not wire scoping, so a
 * `bounded` region (e.g. IPv4's `optionsArea` wrapping the options Repeat) is
 * spliced inline just like a `group`'s children. `align` / `virtual` carry no
 * override surface and are dropped. Nested transparent scopes flatten
 * recursively; an unresolvable `ref` is skipped.
 */
function flattenForMirror(
  containers: Container[],
  defs?: Record<string, NamedStruct>,
): Container[] {
  const out: Container[] = [];
  for (const c of containers) {
    if (!isField(c) && c.kind === "bounded") {
      out.push(...flattenForMirror(c.fields, defs));
    } else if (!isField(c) && c.kind === "ref") {
      const def = defs?.[c.ref];
      if (def) out.push(...flattenForMirror(def.fields, defs));
    } else if (!isField(c) && (c.kind === "align" || c.kind === "virtual")) {
      // no renderer-mirror representation
    } else {
      out.push(c);
    }
  }
  return out;
}

import { isLikelyChainRepeat, repeatToChainField } from "./chain";
import { groupToSubfieldField, plainFieldToRenderer } from "./subfield";
import { isTlvRepeat, repeatToTlvField } from "./tlv";

export { rendererToPsdl } from "./to-psdl";
export { applyTlvInstances } from "./apply-tlv";
export { applyChainInstances } from "./apply-chain";
export { mergeInstancesIntoPsdl } from "./merge-instances";

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
 * Return the sole field-ref id in `expr`, or `null` if the expression
 * mentions zero or more than one distinct field. This is the
 * `bounded.bytes` analogue of `constraintToController`: a length scope
 * whose byte budget is `ihl*4 - 20` nominates `ihl` as its controller.
 *
 * Distinctness is computed via core's `exprRefs`, which walks every 0.5 Expr
 * shape (lookup keys, peek offsets, cond branches, …). A length expression
 * like `lookup(ref("lenCode"), …)` therefore correctly nominates `lenCode`
 * — the old hand-rolled walk only descended `op`/`cond`/`peek` and missed it.
 */
function singleRefController(expr: Expr): string | null {
  const refs = new Set(exprRefs(expr));
  return refs.size === 1 ? [...refs][0] : null;
}

/**
 * Walk the PSDL body (descending only through *transparent wire scopes* —
 * `bounded` itself plus already-resolved containers via `flattenForMirror`)
 * and collect, for each `Bounded` whose `bytes` expression has exactly one
 * field ref, that controller field's id. In 0.5 the IPv4/TCP "options"
 * length relation (`IHL*4 == headerBytes`, `dataOffset*4 == headerBytes`)
 * no longer lives in top-level `constraints`; it moved onto the options
 * `bounded.bytes` (`ihl*4 - 20` / `dataOffset*4 - 20`). Surfacing those as
 * length controllers keeps IHL / Data Offset overridable sliders.
 */
function collectBoundedControllers(
  containers: Container[],
  defs: Record<string, NamedStruct> | undefined,
  acc: Set<string>,
): void {
  for (const c of containers) {
    if (isField(c)) continue;
    if (c.kind === "bounded") {
      const controller = singleRefController(c.bytes);
      if (controller) acc.add(controller);
      collectBoundedControllers(c.fields, defs, acc);
      continue;
    }
    if (c.kind === "ref") {
      const def = defs?.[c.ref];
      if (def) collectBoundedControllers(def.fields, defs, acc);
      continue;
    }
    if (c.kind === "group") {
      collectBoundedControllers(c.children, defs, acc);
      continue;
    }
    if (c.kind === "optional") {
      collectBoundedControllers([c.container], defs, acc);
      continue;
    }
    if (c.kind === "repeat") {
      collectBoundedControllers(c.element.fields, defs, acc);
      continue;
    }
    if (c.kind === "switch") {
      for (const struct of Object.values(c.cases)) {
        collectBoundedControllers(struct.fields, defs, acc);
      }
      continue;
    }
    if (c.kind === "encrypted") {
      collectBoundedControllers(c.plaintext.fields, defs, acc);
      continue;
    }
  }
}

/**
 * Walk the PSDL body and produce a renderer-shaped Packet. Top-level
 * Repeat<Switch> nodes that look like TLV catalogs / chain catalogs are
 * promoted to renderer fields with `tlv` / `chainCatalog` populated so
 * TlvEditor and ChainEditor keep working. Groups whose direct children are
 * all leaf fields collapse to a single subfield-bearing renderer field.
 *
 * Nested Encrypted containers are skipped here — they contribute layout
 * cells via `resolveLayout`, not editor metadata.
 */
export function psdlToRenderer(packet: PsdlPacket): RendererPacket {
  const fields: RendererField[] = [];
  for (const c of flattenForMirror(packet.body, packet.defs)) {
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
      // Bare Switch — flatten to a placeholder. Carry its `doc` across so the
      // DetailPanel can surface the description, mirroring the Encrypted branch.
      const fld: RendererField = { id: c.id, name: c.name ?? c.id, bits: 0 };
      if (c.doc) fld.description = c.doc;
      fields.push(fld);
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
  // PSDL constraints. This lets ControlsPanel surface IHL / Data Offset as
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
  // 0.5: the IPv4/TCP options-length relation moved from `constraints` onto
  // the options `bounded.bytes` (`ihl*4 - 20`, `dataOffset*4 - 20`). Derive
  // length controllers from those single-ref bounded scopes the same way as
  // the constraint-driven path above, so IHL / Data Offset stay overridable.
  const boundedControllers = new Set<string>();
  collectBoundedControllers(packet.body, packet.defs, boundedControllers);
  for (const fromId of boundedControllers) {
    const target = fields.find((f) => f.id === fromId);
    if (target && !target.controlsLength) {
      target.controlsLength = fromId;
      if (target.bits != null) {
        target.max = Math.max(target.max ?? 0, 2 ** target.bits - 1);
      }
    }
  }
  attachOverrideMetadata(packet.body, fields);
  const freeRepeats = collectFreeRepeats(packet.body, fields);
  const peekSwitches = collectPeekSwitches(packet.body);
  const refSwitches = collectRefSwitches(packet.body, fields);
  return {
    name: packet.name,
    rowBits: packet.rowBits,
    fields,
    ...(packet.description ? { description: packet.description } : {}),
    ...(packet.byteOrder ? { byteOrder: packet.byteOrder } : {}),
    ...(freeRepeats.length > 0 ? { freeRepeats } : {}),
    ...(peekSwitches.length > 0 ? { peekSwitches } : {}),
    ...(refSwitches.length > 0 ? { refSwitches } : {}),
  };
}

/**
 * Find Switches inside a plain (non-TLV/non-chain) repeat whose `on` is a
 * `ref(X)`. Because that repeat is dropped from the renderer mirror, the
 * discriminator X has no override widget and the per-record variant is stuck at
 * its default — so surface a packet-level variant picker keyed on X's env id
 * (override-audit A2). Skipped when X already carries a field-bearing widget.
 */
/** Collect every `ref` field id reachable inside an arbitrary value (Expr tree,
 *  type node, …). Generic so it doesn't need to enumerate the Expr union. */
function refsIn(value: unknown, acc: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) refsIn(v, acc);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (obj.kind === "ref" && typeof obj.field === "string") acc.add(obj.field);
  for (const v of Object.values(obj)) refsIn(v, acc);
}

/** Field ids that drive a LENGTH or byte-budget somewhere in the packet:
 *  `bounded.bytes`, a field's length-bearing `type`, or a `repeat.count`.
 *  A Switch discriminator that also appears here is a length/format encoder
 *  (BGP Extended-Length flag, CoAP option nibble), NOT a record-variant
 *  selector — driving it desyncs lengths / over-consumes scopes, so we must not
 *  surface it as a "Record variants" picker. */
function collectLengthDrivingRefs(body: PsdlPacket["body"]): Set<string> {
  const acc = new Set<string>();
  const visit = (containers: PsdlPacket["body"]): void => {
    for (const c of containers) {
      if (isField(c)) {
        refsIn(c.type, acc);
        continue;
      }
      if (c.kind === "bounded") {
        refsIn(c.bytes, acc);
        visit(c.fields);
        continue;
      }
      if (c.kind === "repeat") {
        refsIn(c.count, acc);
        visit(c.element.fields);
        continue;
      }
      if (c.kind === "group") {
        visit(c.children);
        continue;
      }
      if (c.kind === "switch") {
        for (const struct of Object.values(c.cases)) visit(struct.fields);
        continue;
      }
      if (c.kind === "optional") {
        visit([c.container]);
        continue;
      }
      if (c.kind === "encrypted") {
        visit(c.plaintext.fields);
        continue;
      }
    }
  };
  visit(body);
  return acc;
}

/** Map each int/enum/bits field id to its bit width. Used to tell a record-type
 *  code (≥ 8 bits — dnsRrType, attrTypeCode) from a length/format nibble or flag
 *  (≤ 4 bits — CoAP optDelta/optLength, BGP attrExtLen), whose extension fields
 *  are coupled to byte lengths and must not be user-driven as a variant. */
function collectFieldBits(body: PsdlPacket["body"]): Map<string, number> {
  const bits = new Map<string, number>();
  const visit = (containers: PsdlPacket["body"]): void => {
    for (const c of containers) {
      if (isField(c)) {
        const t = c.type as { kind?: string; bits?: number; n?: unknown };
        const w =
          typeof t.bits === "number"
            ? t.bits
            : typeof t.n === "number"
              ? t.n
              : undefined;
        if (w !== undefined) bits.set(c.id, w);
        continue;
      }
      if (c.kind === "bounded") visit(c.fields);
      else if (c.kind === "repeat") visit(c.element.fields);
      else if (c.kind === "group") visit(c.children);
      else if (c.kind === "switch")
        for (const s of Object.values(c.cases)) visit(s.fields);
      else if (c.kind === "optional") visit([c.container]);
      else if (c.kind === "encrypted") visit(c.plaintext.fields);
    }
  };
  visit(body);
  return bits;
}

function collectRefSwitches(
  body: PsdlPacket["body"],
  fields: RendererField[],
): NonNullable<RendererPacket["refSwitches"]> {
  const out: NonNullable<RendererPacket["refSwitches"]> = [];
  const lengthDriving = collectLengthDrivingRefs(body);
  const fieldBits = collectFieldBits(body);
  const seen = new Set<string>();
  const visit = (
    containers: PsdlPacket["body"],
    insidePlainRepeat: boolean,
  ): void => {
    for (const c of flattenForMirror(containers)) {
      if (c.kind === "repeat") {
        const plain = !isLikelyChainRepeat(c) && !isTlvRepeat(c);
        visit(c.element.fields, insidePlainRepeat || plain);
        continue;
      }
      if (c.kind === "switch") {
        if (insidePlainRepeat && c.on.kind === "ref") {
          const refKey = c.on.field;
          const covered = fields.find(
            (f) =>
              f.id === refKey &&
              (f.controlsLength || f.switchCases || f.enumVariants),
          );
          // Skip length/format-encoder switches (BGP Extended-Length flag,
          // CoAP option nibbles): driving their discriminator desyncs lengths
          // or over-consumes a bounded scope rather than choosing a record
          // variant (review HIGH). Two signals: the discriminator is itself a
          // length ref, or it's a sub-byte nibble/flag (< 8 bits) whose cases
          // add length-extension fields — a record-type code is ≥ 8 bits.
          const discBits = fieldBits.get(refKey);
          const isEncoder =
            lengthDriving.has(refKey) ||
            (discBits !== undefined && discBits < 8);
          if (!covered && !isEncoder && !seen.has(refKey)) {
            const cases: { value: number; label: string }[] = [];
            for (const [key, struct] of Object.entries(c.cases)) {
              const v = Number(key);
              if (!Number.isFinite(v)) continue;
              cases.push({ value: v, label: struct.name ?? `case ${key}` });
            }
            if (cases.length > 0) {
              seen.add(refKey);
              out.push({ id: c.id, name: c.name ?? refKey, cases, refKey });
            }
          }
        }
        for (const struct of Object.values(c.cases))
          visit(struct.fields, insidePlainRepeat);
        continue;
      }
      if (c.kind === "group") {
        visit(c.children, insidePlainRepeat);
        continue;
      }
      if (c.kind === "optional") {
        visit([c.container], insidePlainRepeat);
        continue;
      }
      if (c.kind === "encrypted") {
        visit(c.plaintext.fields, insidePlainRepeat);
        continue;
      }
    }
  };
  visit(body, false);
  return out;
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
  body: PsdlPacket["body"],
  fields: RendererField[],
): NonNullable<RendererPacket["freeRepeats"]> {
  const out: NonNullable<RendererPacket["freeRepeats"]> = [];
  // `insideBounded` tracks whether the current scope is inside a `bounded`
  // byte-budget. A repeat nested in a bounded must NOT be auto-seeded with a
  // default count — increasing its iterations consumes the bounded budget and
  // would over-consume (the count is meant to follow the scope's length field).
  // We can't use `flattenForMirror` here because it erases bounded boundaries;
  // recurse manually so the flag survives.
  const visit = (
    containers: PsdlPacket["body"],
    insideBounded: boolean,
    insideRepeat: boolean,
  ): void => {
    for (const c of containers) {
      if (isField(c)) continue;
      if (c.kind === "bounded") {
        visit(c.fields, true, insideRepeat);
        continue;
      }
      if (c.kind === "align" || c.kind === "virtual" || c.kind === "ref") {
        // align/virtual carry no override surface; ref is left unresolved here
        // (matches the previous flattenForMirror(no-defs) behaviour).
        continue;
      }
      if (c.kind === "repeat") {
        if (!isLikelyChainRepeat(c) && !isTlvRepeat(c)) {
          let countKey: string | null = null;
          let label = c.name ?? c.id;
          let defaultCount: number | undefined;
          if (
            c.count === "eos" ||
            (typeof c.count === "object" && "until" in c.count)
          ) {
            countKey = c.id;
            label = `${label} (${c.count === "eos" ? "eos" : "until"})`;
            // Show one representative record on load when it's safe (not
            // constrained by an enclosing bounded byte-budget).
            if (!insideBounded) defaultCount = 1;
          } else if (
            typeof c.count === "object" &&
            c.count.kind === "ref" &&
            !insideRepeat
          ) {
            // Only surface when no existing field-bearing widget covers it.
            // Skipped inside an enclosing repeat: the count ref then names a
            // PER-ITERATION field, but a single global stepper can't give
            // distinct per-instance counts and would also corrupt the rendered
            // value of that field (override-audit A7).
            // NOTE: op/cond counts (e.g. SRv6 `srhLastEntry + 1`) are
            // deliberately NOT surfaced — those repeats are gated by a separate
            // length field (hdrExtLen), so a stepper on the count ref alone is
            // inert and misleading (override-audit A5, left as a known gap).
            const ref = c.count.field;
            const covered = fields.find(
              (f) =>
                f.id === ref &&
                (f.controlsLength || f.switchCases || f.enumVariants),
            );
            if (!covered) countKey = ref;
          }
          if (countKey) {
            out.push({
              name: label,
              countKey,
              ...(defaultCount !== undefined ? { defaultCount } : {}),
            });
          }
        }
        visit(c.element.fields, insideBounded, true);
        continue;
      }
      if (c.kind === "group") {
        visit(c.children, insideBounded, insideRepeat);
        continue;
      }
      if (c.kind === "switch") {
        for (const struct of Object.values(c.cases))
          visit(struct.fields, insideBounded, insideRepeat);
        continue;
      }
      if (c.kind === "optional") {
        visit([c.container], insideBounded, insideRepeat);
        continue;
      }
      if (c.kind === "encrypted") {
        visit(c.plaintext.fields, insideBounded, insideRepeat);
        continue;
      }
    }
  };
  visit(body, false, false);
  return out;
}

/**
 * Find Switches whose `on` is a `peek` expression (TLS extension type
 * dispatch etc). The peek synthesizes an env key
 * `__peek__<offset>__<bits>` per the PSDL spec. We expose this so
 * OverridePanel can render a synthetic case picker — there's no real cell
 * to attach to since `peek` doesn't consume bytes.
 */
function collectPeekSwitches(
  body: PsdlPacket["body"],
): NonNullable<RendererPacket["peekSwitches"]> {
  const out: NonNullable<RendererPacket["peekSwitches"]> = [];
  const visit = (containers: PsdlPacket["body"]): void => {
    for (const c of flattenForMirror(containers)) {
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
        visit([c.container]);
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
 * Recursively walk PSDL containers and attach override metadata to the
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
  body: PsdlPacket["body"],
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

  // Pull the primary ref id out of an Expr — the first field referenced
  // anywhere in it, or null. Backed by core's `exprRefs`, so 0.5 shapes
  // (lookup keys, peek offsets, …) surface a controller too; `op` / `cond`
  // behaviour is unchanged (first ref in walk order still wins).
  const primaryRef = (expr: import("../types").Expr): string | null =>
    exprRefs(expr)[0] ?? null;

  const visit = (containers: PsdlPacket["body"]): void => {
    for (const c of flattenForMirror(containers)) {
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
        const inner = c.container;
        const gated =
          ("name" in inner ? inner.name : undefined) ??
          ("id" in inner ? inner.id : undefined) ??
          inner.kind ??
          "container";
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
        visit([c.container]);
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
