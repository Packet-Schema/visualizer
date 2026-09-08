// Extracted from `index.ts` (PSDL → renderer adapter) — no logic changes.

import { isField } from "../utils";
import { exprRefs } from "../expr";
import { isBytesDelimited } from "../normalize";
import type {
  Bounded,
  Constraint,
  Container,
  Expr,
  Field as PsdlField,
  NamedStruct,
  Packet as PsdlPacket,
} from "../types";
import type {
  Field as RendererField,
  Packet as RendererPacket,
} from "../renderer";
import { isLikelyChainRepeat } from "./chain";
import { isTlvRepeat } from "./tlv";
import { typeBits } from "./shared";
import { singleRefController } from "./psdl-queries";
import { flattenForMirror, flattenForMirrorGuarded } from "./mirror-flatten";
import { containsBounded } from "./repeats-and-budgets";
import type { PreMetadataField } from "./override-metadata";

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
export function constraintToController(constraint: Constraint): string | null {
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
 * Walk the PSDL body (descending only through *transparent wire scopes* —
 * `bounded` itself plus already-resolved containers via `flattenForMirror`)
 * and collect, for each `Bounded` whose `bytes` expression has exactly one
 * field ref, that controller field's id. In 0.5 the IPv4/TCP "options"
 * length relation (`IHL*4 == headerBytes`, `dataOffset*4 == headerBytes`)
 * no longer lives in top-level `constraints`; it moved onto the options
 * `bounded.bytes` (`ihl*4 - 20` / `dataOffset*4 - 20`). Surfacing those as
 * length controllers keeps IHL / Data Offset overridable sliders.
 */
export function collectBoundedControllers(
  containers: Container[],
  defs: Record<string, NamedStruct> | undefined,
  acc: Set<string>,
  seen: Set<string> = new Set(),
): void {
  for (const c of containers) {
    if (isField(c)) continue;
    if (c.kind === "bounded") {
      const controller = singleRefController(c.bytes);
      if (controller) acc.add(controller);
      collectBoundedControllers(c.fields, defs, acc, seen);
      continue;
    }
    if (c.kind === "ref") {
      if (seen.has(c.ref)) continue;
      const def = defs?.[c.ref];
      if (def) {
        seen.add(c.ref);
        collectBoundedControllers(def.fields, defs, acc, seen);
        seen.delete(c.ref);
      }
      continue;
    }
    if (c.kind === "group") {
      collectBoundedControllers(c.children, defs, acc, seen);
      continue;
    }
    if (c.kind === "optional") {
      collectBoundedControllers([c.container], defs, acc, seen);
      continue;
    }
    if (c.kind === "repeat") {
      collectBoundedControllers(c.element.fields, defs, acc, seen);
      continue;
    }
    if (c.kind === "switch") {
      for (const struct of Object.values(c.cases)) {
        collectBoundedControllers(struct.fields, defs, acc, seen);
      }
      continue;
    }
    if (c.kind === "encrypted") {
      collectBoundedControllers(c.plaintext.fields, defs, acc, seen);
      continue;
    }
  }
}

/**
 * Collect the single-ref controller ids of every top-level `bounded` scope
 * whose inner content (after `flattenForMirror`) is a TLV-shaped repeat that
 * the top-level loop lifts to a `tlv` field (ipv4 `options` ← `ihl*4-20`, tcp
 * `options` ← `dataOffset*4-20`, ipv6Destination `ipv6DstOptions` ← hdrExtLen,
 * tlsClientHelloFull `extensions` ← extensionsLen).
 *
 * That region is already owned by the TLV editor (add/remove records grows the
 * byte budget); stamping its length field ALSO as a `controlsLength` slider
 * gives the user a control that inflates the diagram's byte counter without
 * adding a single cell — the eos repeat renders through the TLV-instance
 * mechanism, not the budget. So those controllers must be excluded from the
 * length-controller pass below.
 */
function isTlvOwnedBounded(
  b: Bounded,
  defs: Record<string, NamedStruct> | undefined,
): boolean {
  return flattenForMirror(b.fields, defs).some(
    (child) =>
      !isField(child) &&
      child.kind === "repeat" &&
      !isLikelyChainRepeat(child) &&
      isTlvRepeat(child),
  );
}

export function collectTlvOwnedBoundedControllers(
  containers: Container[],
  defs: Record<string, NamedStruct> | undefined,
  acc: Set<string>,
  seen: Set<string> = new Set(),
): void {
  for (const c of containers) {
    if (isField(c)) continue;
    if (c.kind === "bounded") {
      const controller = singleRefController(c.bytes);
      if (controller && isTlvOwnedBounded(c, defs)) acc.add(controller);
      collectTlvOwnedBoundedControllers(c.fields, defs, acc, seen);
      continue;
    }
    if (c.kind === "ref") {
      if (seen.has(c.ref)) continue;
      const def = defs?.[c.ref];
      if (def) {
        seen.add(c.ref);
        collectTlvOwnedBoundedControllers(def.fields, defs, acc, seen);
        seen.delete(c.ref);
      }
      continue;
    }
    if (c.kind === "group") {
      collectTlvOwnedBoundedControllers(c.children, defs, acc, seen);
      continue;
    }
    if (c.kind === "optional") {
      collectTlvOwnedBoundedControllers([c.container], defs, acc, seen);
      continue;
    }
    if (c.kind === "repeat") {
      collectTlvOwnedBoundedControllers(c.element.fields, defs, acc, seen);
      continue;
    }
    if (c.kind === "switch") {
      for (const struct of Object.values(c.cases)) {
        collectTlvOwnedBoundedControllers(struct.fields, defs, acc, seen);
      }
      continue;
    }
    if (c.kind === "encrypted") {
      collectTlvOwnedBoundedControllers(c.plaintext.fields, defs, acc, seen);
      continue;
    }
  }
}

/**
 * Collect every field id that is consumed as the byte count of a `bytes(ref X)`
 * type anywhere in the body — i.e. X sizes a variable-length value. Walks
 * through every transparent / nesting container (group, repeat, optional,
 * switch cases, bounded, encrypted, resolved `ref`) so a length field buried
 * inside an Optional still registers.
 */
function collectBytesSizers(
  containers: Container[],
  defs: Record<string, NamedStruct> | undefined,
  acc: Set<string>,
  seen: Set<string> = new Set(),
): void {
  for (const c of containers) {
    if (isField(c)) {
      const t = c.type;
      if (t.kind === "bytes" && !isBytesDelimited(t.n) && t.n.kind === "ref") {
        acc.add(t.n.field);
      }
      continue;
    }
    switch (c.kind) {
      case "group":
        collectBytesSizers(c.children, defs, acc, seen);
        break;
      case "repeat":
        collectBytesSizers(c.element.fields, defs, acc, seen);
        break;
      case "optional":
        collectBytesSizers([c.container], defs, acc, seen);
        break;
      case "bounded":
        collectBytesSizers(c.fields, defs, acc, seen);
        break;
      case "encrypted":
        collectBytesSizers(c.plaintext.fields, defs, acc, seen);
        break;
      case "switch":
        for (const struct of Object.values(c.cases)) {
          collectBytesSizers(struct.fields, defs, acc, seen);
        }
        break;
      case "ref": {
        if (seen.has(c.ref)) break;
        const def = defs?.[c.ref];
        if (def) {
          seen.add(c.ref);
          collectBytesSizers(def.fields, defs, acc, seen);
          seen.delete(c.ref);
        }
        break;
      }
      default:
        break;
    }
  }
}

/**
 * Surface an Optional-wrapped length field as a packet-level length controller.
 *
 * Some presets gate AND size a trailing variable field with a single octet that
 * itself lives inside an `optional` (rtcpBye: `rtcpByeHasReason`, an 8-bit count
 * that both gates `rtcpByeReason` via `when: ref(rtcpByeHasReason)` and sizes it
 * via `bytes(ref rtcpByeHasReason)`). Because `flattenForMirror` does not descend
 * into Optional containers, that octet never becomes a top-level mirror cell, so
 * its diagram cell is see-but-cannot-edit. It is also not a `bounded.bytes`
 * controller, so `collectBoundedControllers` misses it.
 *
 * Detect it directly: an `optional` whose container is a single int field X that
 * (a) is not already a top-level mirror cell and (b) is referenced as a
 * `bytes(ref X)` width elsewhere. Surface X as a length controller keyed on
 * `env[X]` — raising the slider both reveals the gated value and sizes it, the
 * one intuitive control. Returns the new controllers (caller dedupes/appends).
 */
export function collectOptionalLengthGates(
  body: PsdlPacket["body"],
  fields: PreMetadataField[],
  defs: Record<string, NamedStruct> | undefined,
): RendererField[] {
  const sizers = new Set<string>();
  collectBytesSizers(body, defs, sizers);
  const out: RendererField[] = [];
  const seen = new Set<string>();
  // Path-guard against recursive `defs` refs (see flattenForMirrorGuarded).
  const refPath = new Set<string>();
  const walk = (containers: Container[]): void => {
    const { items, release } = flattenForMirrorGuarded(
      containers,
      defs,
      refPath,
    );
    for (const c of items) {
      if (isField(c)) continue;
      if (c.kind === "optional") {
        const inner = c.container;
        if (
          isField(inner) &&
          inner.type.kind === "int" &&
          sizers.has(inner.id) &&
          !fields.some((f) => f.id === inner.id) &&
          !seen.has(inner.id)
        ) {
          seen.add(inner.id);
          const bits = inner.type.bits;
          out.push({
            id: inner.id,
            name: inner.name,
            bits,
            controlsLength: inner.id,
            max: bits > 0 ? 2 ** bits - 1 : undefined,
            ...(inner.defaultValue != null
              ? { defaultValue: inner.defaultValue }
              : {}),
            ...(inner.doc ? { description: inner.doc } : {}),
          });
        }
        walk([c.container]);
        continue;
      }
      if (c.kind === "group") {
        walk(c.children);
        continue;
      }
      if (c.kind === "repeat") {
        walk(c.element.fields);
        continue;
      }
      if (c.kind === "switch") {
        for (const struct of Object.values(c.cases)) walk(struct.fields);
        continue;
      }
      if (c.kind === "encrypted") {
        walk(c.plaintext.fields);
        continue;
      }
    }
    release();
  };
  walk(body);
  return out;
}

/**
 * Collect, for each scope, the ids of `length`-category int/bits fields whose
 * value directly sizes a SIBLING `bytes(ref <thisId>)` payload (or a sibling
 * `bounded.bytes` scope whose sole ref is `<thisId>`). These are the simplest
 * possible length relations: a plain length cell immediately followed by a
 * variable region it measures, with NO top-level `constraint` and NO multi-ref
 * arithmetic. The constraint-driven path (`constraintToController`) and the
 * single-ref bounded path (`collectBoundedControllers`) both only stamp
 * `controlsLength` onto a field that is ALSO a top-level renderer cell (or a
 * Group subfield). When the length field lives inside a Switch case
 * (ancp `ancpAdjTotalLength`, oncRpc `credLength`/`verfLength`) it is neither,
 * so it — and the payload it sizes — would surface as a read-only display the
 * user can SEE growing/shrinking but cannot drive. Surfacing the length field
 * as a packet-level `lengthController` (keyed on `env[thisId]`) gives the user
 * the slider that the bounded-scope path gives IHL / Data Offset.
 *
 * Only the *direct siblings* of the length field are inspected: a length that
 * sizes a payload in a different scope is left to the bounded / constraint
 * paths (where the scope nesting already expresses the relation). The result
 * maps the length field id to its declaring PSDL field so the caller can build
 * a slider with the correct bit width / default.
 */
export function collectSiblingLengthControllers(
  containers: Container[],
  defs: Record<string, NamedStruct> | undefined,
  acc: Map<string, PsdlField>,
  // True once we are inside a Repeat whose per-record length is OWNED by a
  // dedicated list editor — a TLV repeat (TlvEditor) or a chain repeat
  // (ChainEditor). Inside such a record, surfacing a packet-level slider keyed
  // on a length field's env id would fight that editor (it sizes every
  // synthesized record at once / is overwritten by the per-instance value), so
  // those length fields stay off the sibling-length surface.
  //
  // A PLAIN repeat (dnsResponse's `dnsAnswers`, a ref-count freeRepeat) has NO
  // such per-record editor: its records are sized purely from `env`. A
  // `length`-category cell inside it that sizes a sibling `bytes(ref X)` (DNS's
  // `dnsRdLength` sizing the NS/CNAME/PTR/TXT RDATA arms) is therefore owned by
  // NOBODY — the cell renders but is otherwise see-but-cannot-edit, and the
  // refSwitch arms it sizes collapse to width 0. So we keep collecting inside a
  // plain repeat; only TLV/chain ownership suppresses it (#11/#12).
  ownedByRecordEditor = false,
  // True once ANY ancestor `bounded` byte-budget has been entered. A repeat
  // nested under a bounded scope is a budget-derived boundedRepeat whose
  // per-record length is implicitly OWNED by that budget: its count is
  // `floor((budget - prefix) / perRecordBytes)`, so a global slider that grows
  // every record's `bytes(ref len)` value would over-consume the saturated
  // scope (isisLsp `tlvLength` inside the `pduLength`-budgeted `tlvs`). Suppress
  // the sibling-length surface there — the length slider IS the bounded budget.
  insideBounded = false,
  // Out-param: maps each collected length-field id to the set of VALUE field ids
  // whose width it sizes (`bytes(ref <lenId>)`). OverridePanel uses this to gate
  // the length-controller slider on whether a value it actually drives is in the
  // CURRENT diagram — a Length octet that always renders (pimHelloOptLen's cell
  // is in every option arm) but only sizes a value in some switch arms (24/`_`)
  // would otherwise read as a live-but-inert slider in the fixed-width arms.
  sizesByLenId: Map<string, Set<string>> = new Map(),
  // Visited ref-def names on the current descent path; a self/mutually
  // recursive `defs` reference (DNS name-compression idiom, ASN.1 nesting)
  // would otherwise recurse forever (RangeError).
  seen: Set<string> = new Set(),
): void {
  if (!ownedByRecordEditor && !insideBounded) {
    // Within this sibling list, gather the ids referenced as a byte sizer by a
    // sibling `bytes(ref X)` value (directly, or one wrapped in a sibling
    // `switch` / `group` / `optional` — DNS's `dnsRdLength` sizes the NS/CNAME/
    // PTR/TXT RDATA which live INSIDE the sibling `dnsRdata` switch, and MX/SRV
    // via `dnsRdLength - k`) or a sibling single-ref `bounded.bytes`. We do NOT
    // descend into a nested `repeat`: its records are a separate length scope.
    const sizedBy = new Set<string>();
    const lengthFields = new Map<string, PsdlField>();
    // Reverse of `sizedBy`: length ref id → value field ids whose width it sizes
    // in THIS sibling scope. Recorded into the out-param so the live gate can ask
    // "is a value this length actually drives in the current diagram?".
    const valuesByRef = new Map<string, Set<string>>();
    // Length refs whose sized VALUE lives BEHIND a `switch` relative to the
    // length field's own sibling scope. pimHelloOptLen sizes addrListData INSIDE
    // a `switch on pimHelloOptType` arm, so its Length octet renders in every arm
    // but only some arms consume it → the slider must gate on the value, not the
    // octet. socks5's socksDomainLen sizes dstAddrDomain as a DIRECT sibling
    // (same arm), so it is NOT behind a switch and keeps the octet-render gate
    // (the value starts width-0 and the slider is what grows it).
    const valueBehindSwitch = new Set<string>();
    const noteRef = (
      ref: string,
      valueId: string,
      behindSwitch: boolean,
    ): void => {
      sizedBy.add(ref);
      let set = valuesByRef.get(ref);
      if (!set) valuesByRef.set(ref, (set = new Set()));
      set.add(valueId);
      if (behindSwitch) valueBehindSwitch.add(ref);
    };
    const gatherSizers = (cs: Container[], behindSwitch: boolean): void => {
      for (const c of cs) {
        if (isField(c)) {
          const t = c.type;
          if (t.kind === "bytes" && !isBytesDelimited(t.n)) {
            for (const r of exprRefs(t.n)) noteRef(r, c.id, behindSwitch);
          }
          continue;
        }
        if (c.kind === "bounded") {
          // A sibling bounded budget nominates its single length ref, but its
          // INNER fields are a deeper scope owned by the bounded-controller path
          // — do not descend (avoids surfacing budget-internal lengths twice).
          // EXCEPT a bounded scope whose inner repeat is TLV-shaped: that region
          // is already owned by the lifted `tlv` field's TlvEditor (add/remove
          // records drives the budget). Nominating its length ref here would
          // stamp a `controlsLength` slider (ipv4 `ihl`, tcp `dataOffset`,
          // ipv6Destination `hdrExtLen`, tlsClientHelloFull `extensionsLen`)
          // that inflates the byte counter while ZERO new cells appear — a
          // misleading control fighting the TLV editor. Skip it.
          if (!isTlvOwnedBounded(c, defs)) {
            const ref = singleRefController(c.bytes);
            if (ref) sizedBy.add(ref);
          }
        } else if (c.kind === "group") {
          gatherSizers(c.children, behindSwitch);
        } else if (c.kind === "optional") {
          gatherSizers([c.container], behindSwitch);
        } else if (c.kind === "switch") {
          for (const struct of Object.values(c.cases))
            gatherSizers(struct.fields, true);
        } else if (c.kind === "encrypted") {
          gatherSizers(c.plaintext.fields, behindSwitch);
        }
      }
    };
    for (const c of containers) {
      gatherSizers([c], false);
      // A plain `length`-category int/bits cell is a controller candidate. So is
      // a dynamic-width `length` field (a `varint` / `berLength`): when one sizes
      // a sibling `bytes(ref X)` value but is neither a top-level renderer cell
      // nor a Group subfield (it lives inside a Switch case — quicLong
      // `tokenLength` sizing `token`, snmpV2c `pduLengthUnknown` sizing
      // `pduDataUnknown`), no WidthPicker / sibling path reaches it, so the
      // visible variable region it measures is see-but-cannot-edit. `env[X]`
      // holds the decoded VALUE (the byte count of the sized region), so a
      // packet-level length controller keyed on `env[X]` is the right surface —
      // the same slider int/bits length fields get.
      if (
        isField(c) &&
        (c.type.kind === "int" ||
          c.type.kind === "bits" ||
          c.type.kind === "varint" ||
          c.type.kind === "berLength") &&
        c.category === "length"
      ) {
        lengthFields.set(c.id, c);
      }
      // An OPTIONAL-wrapped length cell is also a controller candidate. rohc's
      // `feedbackSize` is an `optional {when: feedbackCode==0}` int that sizes a
      // sibling `feedbackData = bytes(cond(feedbackCode==0 ? feedbackSize : …))`.
      // At the seeded load state (feedbackCode=0) the Size octet AND the
      // feedbackData region are both VISIBLE and feedbackData's width is driven
      // entirely by feedbackSize — but `flattenForMirror` does not descend into
      // Optional, so feedbackSize is neither a top-level cell nor a Group
      // subfield, and the direct-sibling `lengthFields` scan above (which only
      // sees unwrapped fields) misses it. Surface it as a length controller keyed
      // on `env[feedbackSize]`; OverridePanel's per-controller live gate
      // (`fieldRendered`) keeps the slider LIVE only while the Size octet is in
      // the diagram (feedbackCode==0) and disabled otherwise, so the control
      // appears exactly when the width it drives is the editable one.
      if (c.kind === "optional") {
        const inner = c.container;
        if (
          isField(inner) &&
          (inner.type.kind === "int" ||
            inner.type.kind === "bits" ||
            inner.type.kind === "varint" ||
            inner.type.kind === "berLength") &&
          inner.category === "length"
        ) {
          lengthFields.set(inner.id, inner);
        }
      }
    }
    for (const [id, field] of lengthFields) {
      if (sizedBy.has(id) && !acc.has(id)) {
        acc.set(id, field);
        // Only record the sized values when at least one of them is BEHIND a
        // switch from the length field's scope (pimHelloOptLen → addrListData).
        // For a direct-sibling length→value (socks5 socksDomainLen →
        // dstAddrDomain) we leave `sizesByLenId` empty so OverridePanel keeps the
        // length-octet render gate: the value is width-0 at the seeded length, so
        // the slider IS the control that materialises it and must stay live as
        // soon as the octet's arm is selected.
        const values = valuesByRef.get(id);
        if (valueBehindSwitch.has(id) && values && values.size > 0) {
          const out = sizesByLenId.get(id) ?? new Set<string>();
          for (const v of values) out.add(v);
          sizesByLenId.set(id, out);
        }
      }
    }
  }
  // Recurse into every child scope; each gets its own sibling analysis. A
  // Repeat element (and everything below it) is flagged owned ONLY when the
  // repeat is a TLV / chain catalog (its per-record length belongs to the
  // dedicated list editor). A plain repeat keeps the flag unchanged so its
  // per-record `dnsRdLength`-style length cells stay collectable.
  for (const c of containers) {
    if (isField(c)) continue;
    if (c.kind === "bounded") {
      // Entering a bounded byte-budget marks every descendant `insideBounded`:
      // a repeat nested below is a budget-derived boundedRepeat whose per-record
      // length is owned by the budget, not a free slider.
      collectSiblingLengthControllers(
        c.fields,
        defs,
        acc,
        ownedByRecordEditor,
        true,
        sizesByLenId,
        seen,
      );
    } else if (c.kind === "ref") {
      if (seen.has(c.ref)) continue;
      const def = defs?.[c.ref];
      if (def) {
        seen.add(c.ref);
        collectSiblingLengthControllers(
          def.fields,
          defs,
          acc,
          ownedByRecordEditor,
          insideBounded,
          sizesByLenId,
          seen,
        );
        seen.delete(c.ref);
      }
    } else if (c.kind === "group") {
      collectSiblingLengthControllers(
        c.children,
        defs,
        acc,
        ownedByRecordEditor,
        insideBounded,
        sizesByLenId,
        seen,
      );
    } else if (c.kind === "optional") {
      collectSiblingLengthControllers(
        [c.container],
        defs,
        acc,
        ownedByRecordEditor,
        insideBounded,
        sizesByLenId,
        seen,
      );
    } else if (c.kind === "repeat") {
      const ownedHere =
        ownedByRecordEditor || isLikelyChainRepeat(c) || isTlvRepeat(c);
      collectSiblingLengthControllers(
        c.element.fields,
        defs,
        acc,
        ownedHere,
        insideBounded,
        sizesByLenId,
        seen,
      );
    } else if (c.kind === "switch") {
      for (const struct of Object.values(c.cases)) {
        collectSiblingLengthControllers(
          struct.fields,
          defs,
          acc,
          ownedByRecordEditor,
          insideBounded,
          sizesByLenId,
          seen,
        );
      }
    } else if (c.kind === "encrypted") {
      collectSiblingLengthControllers(
        c.plaintext.fields,
        defs,
        acc,
        ownedByRecordEditor,
        insideBounded,
        sizesByLenId,
        seen,
      );
    }
  }
}

/**
 * Collect per-record `length` fields stranded inside a PLAIN (non-TLV/non-chain)
 * repeat whose records ARE instantiable by a surfaced count control. A length
 * field inside a Repeat is normally skipped by `collectSiblingLengthControllers`
 * (`insideRepeat` guard) on the assumption that a TLV / chain / bounded-repeat
 * editor owns the per-record length. But a PLAIN freeRepeat has no such editor,
 * so a length field X declared in its element that sizes a sibling
 * `bytes(ref X)` value (often nested one level deep inside a record-variant
 * Switch arm) gets ZERO override surface: X is not a top-level cell, not a
 * subfield, and not in `lengthControllers`. At the default env X=0 the sized
 * value renders at width 0, so a refSwitch arm whose only content is that
 * `bytes(ref X)` shows nothing — the variant picker offers byte-identical,
 * empty arms it can never make visible (dnsResponse `dnsRdLength` → NS/CNAME/
 * PTR/TXT RDATA; pimHelloOptions `pimHelloOptLen` → Address List option value).
 *
 * Surface X as a packet-level `lengthController` keyed on `env[X]` (an RDLENGTH
 * / Option-Length slider), exactly as the switch-case length path does for ancp
 * / oncRpc. That both gives the user a control to reveal the value AND puts X in
 * `controlledIds`, so the previously-dead arms become drivable and the picker
 * stops contradicting the diagram. Only repeats whose id is in
 * `instantiableRepeatIds` qualify — a repeat with no surfaced count control
 * can't show a record at all, so its per-record length is moot.
 */
export function collectPlainRepeatLengthControllers(
  body: PsdlPacket["body"],
  fields: PreMetadataField[],
  instantiableRepeatIds: Set<string>,
  defs: Record<string, NamedStruct> | undefined,
): RendererField[] {
  const out: RendererField[] = [];
  const seen = new Set<string>();
  // For a single Repeat element: gather its declared `length` fields and every
  // id consumed as a `bytes(ref X)` sizer ANYWHERE inside the element (the sized
  // value commonly lives one level deep, inside a record-variant Switch arm).
  //
  // `descendSwitch` is set ONLY for a switch-nested TLV repeat surfaced as a
  // freeRepeat (icmpv6Ndp `rsOptions`/…): its element IS a single peek-Switch
  // whose per-option arms each declare the `ndpOptLength` length cell that sizes
  // that arm's `ndpOptValue = bytes(ref ndpOptLength …)`. The default (no-descend)
  // behaviour deliberately stops at a record-variant Switch — a length declared
  // in such an arm normally belongs to that inner scope's own editor — but a
  // switch-nested TLV repeat has NO inner editor (it is surfaced as a plain count
  // stepper + peek picker), so its per-record length is owned by NOBODY and the
  // visible `ndpOptValue` cell it sizes is see-but-cannot-edit. Descending the
  // single inner Switch's cases finds `ndpOptLength` so it gets a length slider.
  const surfaceElement = (
    element: { fields: Container[] },
    descendSwitch: boolean,
  ): void => {
    const lengthFields = new Map<string, PsdlField>();
    const lengthFieldsSeen = new Set<string>();
    const collectLengthFields = (containers: Container[]): void => {
      for (const c of containers) {
        if (isField(c)) {
          if (
            (c.type.kind === "int" || c.type.kind === "bits") &&
            c.category === "length"
          ) {
            // The SAME length id can appear in several Switch arms (icmpv6Ndp's
            // `ndpOptLength` is redeclared in every option-type case, only some
            // carrying a representative `defaultValue`). Keep an instance whose
            // `defaultValue` is set in preference to one without, so the surfaced
            // controller seeds a non-empty Value on load (the `_` unknown-option
            // arm declares `ndpOptLength` with no default — taking it would seed 0
            // and collapse the visible `ndpOptValue` to width 0).
            const prev = lengthFields.get(c.id);
            if (
              !prev ||
              (prev.defaultValue == null && c.defaultValue != null)
            ) {
              lengthFields.set(c.id, c);
            }
          }
          continue;
        }
        if (c.kind === "bounded") collectLengthFields(c.fields);
        else if (c.kind === "group") collectLengthFields(c.children);
        else if (c.kind === "optional") collectLengthFields([c.container]);
        else if (c.kind === "encrypted")
          collectLengthFields(c.plaintext.fields);
        else if (c.kind === "ref") {
          if (lengthFieldsSeen.has(c.ref)) continue;
          const def = defs?.[c.ref];
          if (def) {
            lengthFieldsSeen.add(c.ref);
            collectLengthFields(def.fields);
            lengthFieldsSeen.delete(c.ref);
          }
        } else if (c.kind === "switch" && descendSwitch) {
          // Switch-nested TLV repeat only: descend the inner peek-Switch arms to
          // reach the per-option `ndpOptLength`. Stays one Switch deep — does NOT
          // recurse into a nested Repeat (a length there is a deeper scope).
          for (const struct of Object.values(c.cases))
            collectLengthFields(struct.fields);
        }
        // Do NOT descend into a nested Switch case (unless `descendSwitch`) or a
        // nested Repeat: a length declared there belongs to that inner scope, not
        // this record.
      }
    };
    collectLengthFields(element.fields);
    if (lengthFields.size === 0) return;
    const sizers = new Set<string>();
    if (descendSwitch) {
      // icmpv6Ndp's `ndpOptValue` is sized by an OP-wrapped expr
      // (`bytes(ndpOptLength*8 - 2)`), not a bare `bytes(ref X)` — and it lives
      // inside the element's inner peek-Switch. `collectBytesSizers` matches only
      // bare-ref sizers and would not descend a Switch case the same way, so use
      // `exprRefs` over every non-delimited `bytes` type reachable through the
      // single inner Switch to nominate `ndpOptLength`.
      const gatherSeen = new Set<string>();
      const gather = (containers: Container[]): void => {
        for (const c of containers) {
          if (isField(c)) {
            const t = c.type;
            if (t.kind === "bytes" && !isBytesDelimited(t.n)) {
              for (const r of exprRefs(t.n)) sizers.add(r);
            }
            continue;
          }
          if (c.kind === "switch") {
            for (const struct of Object.values(c.cases)) gather(struct.fields);
          } else if (c.kind === "group") gather(c.children);
          else if (c.kind === "bounded") gather(c.fields);
          else if (c.kind === "optional") gather([c.container]);
          else if (c.kind === "encrypted") gather(c.plaintext.fields);
          else if (c.kind === "ref") {
            if (gatherSeen.has(c.ref)) continue;
            const def = defs?.[c.ref];
            if (def) {
              gatherSeen.add(c.ref);
              gather(def.fields);
              gatherSeen.delete(c.ref);
            }
          }
        }
      };
      gather(element.fields);
    } else {
      collectBytesSizers(element.fields, defs, sizers);
      // A per-record value can be sized INDIRECTLY through a `virtual`: coap's
      // `optValue = bytes(ref optValueBytes)` where `optValueBytes` is a virtual
      // `cond(optLength==13 ? optLengthExt1+13 : optLength==14 ? … : optLength)`.
      // `collectBytesSizers` records the bare ref `optValueBytes` (the virtual),
      // never the underlying `optLength` the user actually drives (the virtual is
      // recomputed by `resolveLayout` from `env[optLength]`, so overriding
      // `optValueBytes` is inert). Expand any sizer naming an element-local
      // virtual into that virtual's expr refs — transitively, in case a virtual
      // references another — so the real length cell (`optLength`) is nominated.
      const virtualRefs = new Map<string, string[]>();
      const collectVirtualsSeen = new Set<string>();
      const collectVirtuals = (containers: Container[]): void => {
        for (const c of containers) {
          if (isField(c)) continue;
          if (c.kind === "virtual") {
            virtualRefs.set(c.id, exprRefs(c.expr));
          } else if (c.kind === "group") collectVirtuals(c.children);
          else if (c.kind === "bounded") collectVirtuals(c.fields);
          else if (c.kind === "optional") collectVirtuals([c.container]);
          else if (c.kind === "encrypted") collectVirtuals(c.plaintext.fields);
          else if (c.kind === "switch") {
            for (const struct of Object.values(c.cases))
              collectVirtuals(struct.fields);
          } else if (c.kind === "ref") {
            if (collectVirtualsSeen.has(c.ref)) continue;
            const def = defs?.[c.ref];
            if (def) {
              collectVirtualsSeen.add(c.ref);
              collectVirtuals(def.fields);
              collectVirtualsSeen.delete(c.ref);
            }
          }
          // A nested Repeat is a deeper length scope — do not descend.
        }
      };
      collectVirtuals(element.fields);
      const pending = [...sizers];
      const expanded = new Set<string>();
      while (pending.length > 0) {
        const ref = pending.pop()!;
        if (expanded.has(ref)) continue;
        expanded.add(ref);
        const refs = virtualRefs.get(ref);
        if (!refs) continue;
        for (const r of refs) {
          sizers.add(r);
          pending.push(r);
        }
      }
    }
    for (const [id, field] of lengthFields) {
      if (!sizers.has(id) || seen.has(id)) continue;
      // Don't shadow an existing top-level cell / surfaced control.
      if (fields.some((f) => f.id === id)) continue;
      seen.add(id);
      const bits = typeBits(field.type);
      out.push({
        id,
        name: field.name ?? id,
        bits,
        controlsLength: id,
        max: bits > 0 ? 2 ** bits - 1 : undefined,
        ...(field.defaultValue != null
          ? { defaultValue: field.defaultValue }
          : {}),
        ...(field.doc ? { description: field.doc } : {}),
      });
    }
  };
  // `insideBounded` is true once any ancestor `bounded` byte-budget has been
  // entered. A repeat inside a bounded scope (isisLsp `tlvs` under `tlvsRegion`)
  // is auto-filled to consume the WHOLE budget and its per-record length is
  // implicitly driven by that budget — surfacing a separate length slider would
  // fight the budget (the A4 destructive-bounded class) and, worse, would
  // un-suppress an inert all-zero-width refSwitch picker (isisLsp `tlvType`,
  // whose arms are all `bytes(ref tlvLength)`). So only PLAIN repeats NOT under
  // any bounded budget qualify (dnsResponse `dnsAnswers`, pimHelloOptions).
  // Recurse manually (NOT via flattenForMirror, which erases bounded
  // boundaries) so the `insideBounded` flag is preserved.
  const refSeen = new Set<string>();
  const visit = (
    containers: Container[],
    insideBounded: boolean,
    insideSwitch: boolean,
    insideOptional: boolean,
    insideRepeat: boolean,
  ): void => {
    for (const c of containers) {
      if (isField(c)) continue;
      if (c.kind === "repeat") {
        const plain = !isLikelyChainRepeat(c) && !isTlvRepeat(c);
        // A switch-nested (or optional-nested) TLV repeat is surfaced as a
        // freeRepeat (count stepper) + peek picker by collectFreeRepeats — NOT
        // promoted to a tlv field — exactly when it is TLV-shaped, lives in a
        // Switch case / Optional, and is not itself inside another Repeat. It has
        // NO per-record list editor, so its per-record length cell (icmpv6Ndp
        // `ndpOptLength`, sizing the VISIBLE `ndpOptValue` in the option's `_`
        // arm) is owned by nobody — surface it too, descending the element's
        // single inner peek-Switch to find it.
        //
        // This predicate is NOT `surfacedNestedTlvRepeat` (psdl-queries), the
        // one collectFreeRepeats and collectPeekSwitches share, even though it
        // is reaching for the same set. It has no `enclosingInstantiable` term
        // and adds `!insideBounded`; what actually aligns the two sets is the
        // `instantiableRepeatIds.has(c.id)` gate below, which is populated by
        // collectFreeRepeats earlier in the pipeline. So the agreement is a
        // property of the call ORDER, not of the expression — and the boolean
        // is also passed to `surfaceElement` to pick the descent mode, so the
        // two are not interchangeable. Changing either one needs the
        // surfaced-set test in tests/psdl to be re-read, not just tsc.
        // A DIRECT repeat-of-repeat TLV repeat (`repeat lit N { repeat eos {
        // switch on peek } }`, no intervening switch case/optional) is surfaced as
        // a freeRepeat + peek picker by collectFreeRepeats too, gated there on the
        // enclosing repeat being instantiable. It has the same ownerless per-record
        // length cell, so descend its inner Switch here as well. The
        // `instantiableRepeatIds.has(c.id)` gate below already confirms the inner
        // repeat earned a count control, so `insideRepeat` alone qualifies.
        const surfacedNestedTlv =
          isTlvRepeat(c) &&
          !insideBounded &&
          (insideSwitch || insideOptional || insideRepeat);
        if (
          (plain || surfacedNestedTlv) &&
          !insideBounded &&
          instantiableRepeatIds.has(c.id)
        ) {
          surfaceElement(c.element, surfacedNestedTlv);
        }
        visit(c.element.fields, insideBounded, false, false, true);
        continue;
      }
      if (c.kind === "bounded") {
        visit(c.fields, true, insideSwitch, insideOptional, insideRepeat);
        continue;
      }
      if (c.kind === "group") {
        visit(
          c.children,
          insideBounded,
          insideSwitch,
          insideOptional,
          insideRepeat,
        );
        continue;
      }
      if (c.kind === "optional") {
        visit([c.container], insideBounded, insideSwitch, true, insideRepeat);
        continue;
      }
      if (c.kind === "switch") {
        for (const struct of Object.values(c.cases))
          visit(
            struct.fields,
            insideBounded,
            true,
            insideOptional,
            insideRepeat,
          );
        continue;
      }
      if (c.kind === "encrypted") {
        visit(
          c.plaintext.fields,
          insideBounded,
          insideSwitch,
          insideOptional,
          insideRepeat,
        );
        continue;
      }
      if (c.kind === "ref") {
        if (refSeen.has(c.ref)) continue;
        const def = defs?.[c.ref];
        if (def) {
          refSeen.add(c.ref);
          visit(
            def.fields,
            insideBounded,
            insideSwitch,
            insideOptional,
            insideRepeat,
          );
          refSeen.delete(c.ref);
        }
        continue;
      }
    }
  };
  visit(body, false, false, false, false);
  return out;
}

/** Collect every leaf `field` declared anywhere inside the body (recursing
 *  through every container kind, including nested repeats / switch arms) keyed by
 *  id, so a per-record length field stranded inside a bounded repeat's element
 *  can be looked up to build its packet-level controller. */
function collectAllFieldsById(
  containers: Container[],
  defs: Record<string, NamedStruct> | undefined,
  acc: Map<string, PsdlField>,
  seen: Set<string> = new Set(),
): void {
  for (const c of containers) {
    if (isField(c)) {
      if (!acc.has(c.id)) acc.set(c.id, c);
      continue;
    }
    switch (c.kind) {
      case "group":
        collectAllFieldsById(c.children, defs, acc, seen);
        break;
      case "bounded":
        collectAllFieldsById(c.fields, defs, acc, seen);
        break;
      case "optional":
        collectAllFieldsById([c.container], defs, acc, seen);
        break;
      case "repeat":
        collectAllFieldsById(c.element.fields, defs, acc, seen);
        break;
      case "encrypted":
        collectAllFieldsById(c.plaintext.fields, defs, acc, seen);
        break;
      case "switch":
        for (const s of Object.values(c.cases))
          collectAllFieldsById(s.fields, defs, acc, seen);
        break;
      case "ref": {
        if (seen.has(c.ref)) break;
        const def = defs?.[c.ref];
        if (def) {
          seen.add(c.ref);
          collectAllFieldsById(def.fields, defs, acc, seen);
          seen.delete(c.ref);
        }
        break;
      }
      default:
        break;
    }
  }
}

/**
 * Surface the PER-RECORD length field of a FLAT-TLV bounded repeat as a
 * packet-level length controller.
 *
 * A flat-TLV bounded-eos repeat — a record shaped `[type, length X, value =
 * bytes(<expr over X>)]` inside a single-ref byte budget (stun `stunAttrLen`→
 * `stunAttrValue`, bgpOpen `parmLen`→`parmValue`, pppoe `tagLength`→`tagValue`,
 * tlsCertificate `tlsCertDataLen`→cert data, cops `copsObjLength`/dnssecRecords
 * `…LabelLen`, …) — lowers to a boundedRepeat that exposes only the COUNT key and
 * the OUTER budget length key. `flatTlvInnerSeeds` already records each per-record
 * length field X on the boundedRepeat's `innerScopeSeeds`, SOLVED so the record's
 * value renders at a representative width on load. But X itself gets NO control:
 * `collectPlainRepeatLengthControllers` skips any repeat inside a bounded scope
 * (the `!insideBounded` guard), `collectSiblingLengthControllers` likewise stops
 * at a bounded scope, and X is not the budget key — so the user SEES a ~4-byte
 * value cell but can never change its size (see-but-cannot-edit), and clicking
 * either the length OR the value cell hits OverridePanel's read-only EmptyState.
 *
 * Surface each `innerScopeSeeds` key as a `controlsLength` controller keyed on
 * `env[X]` — exactly the slider dnsResponse `dnsRdLength` / ocspRequest
 * `hashAlgLength` get via the PLAIN-repeat path. The seed VALUE becomes the
 * controller's `defaultValue` so its initial slider position matches the seeded
 * (visible) value, and because the value is `bytes(<expr over X>)` raising X grows
 * it. Driven straight off `innerScopeSeeds`, this handles the offset/scaled length
 * exprs (cops' `copsObjLength - 4`, gist's `gistObjLen * 4`) that `collectBytesSizers`
 * (bare-ref only) would miss. The deliberately-suppressed isisLsp-style case
 * (whose value collapses to width 0 and carries NO innerScopeSeeds) is untouched.
 *
 * Restricted to the FLAT-TLV bounded shape — a record whose element holds NO
 * nested bounded. The tlvExtension (tlsClientHello) / nested-group (ocspRequest)
 * bounded repeats ALSO carry innerScopeSeeds, but theirs seed a PER-RECORD INNER
 * BUDGET (not an independent value-length knob): surfacing those as a length
 * controller would let the user drive that inner budget below its fixed children
 * and over-consume the nested scope. `containsBounded` on the owning repeat's
 * element separates the two — flat-TLV records never wrap their own bounded.
 */
export function collectFlatTlvInnerLengthControllers(
  body: PsdlPacket["body"],
  fields: PreMetadataField[],
  boundedRepeats: NonNullable<RendererPacket["boundedRepeats"]>,
  defs: Record<string, NamedStruct> | undefined,
): RendererField[] {
  const out: RendererField[] = [];
  const seen = new Set<string>();
  let allFields: Map<string, PsdlField> | null = null;
  // Repeat ids whose element wraps a nested bounded (tlvExtension / nested-group
  // idioms) — their innerScopeSeeds seed an inner budget, NOT a flat value
  // length, so they are excluded.
  const nestedBoundedRepeatIds = new Set<string>();
  const findNestedBoundedRefSeen = new Set<string>();
  const findNestedBounded = (containers: Container[]): void => {
    for (const c of containers) {
      if (isField(c)) continue;
      if (c.kind === "repeat") {
        if (containsBounded(c.element.fields)) nestedBoundedRepeatIds.add(c.id);
        findNestedBounded(c.element.fields);
        continue;
      }
      if (c.kind === "group") findNestedBounded(c.children);
      else if (c.kind === "bounded") findNestedBounded(c.fields);
      else if (c.kind === "optional") findNestedBounded([c.container]);
      else if (c.kind === "encrypted") findNestedBounded(c.plaintext.fields);
      else if (c.kind === "switch") {
        for (const s of Object.values(c.cases)) findNestedBounded(s.fields);
      } else if (c.kind === "ref") {
        if (findNestedBoundedRefSeen.has(c.ref)) continue;
        const def = defs?.[c.ref];
        if (def) {
          findNestedBoundedRefSeen.add(c.ref);
          findNestedBounded(def.fields);
          findNestedBoundedRefSeen.delete(c.ref);
        }
      }
    }
  };
  findNestedBounded(body);
  for (const br of boundedRepeats) {
    // Skip the tlvExtension / nested-group bounded repeats: their innerScopeSeeds
    // are inner-budget seeds, not flat per-record value lengths.
    if (nestedBoundedRepeatIds.has(br.countKey)) continue;
    for (const seed of br.innerScopeSeeds ?? []) {
      const id = seed.key;
      if (seen.has(id)) continue;
      // Don't shadow a top-level cell or an already-surfaced control — those
      // host their own widget.
      if (fields.some((f) => f.id === id)) continue;
      if (allFields === null) {
        allFields = new Map<string, PsdlField>();
        collectAllFieldsById(body, defs, allFields);
      }
      const field = allFields.get(id);
      if (!field) continue;
      seen.add(id);
      const bits = typeBits(field.type);
      out.push({
        id,
        name: field.name ?? id,
        bits,
        controlsLength: id,
        max: bits > 0 ? 2 ** bits - 1 : undefined,
        // Seed the slider to the representative value the diagram renders at load
        // (the solved inner-scope seed), not the field's 0 default — so the
        // control's position matches the visible value.
        defaultValue: seed.value,
        ...(field.doc ? { description: field.doc } : {}),
      });
    }
  }
  return out;
}

/**
 * Surface a Group-nested `length` field that sizes a VISIBLE `bytes` cell living
 * in a DIFFERENT scope as a packet-level length controller.
 *
 * A `length`-category int/bits field declared inside a Group becomes a renderer
 * *subfield* (Groups collapse to `subfields[]`), so it can never host its own
 * slider. The constraint / bounded-controller paths only stamp `controlsLength`
 * onto such a subfield when the length sizes a `bounded.bytes` budget; the
 * sibling-length path (`collectSiblingLengthControllers`) only inspects DIRECT
 * siblings of the length field. Neither matches a group-internal length whose
 * sized `bytes(ref X)` value is a sibling of the GROUP, not of the field:
 *   - geneve  `optLen` (in group `word1`)        → top-level `options`   = bytes(optLen*4)
 *   - nsh     `nshLength` (in `nshBaseHeader`)    → top-level `nshContextHeaders`
 *   - pgm     `pgmTsduLength` (in `pgmCommonHeader`) → top-level `pgmOdataData`/`pgmRdataData`
 *   - ipinip  `innerTotalLength`/`innerIhl` (in `innerIpv4Header`) → top-level `innerPayload`
 * The user SEES the variable region appear/grow but has no control to drive it —
 * a see-but-cannot-edit cell. Surface X as a packet-level `lengthController`
 * keyed on `env[X]` (same emission shape as the bounded-subfield path), so the
 * OverridePanel renders the same length slider IHL / Data Offset get.
 *
 * Only Group nesting is descended (not Repeat / Switch / Optional / Bounded /
 * Encrypted): a length stranded inside those scopes is OWNED by another path
 * (`collectPlainRepeatLengthControllers`, `collectBoundedControllers`,
 * `collectOptionalLengthGates`, the switch-case branch of
 * `collectSiblingLengthControllers`). The caller dedupes against already-emitted
 * controllers and skips ids that ARE top-level cells.
 *
 * A length field that ALSO discriminates a Switch (its id is a `switch.on` ref)
 * is excluded: such a value is a FORMAT/ESCAPE selector, not a pure byte count
 * (websocketFrame `payloadLength7` — values 126/127 mean "read the extended
 * 16/64-bit length", not "126/127 bytes"). Driving it as a length slider would
 * be misleading AND would flip the discriminator into the extended-length arm,
 * exploding the diagram. Its variant surface is the switch picker, not a slider.
 */
export function collectGroupNestedLengthControllers(
  body: PsdlPacket["body"],
  fields: PreMetadataField[],
  defs: Record<string, NamedStruct> | undefined,
): RendererField[] {
  // Every id REFERENCED by a non-delimited `bytes` length expr anywhere in the
  // body — X sizes a (visible) variable-length value. Unlike `collectBytesSizers`
  // (which only matches a BARE `bytes(ref X)`), this uses `exprRefs` so an
  // op-wrapped length expr counts too: geneve `bytes(optLen*4)`, nsh
  // `bytes((nshLength-k)*m)`, ipinip `bytes(innerTotalLength - innerIhl*4)`.
  // `switchOn` collects every id used as a `switch.on` discriminator so a
  // length/escape selector is excluded below.
  const sizers = new Set<string>();
  const switchOn = new Set<string>();
  const gatherSizersRefSeen = new Set<string>();
  const gatherSizers = (containers: Container[]): void => {
    for (const c of containers) {
      if (isField(c)) {
        const t = c.type;
        if (t.kind === "bytes" && !isBytesDelimited(t.n)) {
          for (const r of exprRefs(t.n)) sizers.add(r);
        }
        continue;
      }
      switch (c.kind) {
        case "group":
          gatherSizers(c.children);
          break;
        case "repeat":
          gatherSizers(c.element.fields);
          break;
        case "optional":
          gatherSizers([c.container]);
          break;
        case "bounded":
          gatherSizers(c.fields);
          break;
        case "encrypted":
          gatherSizers(c.plaintext.fields);
          break;
        case "switch":
          for (const r of exprRefs(c.on)) switchOn.add(r);
          for (const struct of Object.values(c.cases))
            gatherSizers(struct.fields);
          break;
        case "ref": {
          if (gatherSizersRefSeen.has(c.ref)) break;
          const def = defs?.[c.ref];
          if (def) {
            gatherSizersRefSeen.add(c.ref);
            gatherSizers(def.fields);
            gatherSizersRefSeen.delete(c.ref);
          }
          break;
        }
        default:
          break;
      }
    }
  };
  gatherSizers(body);
  const out: RendererField[] = [];
  const seen = new Set<string>();
  // Descend ONLY through Group (and resolved `ref`) so `insideGroup` is true
  // exactly for fields that collapse to a subfield. Other nesting kinds are
  // length scopes owned by a different controller path, so we do not descend
  // into them here.
  const walkRefSeen = new Set<string>();
  const walk = (containers: Container[], insideGroup: boolean): void => {
    for (const c of containers) {
      if (isField(c)) {
        if (
          insideGroup &&
          (c.type.kind === "int" || c.type.kind === "bits") &&
          c.category === "length" &&
          sizers.has(c.id) &&
          !seen.has(c.id) &&
          // A length that ALSO drives a Switch is a format/escape selector, not a
          // pure byte count (websocketFrame `payloadLength7`) — leave it to the
          // switch picker.
          !switchOn.has(c.id) &&
          // Skip a length field that IS already a top-level renderer cell — it
          // hosts its own slider (or is owned by another discriminator widget).
          !fields.some((f) => f.id === c.id)
        ) {
          seen.add(c.id);
          const bits = typeBits(c.type);
          out.push({
            id: c.id,
            name: c.name ?? c.id,
            bits,
            controlsLength: c.id,
            max: bits > 0 ? 2 ** bits - 1 : undefined,
            ...(c.defaultValue != null ? { defaultValue: c.defaultValue } : {}),
            ...(c.doc ? { description: c.doc } : {}),
          });
        }
        continue;
      }
      if (c.kind === "group") {
        walk(c.children, true);
      } else if (c.kind === "ref") {
        if (walkRefSeen.has(c.ref)) continue;
        const def = defs?.[c.ref];
        if (def) {
          walkRefSeen.add(c.ref);
          walk(def.fields, insideGroup);
          walkRefSeen.delete(c.ref);
        }
      }
      // Repeat / Switch / Optional / Bounded / Encrypted are deliberately NOT
      // descended: their internal length fields belong to other paths.
    }
  };
  walk(body, false);
  return out;
}

/** The set of literal values an `Expr` compares a given `ref` against with `==`
 *  (`payloadLength7 == 126`, …). Used to find the MAGIC escape values that a
 *  cond-width discriminator reserves, so the inline length slider for that same
 *  field can be capped BELOW the smallest magic (it must never snap the diagram
 *  into an extended-length arm — that is the refSwitch picker's job). */
function condEqualityLiterals(expr: Expr, ref: string): number[] {
  const out: number[] = [];
  const walk = (e: Expr): void => {
    switch (e.kind) {
      case "op": {
        if (
          e.op === "==" &&
          ((e.a.kind === "ref" && e.a.field === ref && e.b.kind === "lit") ||
            (e.b.kind === "ref" && e.b.field === ref && e.a.kind === "lit"))
        ) {
          const lit = e.a.kind === "lit" ? e.a : (e.b as { value: number });
          out.push(lit.value);
        }
        walk(e.a);
        walk(e.b);
        break;
      }
      case "cond":
        walk(e.test);
        walk(e.t);
        walk(e.f);
        break;
      case "lookup":
        walk(e.key);
        break;
      case "peek":
        if (e.offset) walk(e.offset);
        break;
      default:
        break;
    }
  };
  walk(expr);
  return out;
}

/**
 * Surface a length controller for EVERY field referenced by a `bytes(cond …)`
 * width expression — the payload whose byte count is selected between several
 * length fields by a discriminator (websocketFrame's `payload` =
 * `bytes(cond payloadLength7==126 ? extPayloadLength16 : cond payloadLength7==127
 * ? extPayloadLength64 : payloadLength7)`).
 *
 * The other length-controller paths only recognise a length field that DIRECTLY
 * sizes a sibling `bytes(ref X)` (a bare ref width). A `cond`-discriminated width
 * is invisible to all of them: the cond's branch refs live INSIDE Switch arms
 * (`extPayloadLength16`/`extPayloadLength64` in `byPayloadLength7`'s 126/127
 * cases) so they are neither top-level cells, Group subfields, nor sibling-length
 * candidates — they get ZERO mirror entry — and the discriminator itself
 * (`payloadLength7`) is treated purely as a refSwitch key, so the inline 0..N
 * payload-length branch has no slider. The user SEES the Payload Data cell and
 * the Extended-Length cells but cannot drive the single most important quantity
 * in the frame (override-audit: see-but-cannot-edit, bar #1).
 *
 * For each leaf `ref` in the cond test/branches, emit a packet-level length
 * controller keyed on `env[ref]`:
 *   - A BRANCH-only ref (extPayloadLength16/extPayloadLength64) sizes the payload
 *     only while its arm is selected, and its own cell renders only then. Emit it
 *     WITHOUT `lengthSizesFieldIds` so OverridePanel's live gate falls back to the
 *     controller cell's own render state — the slider is live exactly when the
 *     Extended-Length cell is on the diagram (126/127 selected) and disabled
 *     otherwise.
 *   - A DISCRIMINATOR ref that is ALSO an inline branch (payloadLength7: the `_`
 *     branch returns it verbatim) keeps its refSwitch for the 126/127 magic but
 *     ALSO earns an inline slider. Its slider is CAPPED below the smallest magic
 *     literal (125 here) so dragging it stays in the inline range and can never
 *     flip the diagram into an extended-length arm.
 *
 * Deduped by the caller against the controllers emitted above. Only TOP-LEVEL
 * (non-repeat, non-bounded) cond-width payloads are walked: a per-record
 * cond-width is owned by its repeat's editor.
 */
export function collectCondWidthLengthControllers(
  body: PsdlPacket["body"],
  defs: Record<string, NamedStruct> | undefined,
): RendererField[] {
  // id → declaring PSDL field, gathered across the whole body so a branch ref
  // buried in a Switch case can be resolved to its width/default/doc.
  const fieldById = new Map<string, PsdlField>();
  const indexSeen = new Set<string>();
  const index = (containers: Container[]): void => {
    for (const c of containers) {
      if (isField(c)) {
        if (!fieldById.has(c.id)) fieldById.set(c.id, c);
        continue;
      }
      switch (c.kind) {
        case "group":
          index(c.children);
          break;
        case "repeat":
          index(c.element.fields);
          break;
        case "optional":
          index([c.container]);
          break;
        case "bounded":
          index(c.fields);
          break;
        case "encrypted":
          index(c.plaintext.fields);
          break;
        case "switch":
          for (const struct of Object.values(c.cases)) index(struct.fields);
          break;
        case "ref": {
          if (indexSeen.has(c.ref)) break;
          const def = defs?.[c.ref];
          if (def) {
            indexSeen.add(c.ref);
            index(def.fields);
            indexSeen.delete(c.ref);
          }
          break;
        }
        default:
          break;
      }
    }
  };
  index(body);

  const out: RendererField[] = [];
  const emitted = new Set<string>();
  // Walk ONLY the transparent top-level scopes (Group / resolved ref); a
  // cond-width payload inside a Repeat / Bounded / Switch / Optional is a
  // per-record / arm-local width owned by another editor.
  const walkRefSeen = new Set<string>();
  const walk = (containers: Container[]): void => {
    for (const c of containers) {
      if (isField(c)) {
        const t = c.type;
        if (
          t.kind !== "bytes" ||
          isBytesDelimited(t.n) ||
          t.n.kind !== "cond"
        ) {
          continue;
        }
        const refs = new Set(exprRefs(t.n));
        // The discriminator(s) the cond tests against — those whose value is
        // compared with a magic literal somewhere in the expression.
        for (const ref of refs) {
          if (emitted.has(ref)) continue;
          const field = fieldById.get(ref);
          if (!field) continue;
          const bits = typeBits(field.type);
          const magics = condEqualityLiterals(t.n, ref).filter((v) => v >= 0);
          // A discriminator that ALSO appears as an inline branch value gets an
          // inline slider capped just below its smallest magic escape value so
          // the slider can never snap into an extended-length arm (the refSwitch
          // owns those). A pure branch ref (no magic of its own) is gated on its
          // own cell's render state via the controller live-gate fallback.
          const inlineCap =
            magics.length > 0
              ? Math.max(0, Math.min(...magics) - 1)
              : undefined;
          const naturalMax = bits > 0 ? 2 ** bits - 1 : undefined;
          const max =
            inlineCap != null
              ? naturalMax != null
                ? Math.min(naturalMax, inlineCap)
                : inlineCap
              : naturalMax;
          emitted.add(ref);
          out.push({
            id: ref,
            name: field.name ?? ref,
            bits,
            controlsLength: ref,
            ...(max != null ? { max } : {}),
            ...(field.defaultValue != null
              ? { defaultValue: field.defaultValue }
              : {}),
            ...(field.doc ? { description: field.doc } : {}),
          });
        }
        continue;
      }
      if (c.kind === "group") {
        walk(c.children);
      } else if (c.kind === "ref") {
        if (walkRefSeen.has(c.ref)) continue;
        const def = defs?.[c.ref];
        if (def) {
          walkRefSeen.add(c.ref);
          walk(def.fields);
          walkRefSeen.delete(c.ref);
        }
      }
      // Repeat / Switch / Optional / Bounded / Encrypted: their cond-width
      // payloads belong to other paths, so they are not descended here.
    }
  };
  walk(body);
  return out;
}

/**
 * Collect every field id used as a `repeat.count` (or `until`) discriminator
 * anywhere in the body. These are the "other refs" subtracted from an
 * `optional.when` budget expression by `collectOptionalGateLengthControllers`:
 * a BYE-style length budget reads `((length+1)*4 - 4) - rtcpByeSrcCount*4`,
 * where `rtcpByeSrcCount` is the source-count loop's count ref and `length` is
 * the field the user actually drives. Subtracting the loop-count refs isolates
 * the length field.
 */
export function collectRepeatCountRefs(
  containers: Container[],
  defs: Record<string, NamedStruct> | undefined,
  acc: Set<string>,
  seen: Set<string> = new Set(),
): void {
  for (const c of containers) {
    if (isField(c)) continue;
    switch (c.kind) {
      case "repeat": {
        const count = c.count;
        if (count !== "eos") {
          const expr =
            typeof count === "object" && "until" in count ? count.until : count;
          for (const r of exprRefs(expr)) acc.add(r);
        }
        collectRepeatCountRefs(c.element.fields, defs, acc, seen);
        break;
      }
      case "group":
        collectRepeatCountRefs(c.children, defs, acc, seen);
        break;
      case "optional":
        collectRepeatCountRefs([c.container], defs, acc, seen);
        break;
      case "bounded":
        collectRepeatCountRefs(c.fields, defs, acc, seen);
        break;
      case "encrypted":
        collectRepeatCountRefs(c.plaintext.fields, defs, acc, seen);
        break;
      case "switch":
        for (const struct of Object.values(c.cases))
          collectRepeatCountRefs(struct.fields, defs, acc, seen);
        break;
      case "ref": {
        if (seen.has(c.ref)) break;
        const def = defs?.[c.ref];
        if (def) {
          seen.add(c.ref);
          collectRepeatCountRefs(def.fields, defs, acc, seen);
          seen.delete(c.ref);
        }
        break;
      }
      default:
        break;
    }
  }
}

/**
 * Surface a VISIBLE top-level `length`-category int field X as a packet-level
 * length controller when X is the SOLE non-loop ref in an `optional.when` budget
 * expression that materialises the rest of the packet.
 *
 * rtcpBye's trailing Reason block is gated by
 * `optional {when: ((length+1)*4 - 4) - rtcpByeSrcCount*4 > 0}` wrapping
 * `rtcpByeHasReason`, which in turn gates+sizes `rtcpByeReason`. Raising the
 * 16-bit `length` cell is the ONLY thing that materialises `rtcpByeHasReason`
 * (and through it the Reason payload). But `length` lives OUTSIDE the optional
 * and only drives its `when` via this multi-ref op expr, so NONE of the other
 * length-controller collectors reach it: it is not a `bytes(ref length)` sizer
 * (`collectBytesSizers`/`collectSiblingLengthControllers` miss it), not a
 * `bounded.bytes` ref (`collectBoundedControllers` misses it), and
 * `collectOptionalLengthGates` only fires when the optional's CONTAINER field is
 * itself the sizer (here `length` is outside the optional). At the seeded load
 * state `length=0`, so `rtcpByeHasReason` is absent and the lone control offered
 * for the region (the `rtcpByeHasReason` length controller) is gated inert by
 * `fieldRendered`, leaving the user with NO working control to reach the rest of
 * the packet — a see-but-cannot-edit width-driving cell.
 *
 * Detection: for each `optional`, take `exprRefs(when)` minus every
 * `repeat.count` ref in the body; if exactly one ref X remains, and X is a
 * VISIBLE top-level int/bits cell of `category === "length"` that does NOT
 * already drive the diagram (`controlsLength`/`switchCases`/`enumVariants`),
 * stamp `controlsLength = X` onto that cell. The cell is always rendered, so the
 * OverridePanel `fieldRendered(cells, 'length')` live gate keeps the slider
 * live. Returns the stamped field ids so the caller dedupes against earlier
 * passes.
 */
export function collectOptionalGateLengthControllers(
  body: PsdlPacket["body"],
  fields: PreMetadataField[],
  defs: Record<string, NamedStruct> | undefined,
): string[] {
  const countRefs = new Set<string>();
  collectRepeatCountRefs(body, defs, countRefs);
  const stamped: string[] = [];
  const walkRefSeen = new Set<string>();
  const walk = (containers: Container[]): void => {
    for (const c of containers) {
      if (isField(c)) continue;
      if (c.kind === "optional") {
        const refs = new Set(exprRefs(c.when));
        for (const r of countRefs) refs.delete(r);
        if (refs.size === 1) {
          const x = [...refs][0];
          const target = fields.find((f) => f.id === x);
          // Two terms used to sit in this condition and neither could ever
          // affect it:
          //   `|| target.controlsLength === x` — reachable only when
          //     `controlsLength` is set, which the very next term rejects.
          //   `&& !target.switchCases` — this stage runs BEFORE
          //     `attachOverrideMetadata`, so the property is always undefined
          //     (`PreMetadataField` now makes writing it here a compile error).
          // The discriminator collision the second term was reaching for is
          // handled once, after the metadata exists, in `psdlToRenderer`.
          if (
            target &&
            target.category === "length" &&
            !target.controlsLength &&
            !target.enumVariants
          ) {
            target.controlsLength = x;
            if (target.bits != null) {
              target.max = Math.max(target.max ?? 0, 2 ** target.bits - 1);
            }
            stamped.push(x);
          }
        }
        walk([c.container]);
        continue;
      }
      if (c.kind === "group") {
        walk(c.children);
      } else if (c.kind === "repeat") {
        walk(c.element.fields);
      } else if (c.kind === "bounded") {
        walk(c.fields);
      } else if (c.kind === "encrypted") {
        walk(c.plaintext.fields);
      } else if (c.kind === "switch") {
        for (const struct of Object.values(c.cases)) walk(struct.fields);
      } else if (c.kind === "ref") {
        if (walkRefSeen.has(c.ref)) continue;
        const def = defs?.[c.ref];
        if (def) {
          walkRefSeen.add(c.ref);
          walk(def.fields);
          walkRefSeen.delete(c.ref);
        }
      }
    }
  };
  walk(body);
  return stamped;
}
