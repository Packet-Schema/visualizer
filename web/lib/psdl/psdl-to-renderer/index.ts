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
import { exprRefs, peekEnvKey } from "../expr";
import { isBytesDelimited } from "../normalize";
import type {
  Constraint,
  Container,
  Expr,
  NamedStruct,
  Packet as PsdlPacket,
  Repeat,
  Switch,
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
import { firstCaseKeyValue, typeBits } from "./shared";

export { rendererToPsdl } from "./to-psdl";
export { applyTlvInstances } from "./apply-tlv";
export { applyChainInstances, parseChainCellId } from "./apply-chain";
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
  const lengthControllers: RendererField[] = [];
  for (const fromId of boundedControllers) {
    const target = fields.find((f) => f.id === fromId);
    if (target && !target.controlsLength) {
      target.controlsLength = fromId;
      if (target.bits != null) {
        target.max = Math.max(target.max ?? 0, 2 ** target.bits - 1);
      }
      continue;
    }
    if (target) continue;
    // The length field isn't a top-level cell — it lives inside a Group (it's a
    // subfield). It can't host its own slider, so surface a packet-level length
    // controller; raising it grows the bounded budget so the enclosed repeat
    // becomes editable instead of stuck empty (override-design-audit A3).
    for (const f of fields) {
      const sub = f.subfields?.find((s) => s.id === fromId);
      if (!sub) continue;
      lengthControllers.push({
        id: fromId,
        name: sub.name,
        bits: sub.bits,
        controlsLength: fromId,
        max: sub.bits > 0 ? 2 ** sub.bits - 1 : undefined,
        defaultValue: sub.defaultValue,
      });
      break;
    }
  }
  attachOverrideMetadata(packet.body, fields, packet.defs);
  // A chain's base field carries a chainCatalog (the chain editor's surface);
  // attachOverrideMetadata ALSO stamps switchCases on it from the same Switch.
  // OverridePanel dispatches chainCatalog first, so the switchCases are dead
  // redundant metadata — drop them so the mirror carries one control per
  // discriminator (override-design-audit).
  for (const f of fields) {
    if (f.chainCatalog && f.switchCases) delete f.switchCases;
  }
  const { freeRepeats, boundedRepeats, instantiableRepeatIds } =
    collectFreeRepeats(packet.body, fields, packet.defs);
  const peekSwitches = collectPeekSwitches(packet.body, packet.defs);
  // Field ids that carry a SURFACED override control the user can move: a
  // top-level cell, a length controller, a freeRepeat stepper, or a
  // boundedRepeat's count/length key. A refSwitch arm whose only content is a
  // `bytes(ref X)` value sized by an X NOT in this set can never render at a
  // non-zero width, so the picker can't change the diagram (isisLsp tlvType,
  // whose tlvLength has no control) — collectRefSwitches uses this to suppress
  // such inert pickers.
  const controlledIds = new Set<string>();
  for (const f of fields) controlledIds.add(f.id);
  for (const lc of lengthControllers) controlledIds.add(lc.id);
  for (const fr of freeRepeats) controlledIds.add(fr.countKey);
  for (const br of boundedRepeats) {
    controlledIds.add(br.countKey);
    controlledIds.add(br.lengthKey);
  }
  const refSwitches = collectRefSwitches(
    packet.body,
    fields,
    instantiableRepeatIds,
    controlledIds,
    packet.defs,
  );
  return {
    name: packet.name,
    rowBits: packet.rowBits,
    fields,
    ...(packet.description ? { description: packet.description } : {}),
    ...(packet.byteOrder ? { byteOrder: packet.byteOrder } : {}),
    ...(freeRepeats.length > 0 ? { freeRepeats } : {}),
    ...(peekSwitches.length > 0 ? { peekSwitches } : {}),
    ...(refSwitches.length > 0 ? { refSwitches } : {}),
    ...(lengthControllers.length > 0 ? { lengthControllers } : {}),
    ...(boundedRepeats.length > 0 ? { boundedRepeats } : {}),
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

/** Map each `enum` field id to its `value → label` table. Used to render a
 *  switch discriminator value (msdpType=3) as a human-readable case label
 *  ("SA-Response") when disambiguating colliding switch-case-nested freeRepeat
 *  steppers. Plain int discriminators (icmpv6Ndp `type`) have no entry; the
 *  caller falls back to the bare numeric value. */
function collectEnumVariants(
  body: PsdlPacket["body"],
): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  const visit = (containers: PsdlPacket["body"]): void => {
    for (const c of containers) {
      if (isField(c)) {
        if (c.type.kind === "enum") {
          const table: Record<string, string> = {};
          for (const [k, v] of Object.entries(c.type.variants)) {
            table[k] = typeof v === "string" ? v : v.label;
          }
          out.set(c.id, table);
        }
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
  return out;
}

/** Map each field id to its display name (falling back to the id). Used to
 *  label a plain-int discriminator value as "Type=133" rather than the raw id
 *  "type=133" when no enum variant table is available (icmpv6Ndp). */
function collectFieldNames(body: PsdlPacket["body"]): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (containers: PsdlPacket["body"]): void => {
    for (const c of containers) {
      if (isField(c)) {
        out.set(c.id, c.name ?? c.id);
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
  return out;
}

/** Collect the ids of all `virtual` fields reachable from the body (descending
 *  through every transparent/structural container AND ref-resolved defs). A
 *  `virtual` field's env value is RECOMPUTED by core's normalize (`walkVirtual`
 *  does `state.env.set(id, eval(expr))`) every render, so any OverridePanel
 *  control wired to `env[virtualId]` is clobbered before the diagram reads it —
 *  it is an inert/misleading control. A freeRepeat whose count is `ref(virtual)`
 *  (kerberosAsReq `padataList count={ref:padataCount}`, padataCount=virtual lit
 *  1) is exactly such a case: stepping it never changes the record count, so the
 *  stepper must NOT be surfaced. */
function collectVirtualIds(
  body: PsdlPacket["body"],
  defs: Record<string, NamedStruct> | undefined,
): Set<string> {
  const out = new Set<string>();
  const seenDefs = new Set<string>();
  const visit = (containers: PsdlPacket["body"]): void => {
    for (const c of containers) {
      if (isField(c)) continue;
      if (c.kind === "virtual") out.add(c.id);
      else if (c.kind === "bounded") visit(c.fields);
      else if (c.kind === "repeat") visit(c.element.fields);
      else if (c.kind === "group") visit(c.children);
      else if (c.kind === "switch")
        for (const s of Object.values(c.cases)) visit(s.fields);
      else if (c.kind === "optional") visit([c.container]);
      else if (c.kind === "encrypted") visit(c.plaintext.fields);
      else if (c.kind === "ref") {
        const def = defs?.[c.ref];
        if (def && !seenDefs.has(c.ref)) {
          seenDefs.add(c.ref);
          visit(def.fields);
        }
      }
    }
  };
  visit(body);
  return out;
}

/**
 * Build a human-readable label for a single Switch case, used to qualify the
 * name of a freeRepeat surfaced from INSIDE that case so colliding labels
 * (icmpv6Ndp's five `Options` repeats, one per Type case; msdp's two `SA
 * Entries`, in the SA and SA-Response cases) become distinct and the user can
 * tell which stepper is live (override-design-audit). Preference order:
 *   1. the discriminator enum's variant label for the case key (msdp:
 *      `msdpType` enum → "SA-Response"),
 *   2. the discriminator field's display name and value (icmpv6Ndp: `type` is a
 *      plain int → "Type=133").
 * Returns null for the `_` default arm (no meaningful selector value).
 */
function switchCaseLabel(
  on: Switch["on"],
  caseKey: string,
  enumVariants: Map<string, Record<string, string>>,
  fieldNames: Map<string, string>,
): string | null {
  const value = firstCaseKeyValue(caseKey);
  if (value === null) return null;
  if (on.kind === "ref") {
    const variants = enumVariants.get(on.field);
    const label = variants?.[String(value)];
    if (label) return label;
    return `${fieldNames.get(on.field) ?? on.field}=${value}`;
  }
  return `case ${value}`;
}

/**
 * True when EVERY case arm of a Switch collapses to zero visible width at the
 * default env — i.e. every field in every case is a variable-length `bytes`
 * value whose length `n` is a `ref` (or expr) mentioning ONLY field ids with no
 * surfaced override control (`controlledIds`). Such a value renders at width 0
 * for all reachable env states, so selecting any discriminator value produces a
 * byte-identical diagram — the picker is inert (isisLsp's `byType` on tlvType:
 * each arm is `bytes(ref tlvLength)`, and tlvLength has no control anywhere).
 *
 * Returns false the moment any case carries something the picker COULD make
 * visible: a fixed-width field, a delimited/varint value (seeded to a visible
 * default), a `bytes` whose length ref IS controllable, or a nested non-field
 * container — so a genuinely variant-driving picker (dnsResponse dnsRrType, with
 * fixed-width A/AAAA records) is never suppressed.
 */
function switchArmsAllZeroWidth(
  cases: Record<string, { fields: Container[] }>,
  controlledIds: Set<string>,
): boolean {
  const armCollapses = (containers: Container[]): boolean => {
    // An empty arm has nothing to distinguish it; treat as collapsing so it
    // doesn't single-handedly keep an otherwise-inert picker alive.
    for (const c of containers) {
      if (!isField(c)) return false; // nested container: assume it can show
      if (c.type.kind !== "bytes") return false; // fixed-width: visible
      const n = c.type.n;
      if (isBytesDelimited(n)) return false; // seeded to a visible default
      const refs = exprRefs(n);
      // No refs at all → not a sibling-ref-sized value (lit/varint-ish): the
      // length isn't gated by an uncontrolled sibling, so don't suppress.
      if (refs.length === 0) return false;
      // Any length ref the user CAN drive means the picked arm can be made
      // visible — keep the picker.
      if (refs.some((r) => controlledIds.has(r))) return false;
    }
    return true;
  };
  const arms = Object.values(cases);
  if (arms.length === 0) return false;
  return arms.every((s) => armCollapses(s.fields));
}

/**
 * Structural fingerprint of a container that ignores identity-only fields
 * (`id`, `name`, `doc`, …) and keeps everything that affects the rendered
 * geometry: the node `kind`, a field's `type`, a Switch's discriminator and
 * arm shapes, a Repeat's count, a Bounded's budget, etc. Two containers with
 * the same fingerprint resolve to a byte-identical layout for every env — they
 * differ only in labels.
 */
function structuralShape(c: Container): unknown {
  if (isField(c)) return ["field", c.type];
  switch (c.kind) {
    case "switch":
      return [
        "switch",
        c.on,
        Object.entries(c.cases).map(([k, v]) => [
          k,
          v.fields.map(structuralShape),
        ]),
      ];
    case "repeat":
      return ["repeat", c.count, c.element.fields.map(structuralShape)];
    case "group":
      return ["group", c.children.map(structuralShape)];
    case "optional":
      return ["optional", c.when, structuralShape(c.container)];
    case "bounded":
      return ["bounded", c.bytes, c.fields.map(structuralShape)];
    case "encrypted":
      return ["encrypted", c.plaintext.fields.map(structuralShape)];
    case "ref":
      return ["ref", c.ref];
    case "align":
      return ["align", c.to];
    case "virtual":
      return ["virtual", c.expr];
  }
}

/**
 * True when EVERY selectable case arm of a `ref`-discriminated Switch is
 * STRUCTURALLY IDENTICAL (same ordered field shapes, ignoring ids/names) — so
 * choosing any value of the discriminator yields a byte-identical layout and
 * the case picker is inert. Catches both:
 *   - tlsHandshake `handshakeType` (10 arms, each a single
 *     `bytes(ref tlsHandshakeBodyLen)` opaque body), and
 *   - eap `eapCode` (2 arms, each `enum(8)` + `bytes(eapLength - 5)`),
 * which `attachOverrideMetadata` would otherwise stamp as a multi-option
 * `switchCases` dropdown that can never change the diagram. Requires ≥ 2
 * selectable arms: a single-arm switch is a degenerate (non-multi-option)
 * picker left untouched, and the default (`_`) arm is excluded since it is not
 * a user-selectable value.
 */
function switchArmsAllIdentical(
  cases: Record<string, { fields: Container[] }>,
): boolean {
  const selectable = Object.entries(cases).filter(
    ([key]) => firstCaseKeyValue(key) !== null,
  );
  if (selectable.length < 2) return false;
  const shapes = selectable.map(([, struct]) =>
    JSON.stringify(struct.fields.map(structuralShape)),
  );
  return shapes.every((s) => s === shapes[0]);
}

/** Collect the ids of every field declared (transitively) INSIDE a `switch`
 *  case anywhere in the body. Such a field is never a top-level renderer-mirror
 *  cell, so `attachOverrideMetadata.findTarget` can't stamp `switchCases` on it
 *  and it gets no field-anchored widget. A nested `switch` discriminated on such
 *  a field (oncRpc's replyData/acceptData/rejectData, switched on
 *  replyStat/acceptStat/rejectStat — themselves declared inside the outer
 *  rpcBody Reply case) therefore needs a packet-level refSwitch picker. */
function collectSwitchCaseFieldIds(
  body: PsdlPacket["body"],
  defs: Record<string, NamedStruct> | undefined,
): Set<string> {
  const acc = new Set<string>();
  // Walk normally; once we step through a switch case, everything below is
  // "inside a case" — collect every field id seen there.
  const visit = (containers: Container[], insideCase: boolean): void => {
    for (const c of flattenForMirror(containers, defs)) {
      if (isField(c)) {
        if (insideCase) acc.add(c.id);
        continue;
      }
      if (c.kind === "switch") {
        for (const struct of Object.values(c.cases)) visit(struct.fields, true);
        continue;
      }
      if (c.kind === "repeat") {
        visit(c.element.fields, insideCase);
        continue;
      }
      if (c.kind === "group") {
        visit(c.children, insideCase);
        continue;
      }
      if (c.kind === "optional") {
        visit([c.container], insideCase);
        continue;
      }
      if (c.kind === "encrypted") {
        visit(c.plaintext.fields, insideCase);
        continue;
      }
    }
  };
  visit(body, false);
  return acc;
}

function collectRefSwitches(
  body: PsdlPacket["body"],
  fields: RendererField[],
  instantiableRepeatIds: Set<string>,
  controlledIds: Set<string>,
  defs: Record<string, NamedStruct> | undefined,
): NonNullable<RendererPacket["refSwitches"]> {
  const out: NonNullable<RendererPacket["refSwitches"]> = [];
  const lengthDriving = collectLengthDrivingRefs(body);
  const fieldBits = collectFieldBits(body);
  // Field ids declared inside a switch case — a switch discriminated on one of
  // these has no top-level cell to host a `switchCases` widget, so it needs a
  // packet-level refSwitch picker even when it is NOT inside a repeat.
  const switchCaseFieldIds = collectSwitchCaseFieldIds(body, defs);
  const seen = new Set<string>();
  const visit = (
    containers: PsdlPacket["body"],
    // The nearest enclosing PLAIN (non-TLV/non-chain) repeat, or null. We track
    // the repeat ITSELF (not just a boolean) so we can check whether its records
    // are instantiable by a surfaced count control. A refSwitch whose records can
    // never appear (its repeat is in NEITHER freeRepeats NOR boundedRepeats) is a
    // visible control with no possible effect on the diagram — an inert/misleading
    // surface — so it must be suppressed (bgpPathAttributes' attrTypeCode picker).
    enclosingPlainRepeat: Repeat | null,
    // True once we are inside ANY repeat (plain, TLV, OR chain). The case-nested
    // path below must stay top-level: a switch inside a chain/TLV repeat (ipv6's
    // `nextHeader_byProto` re-declares `nextHeader` per proto case) is already
    // owned by the chain / TLV editor, so surfacing it as a refSwitch would be a
    // redundant, inert duplicate. `enclosingPlainRepeat` alone misses this — it
    // is null inside chain/TLV repeats by design — so we track repeat nesting
    // separately.
    insideRepeat: boolean,
  ): void => {
    for (const c of flattenForMirror(containers, defs)) {
      if (c.kind === "repeat") {
        const plain = !isLikelyChainRepeat(c) && !isTlvRepeat(c);
        visit(c.element.fields, plain ? c : enclosingPlainRepeat, true);
        continue;
      }
      if (c.kind === "switch") {
        // A ref-discriminated switch needs a packet-level picker in two cases:
        //   (1) it sits inside a plain repeat whose discriminator has no
        //       field-anchored widget (the original A2 path), or
        //   (2) it is discriminated on a field DECLARED INSIDE A SWITCH CASE
        //       (oncRpc replyData/acceptData/rejectData on
        //       replyStat/acceptStat/rejectStat): that discriminator is never a
        //       top-level cell, so attachOverrideMetadata can't stamp
        //       switchCases on it and collectRefSwitches' repeat path never
        //       reaches it — a see-but-cannot-edit gap.
        const caseNested =
          !enclosingPlainRepeat &&
          !insideRepeat &&
          c.on.kind === "ref" &&
          switchCaseFieldIds.has(c.on.field);
        if ((enclosingPlainRepeat || caseNested) && c.on.kind === "ref") {
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
          // Suppress the picker when the enclosing repeat has NO surfaced count
          // control: its records are never instantiated at any value, so the
          // variant choice can't change the diagram. bgpPathAttributes wraps a
          // per-record nested bounded scope, so collectFreeRepeats deliberately
          // leaves it non-derived (it's in neither freeRepeats nor
          // boundedRepeats) — its attrTypeCode picker would be permanently inert.
          // A case-nested switch has no enclosing repeat: it is "instantiated"
          // by selecting the OUTER switch arm (itself a surfaced switchCases /
          // refSwitch picker), so there is nothing to gate on here.
          const instantiable = caseNested
            ? true
            : instantiableRepeatIds.has(enclosingPlainRepeat!.id);
          // Even an instantiable repeat yields an inert picker if every case
          // arm collapses to width 0 at default (its only content is a
          // `bytes(ref X)` value whose length X has no surfaced control). The
          // diagram is then byte-identical for every selectable value, so the
          // control can't change anything — suppress it (isisLsp tlvType: arms
          // are `bytes(ref tlvLength)`, tlvLength uncontrolled).
          const allArmsInert = switchArmsAllZeroWidth(c.cases, controlledIds);
          // For a case-nested picker there is no zero-width safety net from a
          // repeat budget, so also drop it when every selectable arm is
          // structurally identical (the diagram is byte-identical for every
          // value — an inert dropdown). The repeat path keeps its existing
          // gating untouched.
          const allArmsIdentical =
            caseNested && switchArmsAllIdentical(c.cases);
          if (
            !covered &&
            !isEncoder &&
            instantiable &&
            !allArmsInert &&
            !allArmsIdentical &&
            !seen.has(refKey)
          ) {
            const cases: { value: number; label: string }[] = [];
            for (const [key, struct] of Object.entries(c.cases)) {
              const v = firstCaseKeyValue(key);
              if (v === null) continue;
              cases.push({ value: v, label: struct.name ?? `case ${key}` });
            }
            if (cases.length > 0) {
              seen.add(refKey);
              out.push({ id: c.id, name: c.name ?? refKey, cases, refKey });
            }
          }
        }
        for (const struct of Object.values(c.cases))
          visit(struct.fields, enclosingPlainRepeat, insideRepeat);
        continue;
      }
      if (c.kind === "group") {
        visit(c.children, enclosingPlainRepeat, insideRepeat);
        continue;
      }
      if (c.kind === "optional") {
        visit([c.container], enclosingPlainRepeat, insideRepeat);
        continue;
      }
      if (c.kind === "encrypted") {
        visit(c.plaintext.fields, enclosingPlainRepeat, insideRepeat);
        continue;
      }
    }
  };
  visit(body, null, false);
  return out;
}

/**
 * For a Repeat count expression that mentions exactly one field `ref`, derive
 * the affine relation `recordCount = ref * mul + add` for the common
 * single-binary-op forms so a freeRepeat stepper can display the real record
 * count and write the inverted controller value. Returns `null` for shapes we
 * can't invert reliably (cond branches, division/modulo, nested ops, a bare
 * `ref` with no op): the caller then surfaces the ref with an identity
 * (undefined) transform so the user still gets a working — if field-labelled —
 * control.
 *
 *   ref + k → mul=1,  add=k       (SRv6 `srhLastEntry + 1`)
 *   ref - k → mul=1,  add=-k
 *   k - ref → mul=-1, add=k
 *   ref * k → mul=k,  add=0   (k>0)
 *   k * ref → mul=k,  add=0   (k>0)
 */
function affineCountTransform(
  expr: Expr,
  ref: string,
): { mul: number; add: number } | null {
  if (expr.kind !== "op") return null;
  const { op: o, a, b } = expr;
  const isRef = (e: Expr): boolean => e.kind === "ref" && e.field === ref;
  const litVal = (e: Expr): number | null =>
    e.kind === "lit" ? e.value : null;
  if (o === "+") {
    if (isRef(a)) {
      const k = litVal(b);
      if (k !== null) return { mul: 1, add: k };
    }
    if (isRef(b)) {
      const k = litVal(a);
      if (k !== null) return { mul: 1, add: k };
    }
    return null;
  }
  if (o === "-") {
    // ref - k → record = ref - k
    if (isRef(a)) {
      const k = litVal(b);
      if (k !== null) return { mul: 1, add: -k };
    }
    // k - ref → record = -ref + k
    if (isRef(b)) {
      const k = litVal(a);
      if (k !== null) return { mul: -1, add: k };
    }
    return null;
  }
  if (o === "*") {
    // Only a positive literal multiplier is invertible without ambiguity
    // (mul=0 would make every record count collapse to `add`).
    if (isRef(a)) {
      const k = litVal(b);
      if (k !== null && k > 0) return { mul: k, add: 0 };
    }
    if (isRef(b)) {
      const k = litVal(a);
      if (k !== null && k > 0) return { mul: k, add: 0 };
    }
    return null;
  }
  return null;
}

/**
 * A `ref`-count Repeat is "record-bearing" when its element encloses a variant
 * `Switch` (whose `ref`/`peek` discriminator becomes a surfaced refSwitch /
 * peekSwitch picker) or a nested `Repeat`. Such a repeat needs at least one
 * instance at load so that picker (or the nested structure) is not inert —
 * choosing a variant at count 0 changes nothing because no record exists to
 * take it (#11/#12). Plain scalar-list ref-count repeats (vrrp IP addresses,
 * RTP CSRC list, …) are NOT record-bearing: they stay at the 0-seed.
 */
function repeatIsRecordBearing(repeat: Repeat): boolean {
  const walk = (containers: Container[]): boolean => {
    for (const c of containers) {
      if (isField(c)) continue;
      if (c.kind === "repeat") return true;
      if (c.kind === "switch") {
        // Only a Switch with at least one numeric (non-`_`) case key — a real
        // variant selector. A bare default-only switch carries no picker.
        const hasVariant = Object.keys(c.cases).some(
          (k) => firstCaseKeyValue(k) !== null,
        );
        if (hasVariant) return true;
        for (const struct of Object.values(c.cases))
          if (walk(struct.fields)) return true;
        continue;
      }
      if (c.kind === "group") {
        if (walk(c.children)) return true;
        continue;
      }
      if (c.kind === "bounded") {
        if (walk(c.fields)) return true;
        continue;
      }
      if (c.kind === "optional") {
        if (walk([c.container])) return true;
        continue;
      }
      if (c.kind === "encrypted") {
        if (walk(c.plaintext.fields)) return true;
        continue;
      }
    }
    return false;
  };
  return walk(repeat.element.fields);
}

/**
 * Find Repeats whose count isn't already covered by an existing override:
 *   * Not a TLV / chain Repeat (those get list editors).
 *   * Their `count: ref(X)` doesn't land on a field with `controlsLength`
 *     (= a slider) or any other widget-bearing field.
 *   * `op` / `cond` counts whose expression tree mentions exactly one field
 *     ref (e.g. SRv6 `srhLastEntry + 1`): surfaced keyed on that ref, with an
 *     affine `transform` so the stepper shows the real record count.
 * Surface them as packet-level "Repeats" steppers in OverridePanel.
 * Also covers `eos` / `{ until: Expr }` shapes where the count env key is
 * the Repeat's own id (per normalize.ts).
 */
function collectFreeRepeats(
  body: PsdlPacket["body"],
  fields: RendererField[],
  defs: Record<string, NamedStruct> | undefined,
): {
  freeRepeats: NonNullable<RendererPacket["freeRepeats"]>;
  boundedRepeats: NonNullable<RendererPacket["boundedRepeats"]>;
  /** Repeat ids that got a SURFACED count control (a freeRepeat stepper or a
   *  budget-derived boundedRepeat). A refSwitch inside a repeat NOT in this set
   *  is inert — its records can never be instantiated by any control — so
   *  collectRefSwitches suppresses it (bgpPathAttributes' attrTypeCode picker). */
  instantiableRepeatIds: Set<string>;
} {
  const out: NonNullable<RendererPacket["freeRepeats"]> = [];
  const boundedOut: NonNullable<RendererPacket["boundedRepeats"]> = [];
  // Repeat ids whose count IS user-drivable via a surfaced control (populated
  // alongside `out` / `boundedOut` below).
  const instantiableRepeatIds = new Set<string>();
  // Enum variant labels + field display names per discriminator — used to
  // qualify a switch-case-nested freeRepeat's name with its enclosing case so
  // colliding labels (icmpv6Ndp's five `Options`, msdp's two `SA Entries`) stay
  // distinct.
  const enumVariants = collectEnumVariants(body);
  const fieldNames = collectFieldNames(body);
  // Ids of `virtual` fields: a count ref resolving to one cannot be driven (core
  // normalize recomputes env[virtualId] from its expr every render), so a
  // freeRepeat keyed on it would be inert/misleading — suppressed below.
  const virtualIds = collectVirtualIds(body, defs);
  // `boundedKey` is the single-ref length field of the nearest enclosing
  // `bounded` byte-budget (or null). An eos/until repeat inside one must NOT get
  // a naked count stepper (bumping it over-consumes the budget — a destructive
  // control); instead its count is DERIVED from the budget at layout time, so
  // the length slider is the single control. We can't use `flattenForMirror`
  // here because it erases bounded boundaries; recurse manually.
  const visit = (
    containers: PsdlPacket["body"],
    bounded: { key: string; prefix: number; bytes: Expr } | null,
    insideRepeat: boolean,
    insideSwitch: boolean,
    // True when the NEAREST enclosing repeat (if any) itself has a surfaced
    // count control — i.e. its records can actually be instantiated. At the top
    // level (no enclosing repeat) it is true. When descending into a repeat
    // element it becomes `instantiableRepeatIds.has(parent.id)`. A free eos/until
    // child of a NON-instantiable parent (bgpUpdateFull bgpPathAttributes, which
    // is in NEITHER freeRepeats NOR boundedRepeats and over-consumes when forced)
    // must NOT get a stepper: no control can make the parent record exist, so the
    // child stepper would be permanently inert/misleading (it drives a value the
    // diagram never reads). Children of an instantiable parent (dnsResponse
    // dnsQNameLabels / dnsRdataSoa*) keep their working steppers.
    enclosingInstantiable: boolean,
    // True when descending through a transparent wrapper that flattenForMirror
    // does NOT erase and that psdlToRenderer's top-level loop never lifts to a
    // `tlv` field — currently an `optional` container. A TLV-shaped repeat
    // (single-switch element) sitting directly under such a wrapper falls
    // through every path: isTlvRepeat() disqualifies it from the freeRepeat /
    // peekSwitch collectors, and repeatToTlvField is never reached because it is
    // not a top-level body child. Threading this flag lets the !isTlvRepeat
    // guard relax for it exactly as `insideSwitch` does for a switch-case-nested
    // TLV repeat (icmpv6Ndp), surfacing the eos count stepper + peek/ref picker.
    insideOptional: boolean,
    // Human-readable label of the nearest enclosing switch CASE (or null at top
    // level / outside any case). When a repeat surfaced from inside a switch
    // case becomes a packet-level stepper, its own name is qualified with this
    // so several same-named repeats living in DIFFERENT cases of a top-level
    // message-type switch (icmpv6Ndp rsOptions/raOptions/… all `Options`; msdp
    // msdpSAEntries vs msdpRespSAEntries both `SA Entries`) render as distinctly
    // labelled steppers instead of N identical, partly-inert ones (the only live
    // one is the currently-selected variant's). override-design-audit.
    caseLabel: string | null,
  ): void => {
    for (const c of containers) {
      if (isField(c)) continue;
      if (c.kind === "bounded") {
        // Track the bounded's length field when its `bytes` is a single ref
        // (the case we can derive a count from). A complex/multi-ref budget
        // expr yields null — those repeats stay non-auto-derived. Also record
        // the scope's fixed sibling bytes (everything except the repeat, which
        // estimateElementBytes counts as 0) so the derived count subtracts them.
        const refs = new Set<string>();
        refsIn(c.bytes, refs);
        const key = refs.size === 1 ? [...refs][0] : null;
        const prefix = key ? estimateElementBytes({ fields: c.fields }) : 0;
        visit(
          c.fields,
          key ? { key, prefix, bytes: c.bytes } : null,
          insideRepeat,
          insideSwitch,
          enclosingInstantiable,
          insideOptional,
          caseLabel,
        );
        continue;
      }
      if (c.kind === "align" || c.kind === "virtual") {
        // align/virtual carry no override surface.
        continue;
      }
      if (c.kind === "ref") {
        // Resolve the referenced def inline (like flattenForMirror) so a
        // repeat/switch living inside a ref-resolved NamedStruct still gets its
        // count stepper / variant pickers surfaced. The ref is a transparent wire
        // scope — not a bounded budget and not a repeat iteration — so the
        // enclosing bounded / insideRepeat / insideSwitch context is threaded
        // through unchanged. Without this an arbitrary user PSDL whose def
        // contains a repeat-of-switch renders records but exposes ZERO override
        // surface (see-but-cannot-edit).
        const def = defs?.[c.ref];
        if (def)
          visit(
            def.fields,
            bounded,
            insideRepeat,
            insideSwitch,
            enclosingInstantiable,
            insideOptional,
            caseLabel,
          );
        continue;
      }
      if (c.kind === "repeat") {
        // A TLV-shaped repeat (element = single Switch) is normally lifted to a
        // top-level `tlv` field with its own list editor — but only when it sits
        // in a top-level container. When it lives INSIDE a switch case (icmpv6Ndp
        // rsOptions/raOptions/… = repeat{count:eos, element:[switch on peek]}),
        // `repeatToTlvField` is never reached, so it gets ZERO override surface
        // (see-but-cannot-edit). Relax the !isTlvRepeat guard for a switch-nested,
        // non-insideRepeat TLV repeat so its eos count stepper IS surfaced (the
        // matching peek type-picker comes from collectPeekSwitches). It is NOT
        // promoted to a tlv field — the count stepper keyed on env[repeat.id] plus
        // the peek picker are the controls.
        //
        // The SAME see-but-cannot-edit gap exists for a TLV-shaped repeat
        // wrapped directly in an `optional` container (`optional(flag){ repeat
        // eos { switch on peek } }`): flattenForMirror does not erase the
        // optional and it is not a switch case, so repeatToTlvField never sees
        // it and it lands here with isTlvRepeat()===true. Relax the guard for it
        // too (insideOptional) so its eos count stepper + peek/ref picker are
        // surfaced, exactly as for the switch-nested case.
        const surfacedNestedTlv =
          isTlvRepeat(c) && (insideSwitch || insideOptional) && !insideRepeat;
        if (!isLikelyChainRepeat(c) && (!isTlvRepeat(c) || surfacedNestedTlv)) {
          let countKey: string | null = null;
          let label = c.name ?? c.id;
          let defaultCount: number | undefined;
          let transform: { mul: number; add: number } | undefined;
          if (
            c.count === "eos" ||
            (typeof c.count === "object" && "until" in c.count)
          ) {
            const tlvExt =
              bounded && containsBounded(c.element.fields)
                ? tlvExtensionInnerSeeds(c.element)
                : null;
            if (bounded && !containsBounded(c.element.fields)) {
              // Bounded eos/until: derive the count from the budget so raising
              // the length slider fills the scope. No stepper (would
              // over-consume). The simple case — the record carries no nested
              // bounded — is handled here; the TLV-extension case (record wraps
              // its own per-record bounded) is handled just below.
              boundedOut.push({
                countKey: c.id,
                lengthKey: bounded.key,
                bytesExpr: bounded.bytes,
                perRecordBytes: estimateElementBytes(c.element),
                prefixBytes: bounded.prefix,
              });
              instantiableRepeatIds.add(c.id);
            } else if (bounded && tlvExt) {
              // TLV-EXTENSION record (tlsClientHello extensions): each record
              // wraps a PER-RECORD nested `bounded` sized by a sibling length
              // field defaulting to 0. The plain derive above would over-consume
              // that empty inner scope the instant a record appears. So derive
              // the outer count from the budget AND seed each inner length so the
              // representative arm fits — `perRecordBytes` (which charges the
              // record INCLUDING its largest inner arm) keeps the outer count
              // conservative, and `innerScopeSeeds` makes the default record
              // render complete. The matching extType variant picker is surfaced
              // by collectRefSwitches once this repeat is instantiable. Excludes
              // bgpPathAttributes (cond budget → tlvExtensionInnerSeeds null) and
              // ocspRequest (plain group inner scope → null), preserving their
              // existing suppression.
              // Seed the OUTER budget so ONE representative record renders at
              // load — otherwise extensionsLen 0-fills, `floor(0/perRecord)=0`
              // records appear, and the surfaced extType variant picker is INERT
              // (driving it leaves the diagram byte-identical) while still
              // showing cases[0] against an empty diagram (#11/#12). Only when
              // the budget is a plain `ref(lengthKey)` does seeding the field
              // equal seeding the budget; then `perRecordBytes + prefixBytes`
              // yields `floor((budget-prefix)/perRecord)=1`. A `field*k-c` budget
              // can't be seeded this way, so it is left unseeded (no regression).
              const budgetIsPlainRef =
                bounded.bytes.kind === "ref" &&
                bounded.bytes.field === bounded.key;
              boundedOut.push({
                countKey: c.id,
                lengthKey: bounded.key,
                bytesExpr: bounded.bytes,
                perRecordBytes: tlvExt.perRecordBytes,
                prefixBytes: bounded.prefix,
                ...(tlvExt.innerSeeds.length > 0
                  ? { innerScopeSeeds: tlvExt.innerSeeds }
                  : {}),
                ...(budgetIsPlainRef
                  ? { defaultLength: tlvExt.perRecordBytes + bounded.prefix }
                  : {}),
              });
              instantiableRepeatIds.add(c.id);
            } else if (!bounded && (!insideRepeat || enclosingInstantiable)) {
              // Free eos/until: a real count env key the user steps directly.
              // Suppressed when nested inside a NON-instantiable parent repeat
              // (bgpUpdateFull's bgpAsPathSegments / bgpCommunities live in
              // bgpPathAttributes, which is in NEITHER freeRepeats NOR
              // boundedRepeats): no surfaced control can make the parent record
              // exist, so a child stepper would be permanently inert — driving it
              // over {0,1,2,3} leaves the diagram byte-identical. A free child of
              // an instantiable parent (dnsResponse dnsQNameLabels) is kept.
              countKey = c.id;
              label = `${label} (${c.count === "eos" ? "eos" : "until"})`;
              defaultCount = 1;
            }
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
            const ref = c.count.field;
            const covered = fields.find(
              (f) =>
                f.id === ref &&
                (f.controlsLength || f.switchCases || f.enumVariants),
            );
            // A count ref to a `virtual` field is recomputed by normalize every
            // render (walkVirtual `env.set(id, eval(expr))`), clobbering any
            // stepper write — kerberosAsReq `padataList count={ref:padataCount}`
            // with padataCount=virtual lit 1 always renders exactly 1 record.
            // Surface no stepper (the only fix that keeps the count editable
            // would be replacing the virtual with a real field in the PSDL).
            if (!covered && !virtualIds.has(ref)) {
              countKey = ref;
              // Seed ONE record when the repeat is record-bearing — its element
              // encloses a variant Switch (the surfaced refSwitch/peekSwitch
              // picker) or a nested Repeat. Without this the count falls back to
              // the 0-seed, so at load (and after every preset switch) there are
              // ZERO records and a "Record variants" picker is INERT: choosing
              // any variant changes nothing because no record exists to take it
              // (#11/#12 — dnsResponse dnsAnswers/dnsRrType, dnsQuestions,
              // lispMapReply lispReplyRecords). One representative record is a
              // ref-count (NOT a budget) repeat, so seeding 1 never over-consumes
              // a byte budget. Plain scalar-list ref-count repeats stay at 0.
              if (repeatIsRecordBearing(c)) defaultCount = 1;
            }
          } else if (
            typeof c.count === "object" &&
            (c.count.kind === "op" || c.count.kind === "cond") &&
            !insideRepeat
          ) {
            // op/cond count whose expression tree mentions EXACTLY ONE field
            // ref (e.g. SRv6 / ipv6Routing `srhSegmentList count={srhLastEntry
            // + 1}`, LISP `lispItrRlocs count={lispItrCount + 1}`). The diagram
            // renders `eval(count)` segments but the driving field (srhLastEntry
            // / lispItrCount) is a plain int with NO override widget — a
            // see-but-cannot-edit gap (override-audit A5, now fixed). These are
            // top-level (not bounded, not inside a repeat), so a single global
            // stepper on that ref is a correct, non-inert control: writing the
            // ref changes the rendered record count. The earlier NOTE here
            // wrongly claimed they were gated by a separate length field
            // (hdrExtLen) — they are not; the repeat's count is the ref alone.
            const refs = exprRefs(c.count);
            const ref = refs.length === 1 ? refs[0] : null;
            if (ref) {
              const covered = fields.find(
                (f) =>
                  f.id === ref &&
                  (f.controlsLength || f.switchCases || f.enumVariants),
              );
              // Derive the affine map `recordCount = ref * mul + add` for the
              // common single-op +k / -k / *k forms so the stepper DISPLAYS the
              // real segment count and WRITES the inverted ref value. A form we
              // can't invert (cond, %, nested op, …) still surfaces the ref
              // directly (identity transform = undefined) so the user keeps a
              // working control — just labelled by the driving field.
              // A `virtual` driving field is recomputed by normalize each render
              // and cannot be driven (see the ref-count branch above), so no
              // stepper is surfaced for it.
              if (!covered && !virtualIds.has(ref)) {
                countKey = ref;
                const affine = affineCountTransform(c.count, ref);
                if (affine) transform = affine;
              }
            }
          }
          if (countKey) {
            // Qualify a switch-case-nested repeat's label with its enclosing
            // case so steppers for repeats living in DIFFERENT cases of a
            // top-level message-type switch don't collide (icmpv6Ndp's five
            // `Options`, msdp's two `SA Entries`). Only the active variant's
            // stepper drives the diagram; the qualified label tells the user
            // which case each one belongs to (override-design-audit).
            const qualifiedName = caseLabel ? `${caseLabel} → ${label}` : label;
            out.push({
              name: qualifiedName,
              countKey,
              ...(defaultCount !== undefined ? { defaultCount } : {}),
              ...(transform !== undefined ? { transform } : {}),
            });
            instantiableRepeatIds.add(c.id);
          }
        }
        // A repeat element is its own scope: the bounded budget does not pass
        // into nested repeats' own counts (they get their own keys). A repeat
        // element is not a switch case, so insideSwitch resets to false. The new
        // `enclosingInstantiable` is whether THIS repeat got a surfaced count
        // control above (added to instantiableRepeatIds by the freeRepeat /
        // boundedRepeat branches) — children gate their free eos/until steppers
        // on it.
        visit(
          c.element.fields,
          null,
          true,
          false,
          instantiableRepeatIds.has(c.id),
          // A repeat element is its own scope: the enclosing optional wrapper no
          // longer applies once we descend into the iterated records.
          false,
          caseLabel,
        );
        continue;
      }
      if (c.kind === "group") {
        visit(
          c.children,
          bounded,
          insideRepeat,
          insideSwitch,
          enclosingInstantiable,
          insideOptional,
          caseLabel,
        );
        continue;
      }
      if (c.kind === "switch") {
        for (const [key, struct] of Object.entries(c.cases))
          visit(
            struct.fields,
            bounded,
            insideRepeat,
            true,
            enclosingInstantiable,
            // A switch case is a flattened scope, not the optional wrapper.
            false,
            // Descend with this case's readable label so any repeat surfaced
            // directly inside it gets a case-qualified stepper name. Falls back
            // to the existing (outer) caseLabel for the `_` default arm.
            switchCaseLabel(c.on, key, enumVariants, fieldNames) ?? caseLabel,
          );
        continue;
      }
      if (c.kind === "optional") {
        // Mark the descent so a TLV-shaped repeat directly inside this optional
        // gets its count/variant controls surfaced (see the guard above).
        visit(
          [c.container],
          bounded,
          insideRepeat,
          insideSwitch,
          enclosingInstantiable,
          true,
          caseLabel,
        );
        continue;
      }
      if (c.kind === "encrypted") {
        visit(
          c.plaintext.fields,
          bounded,
          insideRepeat,
          insideSwitch,
          enclosingInstantiable,
          insideOptional,
          caseLabel,
        );
        continue;
      }
    }
  };
  visit(body, null, false, false, true, false, null);
  return {
    freeRepeats: out,
    boundedRepeats: boundedOut,
    instantiableRepeatIds,
  };
}

// A variable-length leaf (bytes with a dynamic `n`, varint, berLength) has no
// static width. estimateElementBytes counts it as this many bytes so the
// per-record estimate OVER-counts rather than under-counts: the derived count
// `floor((budget - prefix) / perRecordBytes)` then stays conservative and never
// over-consumes the scope (records under-fill at worst, which is harmless).
const VARIABLE_FIELD_BYTE_ALLOWANCE = 64;

// A "TLV-style" record (isisLsp tlvs, bgpUpdate path-attrs, l2tp/cops/ipfix/
// ikev2/stun…) carries a variable `bytes` VALUE whose length `n` is a `ref` to a
// sibling LENGTH field WITHIN the same record (e.g. `bytes(ref tlvLength)`). The
// smallest legal record sets that length to 0, so the value is effectively
// empty. Charging the full 64-byte unbounded allowance there inflates
// perRecordBytes to ~66-97B, so the length slider must climb dozens of bytes
// before a SINGLE record appears and records then grow in ~66-byte plateaus
// (real TLVs are 2-30B). Instead charge a small structural size (~1 byte) for a
// ref-to-sibling value so perRecordBytes reflects the smallest legal record; the
// derived count `floor((budget - prefix) / perRecordBytes)` then tracks the
// budget faithfully and still never over-consumes (records under-fill at worst).
// The full allowance is KEPT for truly-unbounded variable fields (varint /
// berLength / delimited bytes / ref to a NON-sibling) to preserve the
// bounded-repeat over-consume safety invariant. (override-audit #5/#7/#8)
const REF_SIZED_FIELD_BYTE_ALLOWANCE = 1;

/** Collect every field id declared anywhere inside a record (recursing through
 *  groups / bounded / optional / switch cases / nested repeats). These are the
 *  ids a value's length may reference as a "sibling" of the same record. */
function collectRecordFieldIds(
  containers: Container[],
  acc: Set<string>,
): void {
  for (const c of containers) {
    if (isField(c)) {
      acc.add(c.id);
    } else if (c.kind === "group") {
      collectRecordFieldIds(c.children, acc);
    } else if (c.kind === "bounded") {
      collectRecordFieldIds(c.fields, acc);
    } else if (c.kind === "optional") {
      collectRecordFieldIds([c.container], acc);
    } else if (c.kind === "repeat") {
      collectRecordFieldIds(c.element.fields, acc);
    } else if (c.kind === "encrypted") {
      collectRecordFieldIds(c.plaintext.fields, acc);
    } else if (c.kind === "switch") {
      for (const s of Object.values(c.cases))
        collectRecordFieldIds(s.fields, acc);
    }
  }
}

/** True if `field` is a variable-length `bytes` whose length `n` is an Expr that
 *  references ONLY ids in `siblingIds` — a length carried by a sibling field of
 *  the same record. Such a value collapses to ~0 bytes in the smallest legal
 *  record. Delimited bytes (no Expr `n`) and refs to a NON-sibling stay
 *  truly-unbounded and keep the full allowance. */
function isRefToSiblingBytes(
  field: Container,
  siblingIds: Set<string>,
): boolean {
  if (!isField(field) || field.type.kind !== "bytes") return false;
  const n = field.type.n;
  if (isBytesDelimited(n)) return false;
  const refs = exprRefs(n);
  return refs.length > 0 && refs.every((r) => siblingIds.has(r));
}

/** True if any container in the tree is (or wraps) a `bounded` scope. Used to
 *  detect records with a PER-RECORD nested bounded budget, which a single global
 *  count derive can't satisfy. */
function containsBounded(containers: Container[]): boolean {
  for (const c of containers) {
    if (isField(c)) continue;
    if (c.kind === "bounded") return true;
    if (c.kind === "group" && containsBounded(c.children)) return true;
    if (c.kind === "optional" && containsBounded([c.container])) return true;
    if (c.kind === "repeat" && containsBounded(c.element.fields)) return true;
    if (c.kind === "encrypted" && containsBounded(c.plaintext.fields))
      return true;
    if (c.kind === "switch") {
      for (const s of Object.values(c.cases)) {
        if (containsBounded(s.fields)) return true;
      }
    }
  }
  return false;
}

/**
 * Detect a TLV-EXTENSION-style record: a repeat element shaped like
 * `[typeField, lengthField, …, bounded innerScope(ref lengthField){ switch … }]`
 * — tlsClientHello's extensions, where each record is
 * `[extType, extLen, bounded extData(ref extLen){ switch on extType }]`.
 *
 * Such a record wraps a PER-RECORD nested `bounded` sized by a sibling LENGTH
 * field that defaults to 0. The plain bounded-count derive (which only sets the
 * outer count) would then over-consume the empty inner scope the instant a
 * record appears, because the representative arm (the first numeric case — the
 * one the refSwitch picker seeds) carries fixed fields. So the derive needs to
 * ALSO seed each inner length so the default record fits, and size the record by
 * the REPRESENTATIVE arm (not the worst-case `_`/opaque `remaining` arm, which
 * would inflate the per-record estimate to ~64 B and hide records behind a huge
 * length plateau).
 *
 * Returns, when every direct-child nested bounded has a `ref(K)`-to-sibling
 * budget AND holds a Switch (the variant idiom):
 *   - `innerSeeds`: `{ key: K, value: <representative-arm bytes> }` per inner
 *     scope — the inner length seeded so cases[0] fits,
 *   - `perRecordBytes`: the record's byte size with each inner scope charged its
 *     seeded (representative-arm) budget — keeps the outer count conservative.
 * Returns `null` when no such nested bounded exists, when ANY nested bounded is
 * NOT a single-ref-to-sibling budget (bgpPathAttributes' `cond` budget), or when
 * an inner scope has no Switch (ocspRequest's plain `group` scope, whose
 * exact-fill berLength can't be safely force-seeded) — those stay
 * non-auto-derived, preserving the existing suppression.
 */
function tlvExtensionInnerSeeds(element: { fields: Container[] }): {
  innerSeeds: { key: string; value: number }[];
  perRecordBytes: number;
} | null {
  const siblingIds = new Set<string>();
  collectRecordFieldIds(element.fields, siblingIds);
  const innerSeeds: { key: string; value: number }[] = [];
  // Bytes of the record EXCLUDING the inner bounded scopes (the type/length
  // prefix), accumulated as we walk; each qualifying inner scope adds its
  // seeded representative-arm bytes.
  let prefixBits = 0;
  let perRecordBytes = 0;
  let sawNestedBounded = false;
  for (const c of element.fields) {
    if (isField(c)) {
      const w = typeBits(c.type);
      prefixBits +=
        w > 0
          ? w
          : isRefToSiblingBytes(c, siblingIds)
            ? REF_SIZED_FIELD_BYTE_ALLOWANCE * 8
            : VARIABLE_FIELD_BYTE_ALLOWANCE * 8;
      continue;
    }
    if (c.kind !== "bounded") {
      // A non-bounded container at the element's top level may still hide a
      // nested bounded deeper (e.g. inside a group/switch). That shape is not
      // the simple TLV-extension idiom we can safely seed — bail. A plain
      // (bounded-free) container just contributes its estimate to the prefix.
      if (containsBounded([c])) return null;
      prefixBits += estimateElementBytes({ fields: [c] }) * 8;
      continue;
    }
    sawNestedBounded = true;
    // Budget must be a single ref to a sibling LENGTH field of this record.
    const refs = exprRefs(c.bytes);
    if (refs.length !== 1 || !siblingIds.has(refs[0])) return null;
    // The inner scope must carry a Switch (the variant idiom). A plain
    // group/leaf inner scope (ocspRequest) is excluded — its exact-fill
    // length can't be force-seeded without tripping a `remaining` mismatch.
    const sw = c.fields.find(
      (f): f is Extract<Container, { kind: "switch" }> =>
        !isField(f) && f.kind === "switch",
    );
    if (!sw) return null;
    // A nested bounded inside the inner scope can't be safely seeded either.
    if (c.fields.some((f) => !isField(f) && containsBounded([f]))) return null;
    // Size the inner scope by the REPRESENTATIVE arm: the first numeric case
    // (cases[0]) the refSwitch picker seeds. Other (non-switch) siblings in the
    // inner scope add their own bytes. This avoids the `_`/opaque `remaining`
    // arm's 64-byte allowance dominating the estimate.
    const firstNumericKey = Object.keys(sw.cases).find(
      (k) => firstCaseKeyValue(k) !== null,
    );
    const repArm = firstNumericKey ? sw.cases[firstNumericKey] : undefined;
    let innerBytes = 0;
    for (const f of c.fields) {
      if (f === sw) {
        // Size the switch by the representative arm. Its value-length refs
        // (SNI's `host_name = bytes(ref nameLen)`) point at siblings inside the
        // same arm, so estimateElementBytes charges them the small structural
        // size rather than the full unbounded allowance.
        innerBytes += repArm
          ? estimateElementBytes({ fields: repArm.fields })
          : 0;
      } else {
        innerBytes += estimateElementBytes({ fields: [f] });
      }
    }
    innerBytes = Math.max(1, innerBytes);
    innerSeeds.push({ key: refs[0], value: innerBytes });
    perRecordBytes += innerBytes;
  }
  if (!sawNestedBounded) return null;
  perRecordBytes += Math.ceil(prefixBits / 8);
  return { innerSeeds, perRecordBytes: Math.max(1, perRecordBytes) };
}

/** Conservative (over-)estimate of a repeat element's byte size. Sums
 *  fixed-width leaf fields, a generous allowance for variable-length ones, and
 *  for a Switch takes the LARGEST case. Floors at 1 byte. */
function estimateElementBytes(struct: { fields: Container[] }): number {
  // Ids of every field in this record, so a value sized by a sibling length
  // (`bytes(ref tlvLength)`) gets a small structural charge instead of the full
  // unbounded allowance — see REF_SIZED_FIELD_BYTE_ALLOWANCE.
  const siblingIds = new Set<string>();
  collectRecordFieldIds(struct.fields, siblingIds);
  const bitsOf = (cs: Container[]): number => {
    let total = 0;
    for (const c of cs) {
      if (isField(c)) {
        const w = typeBits(c.type);
        // typeBits returns 0 for variable-length types (dynamic bytes / varint /
        // berLength); charge the generous allowance for those — except a
        // ref-to-sibling-length `bytes` value, which is empty in the smallest
        // legal record and gets only a small structural size.
        if (w > 0) {
          total += w;
        } else if (isRefToSiblingBytes(c, siblingIds)) {
          total += REF_SIZED_FIELD_BYTE_ALLOWANCE * 8;
        } else {
          total += VARIABLE_FIELD_BYTE_ALLOWANCE * 8;
        }
      } else if (c.kind === "group") {
        total += bitsOf(c.children);
      } else if (c.kind === "bounded") {
        total += bitsOf(c.fields);
      } else if (c.kind === "optional") {
        total += bitsOf([c.container]);
      } else if (c.kind === "switch") {
        let maxCase = 0;
        for (const s of Object.values(c.cases)) {
          maxCase = Math.max(maxCase, bitsOf(s.fields));
        }
        total += maxCase;
      }
      // repeat / encrypted / align / virtual contribute 0 to the estimate.
    }
    return total;
  };
  return Math.max(1, Math.ceil(bitsOf(struct.fields) / 8));
}

/**
 * Recognise an `Optional.when` of the form `peek(bits, offset) == lit(value)`
 * (or the symmetric `lit == peek`) where the peek offset is a compile-time
 * literal (or implicitly 0). Such an Optional is a *peek-gated region*: the
 * enclosing container only renders when the next `bits` bits on the wire
 * equal `value`. The gate reads env key `__peek__<offset>__<bits>`, so the
 * region is reachable only if the user can set that key. Returns the env key
 * and the matching value, or `null` for any other `when` shape (`ref`-based
 * gates already surface via `optionalGateFor`; non-literal offsets can't be
 * keyed deterministically — see the Switch path's Codex P2 note).
 */
function matchPeekGate(when: Expr): { peekKey: string; value: number } | null {
  if (when.kind !== "op" || when.op !== "==") return null;
  const sides: [Expr, Expr][] = [
    [when.a, when.b],
    [when.b, when.a],
  ];
  for (const [peek, lit] of sides) {
    if (peek.kind !== "peek" || lit.kind !== "lit") continue;
    const offset = peek.offset;
    // Non-literal offsets evaluate at layout time to a value we don't know
    // here, so the key we'd publish wouldn't match what normalize reads.
    if (offset && offset.kind !== "lit") return null;
    const offsetValue = offset?.kind === "lit" ? offset.value : 0;
    return { peekKey: peekEnvKey(offsetValue, peek.bits), value: lit.value };
  }
  return null;
}

/**
 * Display name for an Optional's inner container — its `name`, else `id`,
 * else the structural kind. Used to label a peek-gate case so the picker
 * reads "224 — Padding" rather than a bare value.
 */
function optionalInnerName(inner: Container): string {
  return (
    ("name" in inner ? inner.name : undefined) ??
    ("id" in inner ? inner.id : undefined) ??
    inner.kind ??
    "region"
  );
}

/**
 * Find Switches whose `on` is a `peek` expression (TLS extension type
 * dispatch etc). The peek synthesizes an env key
 * `__peek__<offset>__<bits>` per the PSDL spec. We expose this so
 * OverridePanel can render a synthetic case picker — there's no real cell
 * to attach to since `peek` doesn't consume bytes.
 *
 * The same surface also covers `Optional`s gated by a peek (`when:
 * peek(bits) == lit`): the region is hidden at the default env (peek
 * defaults to 0), and because the gate's `when` is a peek — not a `ref` —
 * `attachOverrideMetadata` produces no `optionalGateFor`. Without surfacing
 * the gating peek key the region (and any repeat-count stepper inside it,
 * e.g. ROHC's `rohcPadding` / `rohcFeedback` until-repeats) is permanently
 * unreachable: a see-but-cannot-edit dead end. We publish one synthetic
 * picker per distinct peek key, with a case per gate value plus an "(absent)"
 * case so the region can be toggled back off.
 */
function collectPeekSwitches(
  body: PsdlPacket["body"],
  defs: Record<string, NamedStruct> | undefined,
): NonNullable<RendererPacket["peekSwitches"]> {
  const out: NonNullable<RendererPacket["peekSwitches"]> = [];
  // Peek keys already surfaced by a real Switch dispatch — don't shadow them
  // with a gate picker for the same key.
  const switchPeekKeys = new Set<string>();
  // Optional peek-gates grouped by their env key. Several gates can share one
  // key (e.g. Teredo's two indicators both peek 16 bits at offset 0); they
  // collapse into a single picker whose cases are mutually exclusive.
  const gates = new Map<
    string,
    { id: string; name: string; cases: { value: number; label: string }[] }
  >();
  const visit = (
    containers: PsdlPacket["body"],
    insideSwitch: boolean,
    insideRepeat: boolean,
    // Mirrors collectFreeRepeats: true when descending an `optional` wrapper, so
    // a TLV-shaped repeat directly inside it surfaces its peek picker (the eos
    // count stepper comes from collectFreeRepeats).
    insideOptional: boolean,
  ): void => {
    for (const c of flattenForMirror(containers, defs)) {
      if (c.kind === "switch") {
        if (c.on.kind === "peek") {
          const cases: { value: number; label: string }[] = [];
          for (const [key, struct] of Object.entries(c.cases)) {
            const v = firstCaseKeyValue(key);
            if (v === null) continue;
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
              const peekKey = peekEnvKey(offsetValue, peek.bits);
              switchPeekKeys.add(peekKey);
              out.push({
                id: c.id,
                name: c.name ?? c.id,
                cases,
                peekKey,
              });
            }
          }
        }
        for (const struct of Object.values(c.cases))
          visit(struct.fields, true, insideRepeat, false);
        continue;
      }
      if (c.kind === "group") {
        visit(c.children, insideSwitch, insideRepeat, insideOptional);
        continue;
      }
      if (c.kind === "repeat") {
        // A peek Switch that IS a top-level TLV/chain repeat's own dispatch is
        // already handled by the (more capable) TLV/chain editor; surfacing a
        // duplicate peek picker is redundant AND goes inert once
        // applyTlvInstances materialises the records (the peek key is no longer
        // read). So don't collect peek switches from inside such a repeat.
        //
        // EXCEPTION: a switch-nested, non-insideRepeat TLV repeat (icmpv6Ndp
        // rsOptions/raOptions/…) is NOT lifted to a tlv field, so its peek
        // type-picker is the ONLY surface for choosing the option type — descend
        // into it (paired with the eos count stepper from collectFreeRepeats).
        // The optional-wrapped TLV repeat (`optional(flag){ repeat eos { switch
        // on peek } }`) is the same gap reached via `insideOptional`.
        const surfacedNestedTlv =
          isTlvRepeat(c) && (insideSwitch || insideOptional) && !insideRepeat;
        if ((!isTlvRepeat(c) && !isLikelyChainRepeat(c)) || surfacedNestedTlv)
          visit(c.element.fields, false, true, false);
        continue;
      }
      if (c.kind === "optional") {
        const gate = matchPeekGate(c.when);
        if (gate) {
          const label = optionalInnerName(c.container);
          const entry = gates.get(gate.peekKey);
          if (entry) {
            if (!entry.cases.some((k) => k.value === gate.value)) {
              entry.cases.push({ value: gate.value, label });
            }
          } else {
            gates.set(gate.peekKey, {
              // No real cell backs a peek gate; key the synthetic picker by
              // its env key so its React key / select id stay stable.
              id: gate.peekKey,
              name: label,
              cases: [{ value: gate.value, label }],
            });
          }
        }
        visit([c.container], insideSwitch, insideRepeat, true);
        continue;
      }
      if (c.kind === "encrypted") {
        visit(c.plaintext.fields, insideSwitch, insideRepeat, insideOptional);
        continue;
      }
    }
  };
  visit(body, false, false, false);
  // Surface each peek-gated Optional key as a synthetic picker, unless a real
  // Switch already dispatches on that exact key. Each picker gets an
  // "(absent)" case — a value distinct from every gate value at the key — so
  // the gated region can be hidden again after being revealed.
  for (const [peekKey, g] of gates) {
    if (switchPeekKeys.has(peekKey)) continue;
    const used = new Set(g.cases.map((k) => k.value));
    let absent = 0;
    while (used.has(absent)) absent += 1;
    out.push({
      id: g.id,
      name: g.cases.length > 1 ? `${g.name} (region)` : g.name,
      cases: [...g.cases, { value: absent, label: "(absent)" }],
      peekKey,
    });
  }
  return dedupePeekSwitches(out);
}

/**
 * Multiple peek Switches can publish the SAME `peekKey` — e.g. icmpv6Ndp's five
 * per-message-type option lists (rsByOptType / raByOptType / … ) are each a
 * `switch on peek(bits:8)` at offset 0, so every one keys on `__peek__0__8`.
 * Only the switch inside the message variant the discriminator currently
 * selects ever renders, so surfacing five separate pickers that all read/write
 * one shared controller is misleading: four are inert at any moment and moving
 * any one silently retargets whichever variant is live. Collapse aliasing
 * pickers into a SINGLE picker per `peekKey`, unioning their cases (deduped by
 * value, first label wins) so the lone control governs whichever variant the
 * diagram shows.
 */
function dedupePeekSwitches(
  raw: NonNullable<RendererPacket["peekSwitches"]>,
): NonNullable<RendererPacket["peekSwitches"]> {
  const byKey = new Map<string, NonNullable<RendererPacket["peekSwitches"]>>();
  for (const ps of raw) {
    const group = byKey.get(ps.peekKey);
    if (group) group.push(ps);
    else byKey.set(ps.peekKey, [ps]);
  }
  const out: NonNullable<RendererPacket["peekSwitches"]> = [];
  for (const group of byKey.values()) {
    const first = group[0]!;
    if (group.length === 1) {
      out.push(first);
      continue;
    }
    const cases: { value: number; label: string }[] = [];
    const seen = new Set<number>();
    for (const ps of group) {
      for (const c of ps.cases) {
        if (seen.has(c.value)) continue;
        seen.add(c.value);
        cases.push(c);
      }
    }
    // Keep the first switch's id (stable, used as the React key); derive a name
    // that reads as a shared discriminator. The longest common suffix of the
    // merged names (e.g. `…ByOptType`) describes what every alias dispatches on
    // far better than an arbitrary per-message id like `rsByOptType`.
    const sharedName = longestCommonSuffix(group.map((g) => g.name));
    out.push({
      id: first.id,
      name: sharedName.length >= 3 ? sharedName : first.name,
      cases,
      peekKey: first.peekKey,
    });
  }
  return out;
}

/** Longest suffix shared by every string (empty when none / list shorter than 2). */
function longestCommonSuffix(names: readonly string[]): string {
  if (names.length < 2) return names[0] ?? "";
  let suffix = names[0]!;
  for (let i = 1; i < names.length; i++) {
    const s = names[i]!;
    let len = 0;
    while (
      len < suffix.length &&
      len < s.length &&
      suffix[suffix.length - 1 - len] === s[s.length - 1 - len]
    ) {
      len++;
    }
    suffix = suffix.slice(suffix.length - len);
    if (suffix.length === 0) break;
  }
  return suffix;
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
  defs: Record<string, NamedStruct> | undefined,
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
    for (const c of flattenForMirror(containers, defs)) {
      if (c.kind === "switch") {
        const cases: { value: number; label: string }[] = [];
        for (const [key, struct] of Object.entries(c.cases)) {
          const v = firstCaseKeyValue(key);
          if (v !== null) {
            cases.push({ value: v, label: struct.name ?? `case ${key}` });
          }
          // Recurse into each variant's fields.
          visit(struct.fields);
        }
        if (cases.length === 0) continue;
        // Suppress a multi-option case picker whose every selectable arm is
        // structurally identical: choosing any value yields a byte-identical
        // layout, so the dropdown can never change the diagram (an inert
        // see-but-cannot-edit control). collectRefSwitches has its own
        // zero-width gate for repeat-nested discriminators; this covers the
        // top-level / plain-field discriminators it never reaches — e.g.
        // tlsHandshake's 10-arm `handshakeType` (each arm a single
        // `bytes(ref tlsHandshakeBodyLen)`) and eap's 2-arm `eapCode` (each
        // arm `enum(8)` + `bytes(eapLength - 5)`).
        if (switchArmsAllIdentical(c.cases)) continue;
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
