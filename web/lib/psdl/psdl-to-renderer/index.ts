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
import { evalExprOr, exprRefs, peekEnvKey } from "../expr";
import { isBytesDelimited } from "../normalize";
import {
  collectSwitchOnRefIds,
  seedDynamicWidthDefaults,
} from "../dynamic-width-defaults";
import type {
  Bounded,
  Constraint,
  Container,
  Expr,
  Field as PsdlField,
  Group,
  NamedStruct,
  Packet as PsdlPacket,
  Repeat,
  Struct,
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
import {
  groupToSubfieldField,
  groupToSubfieldFieldDeep,
  plainFieldToRenderer,
} from "./subfield";
import { isTlvRepeat, repeatToTlvField } from "./tlv";
import {
  caseKeyCoversValue,
  defaultArmSentinel,
  firstCaseKeyValue,
  prettifyId,
  typeBits,
} from "./shared";
// `resolveLayout` is used ONLY by `nestedGroupBoundedSeeds` to probe a
// crash-free per-record inner length for the rare plain-group nested-bounded
// idiom (ocspRequest). layout.ts imports `./normalize` + the leaf
// `./psdl-to-renderer/tlv-cell-id`, neither of which re-imports this module, so
// there is no import cycle.
import { resolveLayout } from "../layout";
import { initialEnv } from "../normalize";
import { collectPsdlRefs } from "../collect-refs";

export { rendererToPsdl } from "./to-psdl";
export { applyTlvInstances } from "./apply-tlv";
export { applyChainInstances, parseChainCellId } from "./apply-chain";
export { applyByteOrderOverrides } from "./apply-byte-order";
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

function collectTlvOwnedBoundedControllers(
  containers: Container[],
  defs: Record<string, NamedStruct> | undefined,
  acc: Set<string>,
): void {
  for (const c of containers) {
    if (isField(c)) continue;
    if (c.kind === "bounded") {
      const controller = singleRefController(c.bytes);
      if (controller && isTlvOwnedBounded(c, defs)) acc.add(controller);
      collectTlvOwnedBoundedControllers(c.fields, defs, acc);
      continue;
    }
    if (c.kind === "ref") {
      const def = defs?.[c.ref];
      if (def) collectTlvOwnedBoundedControllers(def.fields, defs, acc);
      continue;
    }
    if (c.kind === "group") {
      collectTlvOwnedBoundedControllers(c.children, defs, acc);
      continue;
    }
    if (c.kind === "optional") {
      collectTlvOwnedBoundedControllers([c.container], defs, acc);
      continue;
    }
    if (c.kind === "repeat") {
      collectTlvOwnedBoundedControllers(c.element.fields, defs, acc);
      continue;
    }
    if (c.kind === "switch") {
      for (const struct of Object.values(c.cases)) {
        collectTlvOwnedBoundedControllers(struct.fields, defs, acc);
      }
      continue;
    }
    if (c.kind === "encrypted") {
      collectTlvOwnedBoundedControllers(c.plaintext.fields, defs, acc);
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
        collectBytesSizers(c.children, defs, acc);
        break;
      case "repeat":
        collectBytesSizers(c.element.fields, defs, acc);
        break;
      case "optional":
        collectBytesSizers([c.container], defs, acc);
        break;
      case "bounded":
        collectBytesSizers(c.fields, defs, acc);
        break;
      case "encrypted":
        collectBytesSizers(c.plaintext.fields, defs, acc);
        break;
      case "switch":
        for (const struct of Object.values(c.cases)) {
          collectBytesSizers(struct.fields, defs, acc);
        }
        break;
      case "ref": {
        const def = defs?.[c.ref];
        if (def) collectBytesSizers(def.fields, defs, acc);
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
function collectOptionalLengthGates(
  body: PsdlPacket["body"],
  fields: RendererField[],
  defs: Record<string, NamedStruct> | undefined,
): RendererField[] {
  const sizers = new Set<string>();
  collectBytesSizers(body, defs, sizers);
  const out: RendererField[] = [];
  const seen = new Set<string>();
  const walk = (containers: Container[]): void => {
    for (const c of flattenForMirror(containers, defs)) {
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
function collectSiblingLengthControllers(
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
      );
    } else if (c.kind === "ref") {
      const def = defs?.[c.ref];
      if (def)
        collectSiblingLengthControllers(
          def.fields,
          defs,
          acc,
          ownedByRecordEditor,
          insideBounded,
          sizesByLenId,
        );
    } else if (c.kind === "group") {
      collectSiblingLengthControllers(
        c.children,
        defs,
        acc,
        ownedByRecordEditor,
        insideBounded,
        sizesByLenId,
      );
    } else if (c.kind === "optional") {
      collectSiblingLengthControllers(
        [c.container],
        defs,
        acc,
        ownedByRecordEditor,
        insideBounded,
        sizesByLenId,
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
function collectPlainRepeatLengthControllers(
  body: PsdlPacket["body"],
  fields: RendererField[],
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
          const def = defs?.[c.ref];
          if (def) collectLengthFields(def.fields);
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
            const def = defs?.[c.ref];
            if (def) gather(def.fields);
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
            const def = defs?.[c.ref];
            if (def) collectVirtuals(def.fields);
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
        // single inner peek-Switch to find it. Mirrors the `surfacedNestedTlv`
        // guard in collectFreeRepeats so only that same set of repeats qualifies,
        // and only when instantiable (a count control exists).
        const surfacedNestedTlv =
          isTlvRepeat(c) &&
          (insideSwitch || insideOptional) &&
          !insideRepeat &&
          !insideBounded;
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
        const def = defs?.[c.ref];
        if (def)
          visit(
            def.fields,
            insideBounded,
            insideSwitch,
            insideOptional,
            insideRepeat,
          );
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
): void {
  for (const c of containers) {
    if (isField(c)) {
      if (!acc.has(c.id)) acc.set(c.id, c);
      continue;
    }
    switch (c.kind) {
      case "group":
        collectAllFieldsById(c.children, defs, acc);
        break;
      case "bounded":
        collectAllFieldsById(c.fields, defs, acc);
        break;
      case "optional":
        collectAllFieldsById([c.container], defs, acc);
        break;
      case "repeat":
        collectAllFieldsById(c.element.fields, defs, acc);
        break;
      case "encrypted":
        collectAllFieldsById(c.plaintext.fields, defs, acc);
        break;
      case "switch":
        for (const s of Object.values(c.cases))
          collectAllFieldsById(s.fields, defs, acc);
        break;
      case "ref": {
        const def = defs?.[c.ref];
        if (def) collectAllFieldsById(def.fields, defs, acc);
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
function collectFlatTlvInnerLengthControllers(
  body: PsdlPacket["body"],
  fields: RendererField[],
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
        const def = defs?.[c.ref];
        if (def) findNestedBounded(def.fields);
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
function collectGroupNestedLengthControllers(
  body: PsdlPacket["body"],
  fields: RendererField[],
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
          const def = defs?.[c.ref];
          if (def) gatherSizers(def.fields);
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
        const def = defs?.[c.ref];
        if (def) walk(def.fields, insideGroup);
      }
      // Repeat / Switch / Optional / Bounded / Encrypted are deliberately NOT
      // descended: their internal length fields belong to other paths.
    }
  };
  walk(body, false);
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
function collectRepeatCountRefs(
  containers: Container[],
  defs: Record<string, NamedStruct> | undefined,
  acc: Set<string>,
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
        collectRepeatCountRefs(c.element.fields, defs, acc);
        break;
      }
      case "group":
        collectRepeatCountRefs(c.children, defs, acc);
        break;
      case "optional":
        collectRepeatCountRefs([c.container], defs, acc);
        break;
      case "bounded":
        collectRepeatCountRefs(c.fields, defs, acc);
        break;
      case "encrypted":
        collectRepeatCountRefs(c.plaintext.fields, defs, acc);
        break;
      case "switch":
        for (const struct of Object.values(c.cases))
          collectRepeatCountRefs(struct.fields, defs, acc);
        break;
      case "ref": {
        const def = defs?.[c.ref];
        if (def) collectRepeatCountRefs(def.fields, defs, acc);
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
function collectOptionalGateLengthControllers(
  body: PsdlPacket["body"],
  fields: RendererField[],
  defs: Record<string, NamedStruct> | undefined,
): string[] {
  const countRefs = new Set<string>();
  collectRepeatCountRefs(body, defs, countRefs);
  const stamped: string[] = [];
  const walk = (containers: Container[]): void => {
    for (const c of containers) {
      if (isField(c)) continue;
      if (c.kind === "optional") {
        const refs = new Set(exprRefs(c.when));
        for (const r of countRefs) refs.delete(r);
        if (refs.size === 1) {
          const x = [...refs][0];
          const target = fields.find((f) => f.id === x);
          if (
            target &&
            (target.category === "length" || target.controlsLength === x) &&
            !target.controlsLength &&
            !target.switchCases &&
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
        const def = defs?.[c.ref];
        if (def) walk(def.fields);
      }
    }
  };
  walk(body);
  return stamped;
}

/**
 * Collect dynamic-width (`varint` / delimiter-terminated `bytes`) leaf ids that
 * live inside a Switch case / Repeat element / Group / etc. and therefore never
 * surface as a top-level mirror `field`. `seedDynamicWidthDefaults` already
 * seeds the SAME default into the layout env so the cell renders at its
 * representative width, but `initialState` only walks `packet.fields` (+ their
 * subfields) and so never primes `controllers[leafId]` for these nested leaves.
 * The WidthPicker then falls back to `pickerWidths(target)[0]` (1 byte for
 * delimited) and lies about the live width on load. Surfacing the ids here lets
 * `initialState` seed `controllers[id]` to the same default the diagram uses, so
 * the picker's active option agrees with the rendered cell.
 *
 * Mirrors `seedDynamicWidthDefaults`' carve-outs: a leaf that is ALSO a
 * switch-`on:ref` discriminator overloads its env key for the case value (not a
 * width), so it is excluded. Ids already present as a mirror field / subfield
 * (top-level leaves, which `initialState`'s field loop already seeds) are
 * excluded by the caller.
 */
function collectNestedDynamicWidthLeaves(
  packet: PsdlPacket,
): NonNullable<RendererPacket["dynamicWidthLeaves"]> {
  const out: NonNullable<RendererPacket["dynamicWidthLeaves"]> = [];
  const seen = new Set<string>();
  const discriminators = collectSwitchOnRefIds(packet);
  const defs = packet.defs ?? {};
  const seenRefs = new Set<string>();
  const add = (
    id: string,
    kind: "delimited" | "varint" | "berLength",
  ): void => {
    if (discriminators.has(id) || seen.has(id)) return;
    seen.add(id);
    out.push({ id, kind });
  };
  const visit = (containers: Container[]): void => {
    for (const c of containers) {
      if (isField(c)) {
        if (c.type.kind === "varint") add(c.id, "varint");
        else if (c.type.kind === "berLength") add(c.id, "berLength");
        else if (c.type.kind === "bytes" && isBytesDelimited(c.type.n)) {
          add(c.id, "delimited");
        }
        continue;
      }
      switch (c.kind) {
        case "group":
          visit(c.children);
          break;
        case "repeat":
          visit(c.element.fields);
          break;
        case "switch":
          for (const s of Object.values(c.cases)) visit(s.fields);
          break;
        case "encrypted":
          visit(c.plaintext.fields);
          break;
        case "optional":
          visit([c.container]);
          break;
        case "bounded":
          visit(c.fields);
          break;
        case "ref": {
          const def = defs[c.ref];
          if (def && !seenRefs.has(c.ref)) {
            seenRefs.add(c.ref);
            visit(def.fields);
            seenRefs.delete(c.ref);
          }
          break;
        }
      }
    }
  };
  visit(packet.body);
  return out;
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
      // A top-level Group whose children are all leaf fields collapses to a
      // single subfield-bearing renderer field. When it NESTS a further Group
      // (pppoe's `pppoeHeader` nests `verType`), `groupToSubfieldField` bails
      // and returns null — which would drop the entire group, and with it any
      // bounded-length controller subfield (pppoe's `payloadLength`, the sole
      // control over the `pppoeTagList` payload). Fall back to the deep collapse
      // so nested-group leaves stay reachable as flat subfields; the lift path
      // is unaffected because merge-based lift walks the SOURCE tree.
      const flat = groupToSubfieldField(c) ?? groupToSubfieldFieldDeep(c);
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
  // A top-level `bounded` scope whose inner repeat is TLV-shaped has already
  // been lifted to a `tlv` field above; the TLV editor (add/remove records) is
  // the intended control for that region and the byte budget follows the
  // instances. Surfacing the bounded's single-ref length field ALSO as a
  // `controlsLength` slider would let the user inflate the diagram's byte
  // counter by tens of bytes while ZERO new cells appear (ipv4 `ihl`, tcp
  // `dataOffset`, ipv6Destination `hdrExtLen`, tlsClientHelloFull
  // `extensionsLen`) — a misleading control fighting the TLV editor for the
  // same region. Exclude those controllers.
  const tlvOwnedControllers = new Set<string>();
  collectTlvOwnedBoundedControllers(
    packet.body,
    packet.defs,
    tlvOwnedControllers,
  );
  const lengthControllers: RendererField[] = [];
  for (const fromId of boundedControllers) {
    if (tlvOwnedControllers.has(fromId)) continue;
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
  // Optional-wrapped length octets that both gate AND size a trailing variable
  // field (rtcpBye's `rtcpByeHasReason`) never become top-level cells, so their
  // diagram cell is otherwise see-but-cannot-edit. Surface them as packet-level
  // length controllers (deduped against the bounded ones above).
  for (const lc of collectOptionalLengthGates(
    packet.body,
    fields,
    packet.defs,
  )) {
    if (!lengthControllers.some((existing) => existing.id === lc.id)) {
      lengthControllers.push(lc);
    }
  }
  // A plain `length` cell that directly sizes a sibling `bytes(ref <thisId>)`
  // payload (or a sibling single-ref `bounded.bytes` scope) but lives inside a
  // Switch case is neither a top-level renderer cell nor a Group subfield, so
  // neither the constraint path nor the bounded-controller path above can stamp
  // it. Both the length cell AND the payload it measures would render read-only
  // (ancp `ancpAdjTotalLength` → `ancpCapabilities`; oncRpc `credLength`/
  // `verfLength` → `credBody`/`verfBody`). Surface each as a packet-level length
  // controller keyed on `env[thisId]` so the user gets the same slider as IHL.
  const siblingLengthFields = new Map<string, PsdlField>();
  // length-field id → value field ids it sizes (`bytes(ref <lenId>)`). Used to
  // tag each sibling length controller with the values whose width it drives, so
  // OverridePanel can keep the slider live ONLY while one of those values is in
  // the diagram (pimHelloOptLen sizes addrListData/optUnknown — both inside a
  // switch arm — but its Length octet renders in EVERY option arm).
  const siblingSizesByLenId = new Map<string, Set<string>>();
  collectSiblingLengthControllers(
    packet.body,
    packet.defs,
    siblingLengthFields,
    false,
    false,
    siblingSizesByLenId,
  );
  const controllerIds = new Set<string>(lengthControllers.map((lc) => lc.id));
  // A length field that is ALSO a repeat-count ref (msdp `msdpSAEntryCount`:
  // `repeat msdpSAEntries count:ref(msdpSAEntryCount)` AND
  // `msdpSAEncapData = bytes(msdpLength-8-12*msdpSAEntryCount)`) is already the
  // freeRepeat 'SA Entries' add/remove stepper's key. Surfacing it ALSO as a
  // sibling length controller would put TWO independent panel controls — a
  // record stepper and a byte-length slider — on the SAME env key in different
  // sections, fighting over it: moving the slider silently changes the record
  // count and vice-versa, and one 'length' slider would simultaneously ADD
  // 12-byte records and SHRINK the encap region (the `-12*count` term). The
  // record stepper is the correct single control; the encap width then follows
  // the count, like any budget-derived length. Skip the length controller for
  // such ids (the only collision across the 184 presets is msdp). Built the
  // same way collectOptionalGateLengthControllers builds its count-ref set.
  const repeatCountRefs = new Set<string>();
  collectRepeatCountRefs(packet.body, packet.defs, repeatCountRefs);
  for (const [id, field] of siblingLengthFields) {
    if (repeatCountRefs.has(id)) continue;
    const sizedValueIds = siblingSizesByLenId.get(id);
    const lengthSizesFieldIds =
      sizedValueIds && sizedValueIds.size > 0 ? [...sizedValueIds] : undefined;
    // When the length field IS an existing top-level mirror cell (quicLong
    // dcidLength/scidLength, mqttConnect protocolNameLength/clientIdLength, arp
    // hlen/plen, ...) it surfaces as a plain length cell with NO widget — the
    // sized `bytes(ref <id>)` value is VISIBLE on the diagram but read-only.
    // Stamp `controlsLength` onto that existing cell so OverridePanel renders
    // the same length slider IHL / Data Offset get, mirroring how the
    // constraint-driven and bounded-controller paths stamp an existing target.
    const target = fields.find((f) => f.id === id);
    if (target) {
      // Don't steal a cell that already drives the diagram another way: a
      // discriminator (switchCases / enumVariants) or an already-stamped
      // length controller keeps its existing widget.
      if (
        !target.controlsLength &&
        !target.switchCases &&
        !target.enumVariants
      ) {
        target.controlsLength = id;
        if (target.bits != null) {
          target.max = Math.max(target.max ?? 0, 2 ** target.bits - 1);
        }
        if (lengthSizesFieldIds) {
          target.lengthSizesFieldIds = lengthSizesFieldIds;
        }
      }
      continue;
    }
    // The length field is a Group subfield: it can't host its own slider, so a
    // representative packet-level controller is surfaced (same as a subfield in
    // the bounded path). Otherwise it lives inside a Switch case (ancp / oncRpc)
    // and is neither a cell nor a subfield, so it likewise needs a packet-level
    // controller. In both cases skip if one was already pushed for this id.
    if (controllerIds.has(id)) continue;
    const bits = typeBits(field.type);
    controllerIds.add(id);
    lengthControllers.push({
      id,
      name: field.name ?? id,
      bits,
      controlsLength: id,
      max: bits > 0 ? 2 ** bits - 1 : undefined,
      defaultValue: field.defaultValue,
      ...(lengthSizesFieldIds ? { lengthSizesFieldIds } : {}),
    });
  }
  // A Group-nested `length` field that sizes a VISIBLE `bytes(ref X)` cell in a
  // DIFFERENT scope (geneve `optLen`→`options`, nsh `nshLength`→
  // `nshContextHeaders`, pgm `pgmTsduLength`→`pgmOdataData`, ipinip
  // `innerTotalLength`/`innerIhl`→`innerPayload`) becomes a renderer subfield, so
  // it can't host its own slider; the sized cell is a sibling of the GROUP, not
  // of the field, so the direct-sibling path above never matches it. Surface
  // each as a packet-level length controller so the variable region the user
  // sees becomes drivable (deduped against the controllers emitted above).
  for (const lc of collectGroupNestedLengthControllers(
    packet.body,
    fields,
    packet.defs,
  )) {
    if (!controllerIds.has(lc.id)) {
      controllerIds.add(lc.id);
      lengthControllers.push(lc);
    }
  }
  // A VISIBLE top-level `length` cell whose value is the SOLE non-loop ref in an
  // `optional.when` budget that materialises the rest of the packet (rtcpBye's
  // `length` gating `rtcpByeHasReason`→`rtcpByeReason`) is reached by NONE of the
  // collectors above: it sizes nothing via `bytes(ref …)`, is no `bounded.bytes`
  // ref, and lives OUTSIDE the optional it drives. Without a control the user can
  // SEE the Length cell grow the diagram but has no working knob to reveal the
  // gated tail. Stamp `controlsLength` onto that existing cell so OverridePanel
  // renders the same slider IHL / Data Offset get; the cell is always present so
  // its `fieldRendered` live gate keeps the slider live.
  for (const id of collectOptionalGateLengthControllers(
    packet.body,
    fields,
    packet.defs,
  )) {
    controllerIds.add(id);
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
    collectFreeRepeats(packet, fields);
  const peekSwitches = collectPeekSwitches(packet.body, packet.defs);
  // A per-record `length` field stranded inside a PLAIN instantiable repeat
  // (dnsResponse `dnsRdLength`, pimHelloOptions `pimHelloOptLen`) has no editor
  // to own it — the constraint / bounded / switch-case / sibling paths all miss
  // it because the `insideRepeat` guard assumes a TLV/chain editor does. Surface
  // each as a packet-level length controller so the refSwitch arms it sizes
  // (NS/CNAME/PTR/TXT RDATA, the Address-List option value) become drivable
  // instead of rendering an empty, identical diagram. Must run AFTER
  // collectFreeRepeats so `instantiableRepeatIds` is known, and BEFORE the
  // `controlledIds` set below so collectRefSwitches stops treating those arms as
  // permanently zero-width.
  for (const lc of collectPlainRepeatLengthControllers(
    packet.body,
    fields,
    instantiableRepeatIds,
    packet.defs,
  )) {
    if (!lengthControllers.some((existing) => existing.id === lc.id)) {
      lengthControllers.push(lc);
    }
  }
  // The per-record length field of a flat-TLV bounded repeat (stun `stunAttrLen`,
  // bgpOpen `parmLen`, …) is stranded inside the bounded scope so every collector
  // above skips it — yet its value cell renders at a seeded width and is a
  // genuine independent knob. Surface each as a packet-level length controller so
  // the user can change the size of the value they see. Driven off the bounded
  // repeats' `innerScopeSeeds`, computed just above.
  for (const lc of collectFlatTlvInnerLengthControllers(
    packet.body,
    fields,
    boundedRepeats,
    packet.defs,
  )) {
    if (!lengthControllers.some((existing) => existing.id === lc.id)) {
      lengthControllers.push(lc);
    }
  }
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
  // Dynamic-width leaves nested inside switch cases / repeats / groups, minus
  // any already surfaced as a mirror field or subfield (those are seeded by
  // `initialState`'s field loop). The remainder need their own `initialState`
  // seed so the WidthPicker's active option matches the seeded diagram cell.
  const mirrorLeafIds = new Set<string>();
  for (const f of fields) {
    mirrorLeafIds.add(f.id);
    for (const sf of f.subfields ?? []) mirrorLeafIds.add(sf.id);
  }
  const dynamicWidthLeaves = collectNestedDynamicWidthLeaves(packet).filter(
    (leaf) => !mirrorLeafIds.has(leaf.id),
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
    ...(dynamicWidthLeaves.length > 0 ? { dynamicWidthLeaves } : {}),
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
        // Only a NUMERIC repeat count drives a byte budget. A `{ until: Expr }`
        // terminator is a record-terminator PREDICATE (e.g. rtcpSdes's
        // `until: rtcpSdesItemType == 0`), not a length — its refs must NOT be
        // treated as length/format encoders, or the switch discriminated on that
        // same field (rtcpSdesItemBody on rtcpSdesItemType) would be wrongly
        // dropped from refSwitches, leaving the SDES item body see-but-cannot-edit.
        if (
          c.count !== "eos" &&
          !(typeof c.count === "object" && "until" in c.count)
        ) {
          refsIn(c.count, acc);
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

/** Map each field id to its declared `defaultValue` (the value `initialEnv`
 *  seeds the env with). Used to order a surfaced refSwitch's cases so the case
 *  matching the discriminator's declared default comes FIRST: `initialState`
 *  seeds `env[refKey] = cases[0].value`, which must AGREE with the author's
 *  declared default (pgm `pgmType` defaults to 4 = ODATA) — otherwise the load
 *  diagram would silently switch to a different arm (cases[0]=SPM) and contradict
 *  the packet's intended default. Fields without an explicit default have no
 *  entry. */
function collectFieldDefaults(body: PsdlPacket["body"]): Map<string, number> {
  const out = new Map<string, number>();
  const visit = (containers: PsdlPacket["body"]): void => {
    for (const c of containers) {
      if (isField(c)) {
        if (typeof c.defaultValue === "number") out.set(c.id, c.defaultValue);
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
 * Subset of `collectVirtualIds`: virtual ids whose `expr` is a bare SELF-ref
 * (`{ kind: "ref", field: <own id> }`). Unlike a literal-valued virtual (which
 * normalize recomputes to a fixed value every render, clobbering any override),
 * a self-ref virtual's value is `env[id]` itself: walkVirtual evaluates
 * `eval(ref(id))` (via `evalExprOr`, fallback 0 when unset) and writes it back
 * unchanged — so seeding `env[id]` from a surfaced count stepper SURVIVES the
 * recompute and drives the diagram. These ids may therefore back a real
 * (drivable) freeRepeat count, so the ref-count collector exempts them from the
 * blanket virtual suppression. (kerberosAsReq's `padataCount`, rewritten to a
 * self-ref seed by the preset adapter so its visible PA-DATA list gets an
 * add/remove control.)
 */
function collectSelfRefVirtualIds(
  body: PsdlPacket["body"],
  defs: Record<string, NamedStruct> | undefined,
): Set<string> {
  const out = new Set<string>();
  const seenDefs = new Set<string>();
  const visit = (containers: PsdlPacket["body"]): void => {
    for (const c of containers) {
      if (isField(c)) continue;
      if (c.kind === "virtual") {
        if (c.expr.kind === "ref" && c.expr.field === c.id) out.add(c.id);
      } else if (c.kind === "bounded") visit(c.fields);
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
 * When `switchArmsAllZeroWidth` would suppress a picker, decide whether the
 * collapse is caused EXCLUSIVELY by uncontrolled PER-RECORD sibling length
 * fields (declared inside the switch cases / repeat element, like isisLsp's
 * `tlvLength`). If so, return those length-field ids: instead of suppressing the
 * picker we surface it AND seed those lengths to a representative width, so the
 * chosen arm's `bytes(ref length)` value becomes visible and editable (the
 * KNOWN-REMAINING #7/#8 fix). Returns null when seeding cannot rescue the
 * picker — an empty arm, a fixed-width/visible arm (the picker is already live,
 * not collapsed), or a `bytes` length ref that is NOT a per-record sibling (a
 * top-level field that has its own surfacing path, or an expr we shouldn't
 * blindly seed) — so the existing suppression still applies in those cases.
 */
function switchArmsZeroWidthSiblingLengths(
  cases: Record<string, { fields: Container[] }>,
  controlledIds: Set<string>,
  perRecordFieldIds: Set<string>,
): Set<string> | null {
  const lengths = new Set<string>();
  const armLengths = (containers: Container[]): Set<string> | null => {
    // An empty arm distinguishes nothing and can't be rescued by a length seed.
    if (containers.length === 0) return null;
    const out = new Set<string>();
    for (const c of containers) {
      if (!isField(c)) return null; // nested container: not a simple value arm
      if (c.type.kind !== "bytes") return null; // fixed-width: already visible
      const n = c.type.n;
      if (isBytesDelimited(n)) return null; // seeded elsewhere (visible default)
      const refs = exprRefs(n);
      if (refs.length === 0) return null; // not sibling-ref sized
      for (const r of refs) {
        if (controlledIds.has(r)) return null; // already controllable → not inert
        // Only a single per-record sibling length is safe to seed; anything else
        // (a top-level uncontrolled field, an unknown id) we leave suppressed.
        if (!perRecordFieldIds.has(r)) return null;
        out.add(r);
      }
    }
    return out;
  };
  const arms = Object.values(cases);
  if (arms.length === 0) return null;
  for (const s of arms) {
    const armOut = armLengths(s.fields);
    if (armOut === null) return null;
    for (const id of armOut) lengths.add(id);
  }
  return lengths.size > 0 ? lengths : null;
}

/**
 * The MIXED-width counterpart of `switchArmsZeroWidthSiblingLengths`. A picker
 * is NOT suppressed (it has at least one fixed-width / visible arm, so
 * `switchArmsAllZeroWidth` already returns false), yet SOME of its arms still
 * collapse to width 0 because they are a single `bytes(ref <siblingLen>)` value
 * whose per-record length defaults to 0 (dnsResponse's `dnsRdata`: A/AAAA/MX/
 * SRV/SOA are fixed-width and visible, but NS/CNAME/PTR/TXT and the `_` raw arm
 * are each `bytes(ref dnsRdLength)`). Selecting one of those collapsed arms at
 * the default env renders an EMPTY record — the picker contradicts the diagram
 * even though the discriminator genuinely drives the visible arms (#11/#12).
 *
 * Collect the per-record sibling length ids consumed ONLY by the width-0 arms,
 * skipping (not bailing on) the fixed-width / visible / nested-container arms.
 * The caller seeds those lengths to a representative width so EVERY selectable
 * arm — not just the fixed-width ones — renders at load. Returns null when no
 * collapsed arm is rescuable this way (no collapsed `bytes(ref <perRecordLen>)`
 * arm exists, or a collapsed arm's length ref is not a per-record sibling we can
 * safely seed — leaving the picker-as-is, since the fixed-width arms still drive
 * the diagram). Seeds fill only unset/0 env, so a user-set width still wins.
 */
function switchArmsMixedCollapsedSiblingLengths(
  cases: Record<string, { fields: Container[] }>,
  perRecordFieldIds: Set<string>,
): Set<string> | null {
  const lengths = new Set<string>();
  // Per-arm: returns the set of seedable per-record sibling lengths if this arm
  // collapses to width-0 `bytes(ref siblingLen)` values, `null` if it is a
  // VISIBLE / fixed-width / nested / not-rescuable arm we should simply skip.
  const armCollapsedLengths = (containers: Container[]): Set<string> | null => {
    if (containers.length === 0) return null; // empty arm: nothing to seed
    const out = new Set<string>();
    for (const c of containers) {
      if (!isField(c)) return null; // nested container: assume visible — skip
      if (c.type.kind !== "bytes") return null; // fixed-width: already visible
      const n = c.type.n;
      if (isBytesDelimited(n)) return null; // seeded elsewhere (visible default)
      const refs = exprRefs(n);
      if (refs.length === 0) return null; // not sibling-ref sized
      for (const r of refs) {
        // Only a real PER-RECORD sibling length is safe to seed (a representative
        // width on the record's own length field, not a shared top-level one).
        // Unlike the all-zero-width rescue, a CONTROLLED length ref does NOT bail
        // here: dnsRdLength is surfaced as a lengthController (so the picker isn't
        // strictly inert — the user CAN reveal the arm), yet at the default env it
        // is 0 and the collapsed arm still shows nothing. Seeding it (only when
        // unset/0, so a user width still wins) is exactly what makes the picker
        // agree with the diagram on load.
        if (!perRecordFieldIds.has(r)) return null;
      }
      for (const r of refs) out.add(r);
    }
    return out;
  };
  for (const s of Object.values(cases)) {
    const armOut = armCollapsedLengths(s.fields);
    if (armOut === null) continue; // visible / non-rescuable arm: skip, don't bail
    for (const id of armOut) lengths.add(id);
  }
  return lengths.size > 0 ? lengths : null;
}

/**
 * Distinguish a length-EXTENSION encoder (a sub-byte nibble/flag whose arms only
 * tack a length-extension field onto an already-being-decoded length — CoAP's
 * `byOptDelta`/`byOptLength` 13/14 sentinels, BGP's `bgpAttrLengthByExt`
 * extended-length flag) from a genuine VARIANT SELECTOR (a sub-byte
 * discriminator that picks WHICH substantive cells render — lwm2mRegister's
 * `byIdLen` choosing the 8- vs 16-bit Identifier, `byTypeOfLength` choosing the
 * Length-field width and the short-vs-explicit Value layout).
 *
 * Driving a length encoder desyncs the encoded length / over-consumes a bounded
 * scope, so those stay suppressed (they have no `controlsLength`-free meaning).
 * But a variant selector genuinely changes the user-visible record skeleton, so
 * suppressing it leaves a see-but-cannot-edit gap. The signal: a pure
 * length-extension encoder's every non-empty arm consists SOLELY of
 * `category: "length"` fields (the extension bytes). The moment any arm carries a
 * non-length substantive field (an `identifier`, a `variable` Value, …) the
 * switch is choosing a record variant, not merely extending a length.
 */
function subByteDiscriminatorSelectsVariant(
  cases: Record<string, { fields: Container[] }>,
): boolean {
  const armIsLengthOnly = (containers: Container[]): boolean => {
    // An empty arm contributes no substantive field — treat as length-only so a
    // lone empty arm can't masquerade as a variant.
    for (const c of containers) {
      // A nested container (group/switch/repeat/…) is structural content the
      // discriminator selects between — that is a variant, not a length nibble.
      if (!isField(c)) return false;
      if (c.category !== "length") return false;
    }
    return true;
  };
  return Object.values(cases).some((s) => !armIsLengthOnly(s.fields));
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
 * the case picker is inert. Catches tlsHandshake `handshakeType` (10 arms, each
 * a single `bytes(ref tlsHandshakeBodyLen)` opaque body), which
 * `attachOverrideMetadata` would otherwise stamp as a multi-option `switchCases`
 * dropdown that can never change the diagram. Requires ≥ 2 selectable arms: a
 * single-arm switch is a degenerate (non-multi-option) picker left untouched.
 *
 * The default (`_`) arm IS folded into the comparison: while it is not itself a
 * user-selectable value, an unlisted discriminator value falls into it, so a
 * structurally-DIFFERENT `_` arm means the diagram visibly gains/loses fields as
 * the discriminator changes. We suppress here only when the `_` arm's shape ALSO
 * equals the selectable arms' shape. tlsHandshake / snmpV2c stay suppressed
 * (their `_` arm is the same opaque `bytes(ref …)` body).
 *
 * NOTE: for a FIELD-LEVEL `switchCases` picker (no synthetic `_`-reaching
 * option), an all-identical LISTED-arm set is inert even when the `_` arm
 * differs, because the dropdown can never offer a `_`-reaching value — that
 * stronger gate is `listedArmsAllIdentical` (eap's `eapCode`), applied below.
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
  if (!shapes.every((s) => s === shapes[0])) return false;
  // A present `_` default arm must match the selectable shape too: otherwise an
  // out-of-list discriminator value renders a structurally different layout and
  // the picker meaningfully drives the diagram.
  const defaultArm = cases["_"];
  if (defaultArm) {
    const defaultShape = JSON.stringify(defaultArm.fields.map(structuralShape));
    if (defaultShape !== shapes[0]) return false;
  }
  return true;
}

/**
 * Like `switchArmsAllIdentical`, but considers ONLY the LISTED (user-selectable)
 * arms — it does NOT fold the `_` default arm into the comparison. Returns true
 * when every selectable arm is mutually structurally identical, regardless of
 * whether a present `_` arm differs.
 *
 * This is the inert-ness test for a FIELD-LEVEL `switchCases` picker. Unlike a
 * surfaced ref/peek Switch — for which `defaultArmSyntheticCase` can synthesise
 * an extra option that reaches a structurally-distinct `_` arm — a field-level
 * `switchCases` dropdown only ever offers the LISTED case values; it can never
 * select the `_` arm. So if those listed arms are all identical, the dropdown is
 * inert (no listed value changes the diagram) even when the `_` arm differs, and
 * surfacing it is a see-but-cannot-edit / surface-collision control.
 *
 * eap's `eapCode` is the sole preset field this catches: its listed arms 1
 * (Request) / 2 (Response) are byte-identical (`eapType` + `eapTypeData`), while
 * its `_` arm `eapNoBody` is EMPTY. Codes 3 / 4 (Success / Failure) fall into
 * `_` and drop the body — but those values are NOT in the switch's case list, so
 * the switch dropdown (offering only 1 / 2) can never reach them. `eapCode` is
 * ALSO an `enum(8)` discriminator covering 1–4, and that EnumDropdown — writing
 * the same `env[eapCode]` key — already drives every meaningful state (including
 * the empty `_` body at 3 / 4). The switch picker therefore adds nothing but an
 * inert, raw-labelled control fighting the enum for one key; suppress it.
 */
function listedArmsAllIdentical(
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

/**
 * When a surfaced ref/peek Switch carries a `_` default arm whose structural
 * shape differs from EVERY listed (selectable) case, return a synthetic picker
 * option that reaches it: a sentinel discriminator value (not covered by any
 * listed key, so core's `selectArm` falls through to `_`) plus a "default"
 * label. Otherwise `null` — the `_` arm is absent, or it renders the same
 * skeleton as a listed case, so no extra option is warranted.
 *
 * Without this, a switch whose lone listed case is structurally distinct from
 * the `_` arm (babel `babelTlvBody`: listed `0` is the empty Pad1, `_` is the
 * real TLV-with-body, the common case; bgpFlowSpec `flowSpecCompValue`: listed
 * `1,2` is a prefix, `_` is the numeric-operator list used by most RFC 8955
 * component types; rohcUncompressed `rohcHeader` peek: listed `126` is the IR
 * Packet, `_` is the normal datagram) offers ONLY the listed value(s) and can
 * never select the `_`-arm layout — an inert/misleading control AND a
 * representability gap for imported packets whose discriminator falls into `_`.
 * Mirrors the peek-gated-optional "(absent)" synthetic-case pattern.
 */
function defaultArmSyntheticCase(
  cases: Record<string, Struct>,
): { value: number; label: string } | null {
  const defaultArm = cases["_"];
  if (!defaultArm) return null;
  const listed = Object.entries(cases).filter(
    ([key]) => firstCaseKeyValue(key) !== null,
  );
  if (listed.length === 0) return null;
  const defaultShape = JSON.stringify(defaultArm.fields.map(structuralShape));
  const differsFromAll = listed.every(
    ([, struct]) =>
      JSON.stringify(struct.fields.map(structuralShape)) !== defaultShape,
  );
  if (!differsFromAll) return null;
  const value = defaultArmSentinel(listed.map(([key]) => key));
  return {
    value,
    label: defaultArm.name ?? prettifyId(defaultArm.id) ?? "Other (default)",
  };
}

/**
 * True when a switch's `_` default arm is the canonical TLV-style
 * "opaque / unknown record" shape: a SINGLE field carrying a `bytes(ref …)`
 * value (the raw, ref-length-sized payload of a record whose type code is not
 * individually modelled — dnsResponse `dnsRdataBytes` = `bytes(ref dnsRdLength)`,
 * isisLsp `tlvValue` = `bytes(ref tlvLength)`, pimHelloOptions `unknownOptData` =
 * `bytes(ref pimHelloOptLen)`).
 *
 * Such a `_` arm is a real, RFC-defined REACHABLE state — any discriminator
 * value not in the listed case set decodes the record opaquely — yet its
 * structural fingerprint is byte-identical to any listed arm that is also a lone
 * `bytes(ref …)` value (every isisLsp arm; dnsResponse's NS/CNAME/PTR/TXT). The
 * `differs`-from-all-listed gate that drives the synthetic-default option for
 * structurally-distinct arms (babel/bgpFlowSpec) therefore wrongly suppresses
 * it, so an unknown record type is unrepresentable and an imported packet
 * carrying one cannot round-trip-select. Detecting this shape lets the caller
 * surface a sentinel "unknown / other" option EVEN WHEN the `_` shape collides
 * with a listed arm — the selection lands on an unlisted code, which is a
 * genuinely distinct, RFC-valid state. (A nested-container or fixed-width `_`
 * arm is not "opaque/unknown" and stays governed by the `differs` gate.)
 */
function isOpaqueUnknownRecordArm(arm: { fields: Container[] }): boolean {
  if (arm.fields.length !== 1) return false;
  const only = arm.fields[0];
  if (!isField(only)) return false;
  if (only.type.kind !== "bytes") return false;
  const n = only.type.n;
  if (isBytesDelimited(n)) return false;
  return exprRefs(n).length > 0;
}

/** Collect (in declaration order) the ids of every Field declared anywhere
 *  inside an arm's container list. Used to canonicalize intra-arm references so
 *  arms that differ ONLY in their field ids fingerprint identically. */
function collectArmFieldIds(containers: Container[]): string[] {
  const ids: string[] = [];
  const walk = (cs: Container[]): void => {
    for (const c of cs) {
      if (isField(c)) {
        ids.push(c.id);
        continue;
      }
      switch (c.kind) {
        case "switch":
          for (const struct of Object.values(c.cases)) walk(struct.fields);
          break;
        case "repeat":
          walk(c.element.fields);
          break;
        case "group":
          walk(c.children);
          break;
        case "optional":
          walk([c.container]);
          break;
        case "bounded":
          walk(c.fields);
          break;
        case "encrypted":
          walk(c.plaintext.fields);
          break;
      }
    }
  };
  walk(containers);
  return ids;
}

/**
 * Like `switchArmsAllIdentical`, but tolerant of arms that differ ONLY in the
 * field ids they declare AND in the intra-arm references that target those ids.
 * snmpV2c's `pduSwitch` has 8 selectable PDU-type arms, each the same
 * `int(8) + berLength + (int(8) + berLength + bytes(ref <siblingLen>)) × 4`
 * shape; the arms diverge only because every field id and every `bytes(ref …)`
 * length-ref is per-arm renamed (`requestIdLengthGR` vs `requestIdLengthGB` …).
 * `structuralShape` keeps the raw ref strings, so `switchArmsAllIdentical`
 * reports them as different — yet each ref points to a sibling `berLength`
 * INSIDE the same arm with no override control, so every arm resolves to the
 * SAME geometry for every reachable env: the picker is inert.
 *
 * We canonicalize each intra-arm reference to its referent's declaration index
 * (`#0`, `#1`, …) before fingerprinting. A ref to a field OUTSIDE the arm (a
 * real, potentially user-controlled discriminator) is left intact, so a picker
 * whose arms genuinely diverge stays surfaced. Requires ≥ 2 selectable arms;
 * the `_` default is excluded (not user-selectable).
 */
function switchArmsRenderIdentical(
  cases: Record<string, { fields: Container[] }>,
): boolean {
  const selectable = Object.entries(cases).filter(
    ([key]) => firstCaseKeyValue(key) !== null,
  );
  if (selectable.length < 2) return false;
  const fingerprintArm = (containers: Container[]): string => {
    const canon = new Map<string, string>();
    collectArmFieldIds(containers).forEach((id, i) => canon.set(id, `#${i}`));
    // Replace any intra-arm ref id inside an Expr-bearing structure with its
    // canonical positional token, leaving non-arm refs untouched.
    const rewrite = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(rewrite);
      if (node && typeof node === "object") {
        const obj = node as Record<string, unknown>;
        if (obj.kind === "ref" && typeof obj.field === "string") {
          const mapped = canon.get(obj.field);
          if (mapped) return { kind: "ref", field: mapped };
        }
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) out[k] = rewrite(v);
        return out;
      }
      return node;
    };
    return JSON.stringify(rewrite(containers.map(structuralShape)));
  };
  const shapes = selectable.map(([, struct]) => fingerprintArm(struct.fields));
  return shapes.every((s) => s === shapes[0]);
}

/**
 * True when a Switch's selectable arms render to the SAME geometry
 * (`switchArmsRenderIdentical`) yet carry DISTINCT human-readable NAMES — so the
 * only thing a value selection changes is the visible label of the cell, not its
 * bytes. `switchArmsAllIdentical` / `switchArmsRenderIdentical` ignore names and
 * would report such a picker as inert and suppress it, but the diagram cell's
 * NAME genuinely changes per arm (a real, user-visible semantic edit), so the
 * picker must be surfaced anyway.
 *
 * QUIC's `frameByType` is exactly this: its arms 6 (CRYPTO Data) / 2,3 (ACK
 * Ranges) / 8-15 (Stream Data) / _ (Frame Payload) are all a single `bits:128`
 * body differing only by field id and NAME. In semantic view `resolveLayout`
 * draws the selected frame body and its NAME (the user clearly SEES the variant),
 * yet without this the discriminator `frameType` gets no override surface — a
 * see-but-cannot-edit gap. Mirrors the snmpV2c `pduSwitch` precedent (its 8
 * PDU-type arms differ only by name and are surfaced so the user can label the
 * PDU).
 *
 * Requires ≥ 2 selectable arms with at least two distinct names; otherwise the
 * picker would be a single-option / truly-inert control left suppressed.
 */
function switchArmsDifferByNameOnly(cases: Record<string, Struct>): boolean {
  if (!switchArmsRenderIdentical(cases)) return false;
  const selectable = Object.entries(cases).filter(
    ([key]) => firstCaseKeyValue(key) !== null,
  );
  // The label a surfaced picker would show for each arm — exactly what the
  // diagram cell's name resolves to (the arm's own name, else its sole field's
  // name, else a prettified id). If two arms produce different labels, selecting
  // between them visibly relabels the diagram.
  const labelOf = (struct: Struct): string => {
    if (struct.name) return struct.name;
    const onlyField = struct.fields.length === 1 ? struct.fields[0] : undefined;
    if (onlyField && isField(onlyField) && onlyField.name)
      return onlyField.name;
    return prettifyId(struct.id) ?? struct.id;
  };
  const labels = selectable.map(([, struct]) => labelOf(struct));
  return new Set(labels).size >= 2;
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

/** Collect the ids of every field declared (transitively) INSIDE a `group`
 *  that is itself NOT inside a `switch` case and NOT inside a `repeat` — i.e. a
 *  flags / header Group spliced inline at the top level (dccp's `flagsGroup`
 *  holding the `x` bit; lisp's `lispFlags` holding lispV/lispI/lispN).
 *  `flattenForMirror` does NOT descend into groups, so such a field is never a
 *  top-level renderer-mirror cell and `attachOverrideMetadata` can't stamp a
 *  `switchCases` / `enumVariants` widget on it. A TOP-LEVEL `switch`
 *  discriminated on one of these (dccp's `seqNum` on `x`; lisp's `byLispV` on
 *  `lispV`) therefore falls through every field-anchored path AND the
 *  switch-case-nested path — a see-but-cannot-edit gap — so it needs a
 *  packet-level refSwitch picker, exactly like `collectSwitchCaseFieldIds`.
 *  Fields inside a repeat (the records get their own count / TLV / chain
 *  surface) or inside a switch case (already handled by
 *  `collectSwitchCaseFieldIds`) are deliberately excluded. */
function collectGroupNestedFieldIds(
  body: PsdlPacket["body"],
  defs: Record<string, NamedStruct> | undefined,
): Set<string> {
  const acc = new Set<string>();
  // `insideGroup` flips true once we step into a group; `blocked` flips true
  // once we enter a repeat or a switch case, which permanently disqualifies
  // everything below (those scopes have their own override surfaces).
  const visit = (
    containers: Container[],
    insideGroup: boolean,
    blocked: boolean,
  ): void => {
    for (const c of flattenForMirror(containers, defs)) {
      if (isField(c)) {
        if (insideGroup && !blocked) acc.add(c.id);
        continue;
      }
      if (c.kind === "group") {
        visit(c.children, true, blocked);
        continue;
      }
      if (c.kind === "switch") {
        for (const struct of Object.values(c.cases))
          visit(struct.fields, insideGroup, true);
        continue;
      }
      if (c.kind === "repeat") {
        visit(c.element.fields, insideGroup, true);
        continue;
      }
      if (c.kind === "optional") {
        visit([c.container], insideGroup, blocked);
        continue;
      }
      if (c.kind === "encrypted") {
        visit(c.plaintext.fields, insideGroup, blocked);
        continue;
      }
    }
  };
  visit(body, false, false);
  return acc;
}

/** Collect the ids of every field declared (transitively) inside an `encrypted`
 *  block's plaintext that is itself NOT inside a `switch` case and NOT inside a
 *  `repeat` — i.e. a discriminator declared in an encrypted plaintext the engine
 *  renders INLINE (a header-protected scope with no fixed `wireBits`, e.g. a
 *  hypothetical decrypted-header field switch). `flattenForMirror` does NOT
 *  expose an encrypted-plaintext field as a top-level renderer-mirror cell, so
 *  `attachOverrideMetadata` can't stamp a `switchCases` widget on it, and
 *  `collectSwitchCaseFieldIds` / `collectGroupNestedFieldIds` deliberately
 *  exclude it (it is in neither a switch case nor a group). A switch
 *  discriminated on one of these therefore falls through every field-anchored
 *  path AND the switch-case / group paths — a see-but-cannot-edit gap — so it
 *  needs a packet-level refSwitch picker, exactly like the group-nested path.
 *  Mirrors `collectGroupNestedFieldIds`: fields inside a repeat (records get
 *  their own surface) or inside a switch case (handled by
 *  `collectSwitchCaseFieldIds`) are excluded.
 *
 *  CRITICAL EXCLUSION — opaque ciphertext: an `encrypted` node with a fixed
 *  `wireBits` footprint (QUIC's `payload`/`frames`, wireBits = 136 bits) is
 *  rendered by `resolveLayout` as an OPAQUE ciphertext blob in the default
 *  (wire) view; its plaintext switch is never instantiated, so the frame body
 *  cells (CRYPTO/ACK/STREAM) never appear and every selectable frameType yields
 *  a byte-identical diagram. Surfacing the plaintext discriminator (QUIC's
 *  `frameType` driving `frameByType`) there produces a permanently-inert picker
 *  whose Stream/Crypto/Ack label CONTRADICTS the opaque payload the diagram
 *  shows — a visible control with no possible effect. So an opaque
 *  (`wireBits`-bounded) encrypted node's plaintext fields are NOT collected: the
 *  whole subtree below it stays disqualified. Only an inline-rendering encrypted
 *  plaintext (no `wireBits`) contributes discriminators. Swept all 184 presets:
 *  only quicLong/quicShort carry a switch inside an opaque encrypted node. */
function collectEncryptedNestedFieldIds(
  body: PsdlPacket["body"],
  defs: Record<string, NamedStruct> | undefined,
): Set<string> {
  const acc = new Set<string>();
  // `insideEncrypted` flips true once we step into an INLINE-rendering encrypted
  // plaintext; `blocked` flips true once we enter a repeat, a switch case, or an
  // OPAQUE (`wireBits`-bounded) encrypted node, which permanently disqualifies
  // everything below (those scopes own their surfaces or render as ciphertext).
  const visit = (
    containers: Container[],
    insideEncrypted: boolean,
    blocked: boolean,
  ): void => {
    for (const c of flattenForMirror(containers, defs)) {
      if (isField(c)) {
        if (insideEncrypted && !blocked) acc.add(c.id);
        continue;
      }
      if (c.kind === "encrypted") {
        // A fixed `wireBits` footprint means the diagram renders this node as
        // opaque ciphertext (never instantiating the plaintext switch), so its
        // discriminators must NOT be surfaced — block the whole subtree.
        const opaque = c.wireBits !== undefined;
        visit(c.plaintext.fields, !opaque, blocked || opaque);
        continue;
      }
      if (c.kind === "switch") {
        for (const struct of Object.values(c.cases))
          visit(struct.fields, insideEncrypted, true);
        continue;
      }
      if (c.kind === "repeat") {
        visit(c.element.fields, insideEncrypted, true);
        continue;
      }
      if (c.kind === "group") {
        visit(c.children, insideEncrypted, blocked);
        continue;
      }
      if (c.kind === "optional") {
        visit([c.container], insideEncrypted, blocked);
        continue;
      }
    }
  };
  visit(body, false, false);
  return acc;
}

/**
 * Detect a `bytes` field whose length is a `lookup(ref X, table)` — the value's
 * width is selected from `table` by the run-time value of a sibling INT/BITS
 * discriminator `X` (LISP's `lispItrRlocAddr = bytes(lookup(ref lispItrRlocAfi,
 * {0:0, 1:4, 2:16}))`; pgm's NLA addresses). `X` is a plain int (NOT an enum and
 * NOT a Switch `on`), so it renders as a visible cell with NO enum widget and no
 * Switch picker — and at the default env X=0 the looked-up width is 0, so the
 * address region is invisible AND the user cannot raise X to reveal it: a
 * see-but-cannot-edit discriminator (and an empty, width-0 value region).
 *
 * Returns `X`'s id and the lookup `table` (value → byte width) so the caller can
 * surface a value-picker keyed on `env[X]`. Returns `null` for any other `n`
 * shape (delimited, plain ref / lit / op width, a `lookup` keyed on something
 * other than a bare field ref).
 */
function lookupDiscriminatorOf(
  field: Container,
): { refKey: string; table: Record<number, number> } | null {
  if (!isField(field) || field.type.kind !== "bytes") return null;
  const n = field.type.n;
  if (isBytesDelimited(n)) return null;
  if (n.kind !== "lookup") return null;
  if (n.key.kind !== "ref") return null;
  return { refKey: n.key.field, table: n.table };
}

/**
 * Expand a single Switch case key to the FULL set of integer discriminator
 * values it matches: a single int ("3" → {3}), a comma-list ("1,2" → {1,2}),
 * or a range ("8-15" → {8..15}). `firstCaseKeyValue` only returns the first
 * member (enough to SELECT an arm), but to choose a representative value for
 * the `_` default arm we must know which values are already CLAIMED by the
 * explicit arms. Returns an empty set for the "_" default arm / non-numeric
 * keys.
 */
function caseKeyValues(key: string): Set<number> {
  const out = new Set<number>();
  for (const part of key.split(",")) {
    const t = part.trim();
    const range = t.match(/^(\d+)-(\d+)$/);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (Number.isInteger(lo) && Number.isInteger(hi) && lo <= hi)
        for (let v = lo; v <= hi; v++) out.add(v);
      continue;
    }
    const n = Number(t);
    if (Number.isInteger(n) && n >= 0) out.add(n);
  }
  return out;
}

/**
 * Pick a representative discriminator value that selects the `_` default arm of
 * a Switch — i.e. an integer NOT claimed by any explicit (numeric) case key.
 * Preferred candidates are the discriminator's own enum variant values (so the
 * picker selection lands on a real, named protocol code — bgpFlowSpec's
 * `flowSpecCompType` 3..12 all fall into the `_` operator-list arm); failing
 * that, the smallest unclaimed non-negative integer. Returns `null` only if the
 * explicit arms somehow exhaust every candidate (no value reaches `_`).
 */
function representativeDefaultArmValue(
  cases: Record<string, { fields: Container[] }>,
  enumVariants: Record<string, string> | undefined,
): number | null {
  const claimed = new Set<number>();
  for (const key of Object.keys(cases))
    for (const v of caseKeyValues(key)) claimed.add(v);
  if (enumVariants) {
    const variantValues = Object.keys(enumVariants)
      .map((k) => Number(k))
      .filter((n) => Number.isInteger(n) && n >= 0)
      .sort((a, b) => a - b);
    for (const v of variantValues) if (!claimed.has(v)) return v;
  }
  for (let v = 0; v < 1 << 16; v++) if (!claimed.has(v)) return v;
  return null;
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
  const fieldNames = collectFieldNames(body);
  const enumVariants = collectEnumVariants(body);
  // Field ids declared inside a switch case — a switch discriminated on one of
  // these has no top-level cell to host a `switchCases` widget, so it needs a
  // packet-level refSwitch picker even when it is NOT inside a repeat.
  const switchCaseFieldIds = collectSwitchCaseFieldIds(body, defs);
  // Field ids declared inside a top-level Group (dccp `flagsGroup` → `x`; lisp
  // `lispFlags` → lispV/lispI/lispN). Like switch-case-nested ids these have no
  // top-level cell to host a widget, so a Switch discriminated on one needs a
  // packet-level refSwitch picker.
  const groupNestedFieldIds = collectGroupNestedFieldIds(body, defs);
  // Field ids declared inside a top-level `encrypted` plaintext (QUIC `frameType`
  // inside the `payload` block). Like switch-case / group-nested ids these have
  // no top-level cell to host a widget, so a Switch discriminated on one needs a
  // packet-level refSwitch picker.
  const encryptedNestedFieldIds = collectEncryptedNestedFieldIds(body, defs);
  // Declared field defaults — used to order a field-nested (group/case) picker's
  // cases so `initialState`'s `cases[0]` seed agrees with the author's default.
  const fieldDefaults = collectFieldDefaults(body);
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
    // Structured discriminator gate of the OUTERMOST enclosing top-level
    // message-type `switch` case (or null at top level / `_` default / non-ref
    // discriminator). Set ONCE on entry to the first such case and threaded
    // unchanged through any DEEPER nested switches, so a case-nested refSwitch
    // discriminator declared several arms down (oncRpc's acceptStat/rejectStat
    // under rpcMsgType's REPLY case) is gated on the TOP-LEVEL message type the
    // diagram must render — not on its nearer arm, which `initialState`'s
    // refKey seed already covers and which would otherwise conflict (rejectStat
    // wants replyStat=1, the refKey seed sets replyStat=0). Used only for
    // SEEDING; OverridePanel keeps the per-picker `fieldRendered` live gate.
    enclosingCaseGate: { key: string; value: number } | null,
  ): void => {
    for (const c of flattenForMirror(containers, defs)) {
      // A `bytes(lookup(ref X, table))` value whose discriminator X is a plain
      // INT (not an enum / not a Switch `on`) gets no cell-level enum widget and
      // no Switch picker, so the user can SEE X and the address region but cannot
      // change X to select the address family — and at X=0 the value renders at
      // width 0 (LISP `lispItrRlocAfi` / `lispEidPrefixAfi`; pgm NLA AFIs).
      // Surface a value-picker keyed on `env[X]` whose cases are the lookup
      // table keys, so picking a family sets the looked-up width (mirrors the
      // refSwitch picker — `OverridePanel` writes `env[refKey] = case.value`).
      if (isField(c)) {
        const disc = lookupDiscriminatorOf(c);
        if (disc && !seen.has(disc.refKey)) {
          // Don't shadow a discriminator that already drives the diagram another
          // way (a length slider / Switch picker / enum dropdown on a top-level
          // cell, or a Switch `on` surfaced elsewhere as a refSwitch).
          const covered = fields.find(
            (f) =>
              f.id === disc.refKey &&
              (f.controlsLength || f.switchCases || f.enumVariants),
          );
          // Inside a plain repeat, the records must be instantiable by a surfaced
          // count control — otherwise the value cell never appears and the picker
          // is inert (same gate as the Switch path below). A lookup discriminator
          // at the top level / inside a group / inside a switch case is reachable
          // by selecting the enclosing arm, so it needs no repeat gate there.
          const instantiable = enclosingPlainRepeat
            ? instantiableRepeatIds.has(enclosingPlainRepeat.id)
            : true;
          // Build one case per table entry. The label reports the looked-up byte
          // width (`4 bytes`); a 0-width entry reads `0 bytes (absent)`. The
          // table keys are stringified non-negative integers (core's schema), so
          // a non-numeric / negative key is skipped defensively.
          const cases: { value: number; width: number; label: string }[] = [];
          for (const [key, width] of Object.entries(disc.table)) {
            const value = Number(key);
            if (!Number.isInteger(value) || value < 0) continue;
            cases.push({
              value,
              width,
              label: width > 0 ? `${width} bytes` : "0 bytes (absent)",
            });
          }
          if (!covered && instantiable && cases.length > 0) {
            // Order so `cases[0]` is the first NON-zero-width family
            // (lowest-value present address). `initialState` seeds
            // `env[refKey] = cases[0].value`, so a 0-width "absent" default would
            // re-create the width-0 value the picker exists to fix and contradict
            // a picker whose first label promises bytes (#11/#12). Zero-width
            // "absent" entries are kept but sorted last.
            cases.sort((a, b) => {
              const aAbsent = a.width === 0 ? 1 : 0;
              const bAbsent = b.width === 0 ? 1 : 0;
              if (aAbsent !== bAbsent) return aAbsent - bAbsent;
              return a.value - b.value;
            });
            seen.add(disc.refKey);
            out.push({
              id: `${disc.refKey}_byAfi`,
              name: fieldNames.get(disc.refKey) ?? disc.refKey,
              cases: cases.map(({ value, label }) => ({ value, label })),
              refKey: disc.refKey,
            });
          }
        }
        continue;
      }
      if (c.kind === "repeat") {
        const plain = !isLikelyChainRepeat(c) && !isTlvRepeat(c);
        visit(
          c.element.fields,
          plain ? c : enclosingPlainRepeat,
          true,
          enclosingCaseGate,
        );
        continue;
      }
      if (c.kind === "switch") {
        // A ref-discriminated switch needs a packet-level picker in three cases:
        //   (1) it sits inside a plain repeat whose discriminator has no
        //       field-anchored widget (the original A2 path), or
        //   (2) it is discriminated on a field DECLARED INSIDE A SWITCH CASE
        //       (oncRpc replyData/acceptData/rejectData on
        //       replyStat/acceptStat/rejectStat): that discriminator is never a
        //       top-level cell, so attachOverrideMetadata can't stamp
        //       switchCases on it and collectRefSwitches' repeat path never
        //       reaches it — a see-but-cannot-edit gap.
        //   (3) it is a TOP-LEVEL switch discriminated on a field declared
        //       inside a top-level GROUP (dccp `seqNum` on the `x` flag bit
        //       inside `flagsGroup`; lisp `byLispV`/`byLispI`/`byLispNV` on
        //       lispV/lispI/lispN inside `lispFlags`). `flattenForMirror` does
        //       not descend into groups, so the discriminator is NOT a top-level
        //       cell either — same field-anchored-widget gap as (2). The user
        //       sees the flag bit and the region the switch selects but gets no
        //       control. Treated identically to the case-nested path.
        //   (4) it is a switch discriminated on a field declared inside an
        //       `encrypted` plaintext that the diagram renders INLINE (a
        //       header-protected scope with no fixed `wireBits`).
        //       `flattenForMirror` does not expose an encrypted-plaintext field
        //       as a top-level cell, so again no field-anchored widget exists —
        //       treated identically to the case/group paths.
        //       NOTE: an OPAQUE (`wireBits`-bounded) encrypted node — QUIC's
        //       `payload`/`frames` whose `frameByType` switches on `frameType` —
        //       is rendered as ciphertext: the plaintext switch is never
        //       instantiated, so every selectable value yields a byte-identical
        //       diagram. `collectEncryptedNestedFieldIds` deliberately EXCLUDES
        //       such opaque plaintext, so its discriminator is absent here and no
        //       permanently-inert picker (contradicting the opaque blob) leaks.
        const fieldNestedNoWidget =
          !enclosingPlainRepeat &&
          !insideRepeat &&
          c.on.kind === "ref" &&
          (switchCaseFieldIds.has(c.on.field) ||
            groupNestedFieldIds.has(c.on.field) ||
            encryptedNestedFieldIds.has(c.on.field));
        const caseNested = fieldNestedNoWidget;
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
          //
          // EXCEPTION: a sub-byte discriminator whose arms pick WHICH
          // substantive (non-length) cells render — not merely a
          // length-extension field on an existing length — is a genuine variant
          // selector, not an encoder (lwm2mRegister's `tlvIdLen` selecting the
          // 8- vs 16-bit Identifier, `tlvTypeOfLength` selecting the Length-field
          // width / short-vs-explicit Value layout). Suppressing those leaves the
          // visible Identifier/Length/Value cells un-editable (see-but-cannot-
          // edit). Only the sub-byte heuristic is relaxed; a true length-driving
          // ref (lengthDriving) stays an encoder regardless.
          const discBits = fieldBits.get(refKey);
          const isEncoder =
            lengthDriving.has(refKey) ||
            (discBits !== undefined &&
              discBits < 8 &&
              !subByteDiscriminatorSelectsVariant(c.cases));
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
          // control can't change anything.
          const allArmsInert = switchArmsAllZeroWidth(c.cases, controlledIds);
          // …UNLESS the collapse is caused EXCLUSIVELY by an uncontrolled
          // PER-RECORD sibling length declared inside the repeat element
          // (isisLsp's `tlvLength`: each arm is `bytes(ref tlvLength)`). Then we
          // do NOT suppress — instead surface the picker AND seed a
          // representative length so the chosen arm's Value cell becomes
          // visible/editable (KNOWN-REMAINING #7/#8). Suppressing here would
          // leave a region the user can SEE (the slider manufactures empty TLV
          // skeletons) but never fill in — the see-but-cannot-edit bar.
          // Per-record sibling field ids: those declared inside the enclosing
          // plain repeat's element (isisLsp's `tlvType` / `tlvLength`). Only such
          // a sibling length is safe to seed — a representative width on a real
          // PER-RECORD length field, not a shared top-level one. (A case-nested
          // picker has no repeat element, so it never qualifies for the rescue.)
          const perRecordFieldIds = enclosingPlainRepeat
            ? new Set(collectArmFieldIds(enclosingPlainRepeat.element.fields))
            : new Set<string>();
          const rescueLengths = allArmsInert
            ? switchArmsZeroWidthSiblingLengths(
                c.cases,
                controlledIds,
                perRecordFieldIds,
              )
            : null;
          const armsInert = allArmsInert && rescueLengths === null;
          // MIXED-width pickers (dnsResponse's `dnsRdata`: A/AAAA/MX/SRV/SOA are
          // fixed-width and visible, but NS/CNAME/PTR/TXT and the `_` raw arm are
          // each `bytes(ref dnsRdLength)` and collapse to width 0) are NOT inert —
          // they survive `switchArmsAllZeroWidth` and reach here un-suppressed —
          // yet selecting one of the collapsed arms shows an empty record at the
          // default env (#11/#12). Seed those collapsed arms' per-record sibling
          // lengths too, so EVERY selectable arm renders at load, not just the
          // fixed-width ones. Only when the all-zero-width rescue did not already
          // produce seeds (otherwise `rescueLengths` already covers them).
          const mixedSeedLengths =
            rescueLengths === null
              ? switchArmsMixedCollapsedSiblingLengths(
                  c.cases,
                  perRecordFieldIds,
                )
              : null;
          // For a case-nested picker there is no zero-width safety net from a
          // repeat budget, so also drop it when every selectable arm is
          // structurally identical (the diagram is byte-identical for every
          // value — an inert dropdown). The repeat path keeps its existing
          // gating untouched.
          //
          // EXCEPTION (snmpV2c/peek precedent): when the selectable arms render
          // to the SAME geometry but carry DISTINCT NAMES, selecting between them
          // still relabels the diagram cell — a real, diagram-visible semantic
          // edit — so we keep the picker surfaced rather than treating it as
          // inert. (This relaxation only matters for a case/group-nested or
          // INLINE-encrypted discriminator; an OPAQUE encrypted plaintext like
          // QUIC's `frameByType` is excluded upstream by
          // `collectEncryptedNestedFieldIds`, so it never reaches this gate.)
          const allArmsIdentical =
            caseNested &&
            switchArmsAllIdentical(c.cases) &&
            !switchArmsDifferByNameOnly(c.cases);
          if (
            !covered &&
            !isEncoder &&
            instantiable &&
            !armsInert &&
            !allArmsIdentical &&
            !seen.has(refKey)
          ) {
            const cases: { value: number; label: string }[] = [];
            for (const [key, struct] of Object.entries(c.cases)) {
              const v = firstCaseKeyValue(key);
              if (v === null) continue;
              cases.push({
                value: v,
                label: struct.name ?? prettifyId(struct.id) ?? `case ${key}`,
              });
            }
            // Reach the structurally-distinct `_` default arm: when the listed
            // case(s) render a different skeleton than the default arm (babel:
            // `0`=empty Pad1 vs `_`=TLV-with-body; bgpFlowSpec: `1,2`=prefix vs
            // `_`=numeric-operator list), append a synthetic "default" option so
            // the picker can select the `_`-arm layout instead of only ever the
            // listed value. The synthetic value PREFERS a real enum variant code
            // of the discriminator that falls into `_` (bgpFlowSpec
            // `flowSpecCompType` 3 = IP Protocol), so the selection lands on a
            // named protocol code rather than an anonymous sentinel; it falls
            // back to the smallest unclaimed integer otherwise.
            const defaultArm = c.cases["_"];
            if (defaultArm) {
              const explicitShapes = Object.entries(c.cases)
                .filter(([key]) => firstCaseKeyValue(key) !== null)
                .map(([, struct]) =>
                  JSON.stringify(struct.fields.map(structuralShape)),
                );
              const defaultShape = JSON.stringify(
                defaultArm.fields.map(structuralShape),
              );
              // Surface the synthetic option when the `_` arm renders a DISTINCT
              // skeleton from every listed case OR when it is the canonical
              // opaque / unknown-record arm (a lone `bytes(ref …)` value) whose
              // fingerprint COLLIDES with a listed arm. The collision case is a
              // real RFC-defined reachable state (any unlisted discriminator
              // decodes the record opaquely) that the plain `differs` test
              // wrongly suppresses because the `_` shape equals a listed
              // `bytes(ref …)` arm (dnsResponse `dnsRdataBytes`, isisLsp
              // `tlvValue`, pimHelloOptions `unknownOptData`); without it an
              // unknown record type is unrepresentable and an imported packet
              // carrying one cannot round-trip-select. The picked value is always
              // an UNLISTED code (`representativeDefaultArmValue`), so it
              // genuinely lands on `_`. (When the `_` shape already differs — e.g.
              // lwm2mRegister's short-length `tlvValueShort` form, a DEFINED arm
              // with a distinct 1-field skeleton — the normal path handles it and
              // this is NOT treated as an "unknown" arm.)
              const shapeCollides = explicitShapes.includes(defaultShape);
              const isUnknownRecordArm =
                shapeCollides && isOpaqueUnknownRecordArm(defaultArm);
              const differs =
                explicitShapes.length > 0 &&
                (!shapeCollides || isUnknownRecordArm);
              const defaultValue = differs
                ? representativeDefaultArmValue(
                    c.cases,
                    enumVariants.get(refKey),
                  )
                : null;
              if (
                defaultValue !== null &&
                !cases.some((cc) => cc.value === defaultValue)
              ) {
                const armLabel =
                  defaultArm.name ??
                  prettifyId(defaultArm.id) ??
                  "Other / default";
                // For an opaque unknown-record `_` arm whose own name reads like a
                // concrete field (RDATA / Value / Option Data), annotate the option
                // so the picker reads as the "unknown / other type" state it is —
                // the only place an unlisted (unmodelled) record type can be
                // selected — rather than masquerading as one more modelled variant.
                cases.push({
                  value: defaultValue,
                  label: isUnknownRecordArm
                    ? `${armLabel} (unknown / other type)`
                    : armLabel,
                });
              }
            }
            // For a field-nested (group/case) picker, `initialState` seeds
            // `env[refKey] = cases[0].value` on load. If the discriminator
            // declares a default (pgm `pgmType` = 4 / ODATA), order the matching
            // case FIRST so the seed agrees with the author's declared default
            // instead of silently switching the load diagram to a different arm
            // (cases[0] would otherwise be the lowest-keyed case, e.g. SPM=0).
            // The repeat path is untouched (its discriminator is 0-filled, not
            // author-defaulted).
            if (caseNested) {
              const dflt = fieldDefaults.get(refKey);
              if (dflt !== undefined) {
                const i = cases.findIndex((cc) => cc.value === dflt);
                if (i > 0) {
                  const [hit] = cases.splice(i, 1);
                  cases.unshift(hit);
                }
              }
            }
            if (cases.length > 0) {
              seen.add(refKey);
              // Seed each per-record length to exactly the per-record charge
              // `estimateElementBytes` already books for a `bytes(ref length)`
              // value (REF_SIZED_FIELD_BYTE_ALLOWANCE). Keeping the seed equal to
              // that charge means an enclosing boundedRepeat's budget-derived
              // count stays exact — each record consumes precisely
              // `perRecordBytes`, so seeding never over-consumes the bounded
              // scope (which would freeze the diagram). The value cell is still
              // non-zero-width — visible and editable — which is the whole point.
              const seedLengths = rescueLengths ?? mixedSeedLengths;
              const lengthSeeds = seedLengths
                ? [...seedLengths].map((key) => ({
                    key,
                    value: REF_SIZED_FIELD_BYTE_ALLOWANCE,
                  }))
                : undefined;
              // A case-nested refSwitch (oncRpc's reply-side pickers) lives in
              // an arm of a top-level message-type switch the diagram only
              // renders at one discriminator value. Carry that OUTERMOST gate so
              // `initialState` seeds the discriminator (rpcMsgType=1) and the
              // arm — hence the pickers' real cells — renders on load instead of
              // the unrelated CALL arm (#11/#12). The plain-repeat A2 path has no
              // top-level case (enclosingCaseGate is null) so it stays ungated.
              out.push({
                id: c.id,
                name: c.name ?? refKey,
                cases,
                refKey,
                ...(lengthSeeds ? { lengthSeeds } : {}),
                ...(enclosingCaseGate ? { gate: enclosingCaseGate } : {}),
              });
            }
          }
        }
        for (const [key, struct] of Object.entries(c.cases)) {
          // Establish the OUTERMOST message-type case gate exactly once, then
          // thread it unchanged through deeper nested switches. Only a top-level
          // (not repeat-nested) ref-discriminated case with a single integer key
          // qualifies — the same gate-derivation shape collectFreeRepeats uses
          // for icmpv6Ndp's `type`. Deeper arms keep the outer gate so a refSwitch
          // surfaced several levels down (acceptStat/rejectStat) is gated on the
          // top-level discriminator the diagram must render, not its nearer arm.
          const caseValue = firstCaseKeyValue(key);
          const nextCaseGate =
            enclosingCaseGate ??
            (!enclosingPlainRepeat &&
            !insideRepeat &&
            c.on.kind === "ref" &&
            caseValue !== null
              ? { key: c.on.field, value: caseValue }
              : null);
          visit(
            struct.fields,
            enclosingPlainRepeat,
            insideRepeat,
            nextCaseGate,
          );
        }
        continue;
      }
      if (c.kind === "group") {
        visit(
          c.children,
          enclosingPlainRepeat,
          insideRepeat,
          enclosingCaseGate,
        );
        continue;
      }
      if (c.kind === "optional") {
        visit(
          [c.container],
          enclosingPlainRepeat,
          insideRepeat,
          enclosingCaseGate,
        );
        continue;
      }
      if (c.kind === "encrypted") {
        visit(
          c.plaintext.fields,
          enclosingPlainRepeat,
          insideRepeat,
          enclosingCaseGate,
        );
        continue;
      }
    }
  };
  visit(body, null, false, null);
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
  packet: PsdlPacket,
  fields: RendererField[],
): {
  freeRepeats: NonNullable<RendererPacket["freeRepeats"]>;
  boundedRepeats: NonNullable<RendererPacket["boundedRepeats"]>;
  /** Repeat ids that got a SURFACED count control (a freeRepeat stepper or a
   *  budget-derived boundedRepeat). A refSwitch inside a repeat NOT in this set
   *  is inert — its records can never be instantiated by any control — so
   *  collectRefSwitches suppresses it (bgpPathAttributes' attrTypeCode picker). */
  instantiableRepeatIds: Set<string>;
} {
  const body = packet.body;
  const defs = packet.defs;
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
  // EXCEPTION to the above: a virtual whose expr is a bare SELF-ref
  // (`ref(self.id)`) is recomputed to env[id] itself, so an override DOES
  // survive — it can back a real count stepper (kerberosAsReq `padataCount`).
  const selfRefVirtualIds = collectSelfRefVirtualIds(body, defs);
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
    // Structured discriminator gate of the nearest enclosing switch CASE (or
    // null at top level / outside any case / on a non-`ref` discriminator). Set
    // ONLY for a top-level message-type `switch` whose `on` is a `ref` to a real
    // discriminator field (icmpv6Ndp `ref type`): `{ key: <field id>, value:
    // <case value> }`. A switch-nested freeRepeat carries this so the panel can
    // surface its stepper ONLY when the diagram is currently rendering that arm
    // (env[key]===value), and so `initialState` can seed the discriminator to
    // the first gated arm's value — otherwise the discriminator 0-fills, the `_`
    // default arm renders, NONE of the per-case option repeats instantiate, and
    // every surfaced stepper contradicts an empty diagram on load.
    caseGate: { key: string; value: number } | null,
    // True once ANY ancestor `bounded` byte-budget (with a single-ref length
    // field — i.e. one that drives a budget-derived boundedRepeat) has been
    // entered, and stays true through the elements of repeats nested below it.
    // Unlike `bounded` (which is reset to null at each repeat element so an inner
    // repeat gets its OWN keys, not the outer budget's), this flag persists. An
    // eos/until repeat nested one or more levels below such a bounded scope
    // (bgpFlowSpec flowSpecOps under the budget-derived flowSpecComponents) must
    // NOT get a naked free stepper: the outer repeat is auto-filled to consume
    // the WHOLE budget, so stepping the inner one adds bytes INSIDE the saturated
    // scope and normalize throws `bounded scope … over-consumed`, freezing the
    // diagram (the A4 destructive-bounded-stepper class, one level deeper). The
    // inner count is implicitly driven by the budget; surfacing no naked stepper
    // is correct.
    insideBounded: boolean,
    // The nearest enclosing PER-RECORD `bounded` whose `bytes` budget is NOT a
    // single ref (so it didn't become `bounded` above and can't drive the normal
    // single-ref boundedRepeat path), but whose budget IS evaluable at layout
    // time. The motivating case is bgpUpdateFull's per-attribute
    // `bounded(cond attrExtLen ? bgpAttrLength16 : bgpAttrLength8)` scope: it
    // wraps a switch on `attrTypeCode` whose AS_PATH / COMMUNITIES arms are eos
    // repeats (`bgpAsPathSegments` / `bgpCommunities`). Those repeats live inside
    // a switch case inside this bounded inside the outer `bgpPathAttributes`
    // repeat — so `bounded` is null (cond budget), `insideBounded` is true, and
    // the eos branches all skip them: they get ZERO count control and selecting
    // AS_PATH / Communities renders an empty record (see-but-cannot-edit). When
    // such an arm-nested eos repeat is reached we register it as a budget-derived
    // boundedRepeat keyed on THIS bounded's budget, so its count follows the
    // attribute-length budget exactly as the outer record count follows the
    // total-path-attribute-length budget. `lengthKeys` are the budget's
    // value-branch length refs (seeded via the outer boundedRepeat's
    // innerScopeSeeds) so the count evaluates to a representative >=1 at load.
    caseNestedBudget: { bytes: Expr; lengthKeys: string[] } | null,
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
        // A MULTI-ref bounded budget that is still evaluable (its length refs are
        // seeded elsewhere) drives an arm-nested eos repeat's count even though it
        // can't become the single-ref `bounded`. Carry it as `caseNestedBudget`
        // for that derivation (bgpUpdateFull's per-attribute Extended-Length cond
        // scope); a single-ref bounded takes the normal path, so clear it there.
        const lengthRefs = key === null ? budgetLengthRefs(c.bytes) : [];
        const nextCaseNestedBudget =
          key === null && lengthRefs.length > 0
            ? { bytes: c.bytes, lengthKeys: lengthRefs }
            : null;
        visit(
          c.fields,
          key ? { key, prefix, bytes: c.bytes } : null,
          insideRepeat,
          insideSwitch,
          enclosingInstantiable,
          insideOptional,
          caseLabel,
          caseGate,
          // A bounded scope with a single-ref length drives a budget-derived
          // boundedRepeat; mark every descendant so a repeat nested below it
          // can't surface a destructive naked stepper (bgpFlowSpec flowSpecOps).
          insideBounded || key !== null,
          nextCaseNestedBudget,
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
            caseGate,
            insideBounded,
            caseNestedBudget,
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
            // PLAIN-GROUP nested-bounded idiom (ocspRequest `requests`): the
            // record wraps a per-record bounded whose inner scope is a plain
            // group/leaf set with NO switch, which `tlvExtensionInnerSeeds`
            // rejects (returns null). Without help the repeat falls into NEITHER
            // freeRepeats NOR boundedRepeats and gets zero override surface, so
            // every CertID the diagram shows is see-but-cannot-edit. Probe a
            // crash-free per-record inner length + budget so the budget-derived
            // count renders one representative record at load and grows as the
            // user raises the length slider. Only attempted when the simpler
            // tlvExt derive did not apply, so no existing preset regresses.
            const nestedGroup =
              bounded && containsBounded(c.element.fields) && !tlvExt
                ? nestedGroupBoundedSeeds(packet, c, bounded)
                : null;
            if (bounded && !containsBounded(c.element.fields)) {
              // Bounded eos/until: derive the count from the budget so raising
              // the length slider fills the scope. No stepper (would
              // over-consume). The simple case — the record carries no nested
              // bounded — is handled here; the TLV-extension case (record wraps
              // its own per-record bounded) is handled just below.
              //
              // FLAT TLV-shaped record (stun stunAttrLen→stunAttrValue, pppoe
              // tagLength→tag value, bgpOpen parmLen→param value, cops, gist,
              // hip, ipfix, bgpLs, tlsCertificate): the record is a flat triplet
              // `[type, length X, value = bytes(ref X), …]` with NO nested
              // bounded — so it is not isTlvRepeat (not a single switch) and not
              // the TLV-extension idiom (no per-record bounded). Without help the
              // per-record length X defaults to 0, so every record's value =
              // bytes(ref X) stays width-0 and INVISIBLE — the user sees each
              // record's Type and Length=0 cells but can never make the VALUE
              // appear (see-but-cannot-edit). Detect a flat sibling-sized value
              // and seed its length field to a representative size so ONE record's
              // value renders; `perRecordBytes` charges the seeded value bytes so
              // the budget-derived count stays conservative.
              const flat = flatTlvInnerSeeds(c.element);
              const budgetIsPlainRefFlat =
                bounded.bytes.kind === "ref" &&
                bounded.bytes.field === bounded.key;
              const perRecordBytesFlat = flat
                ? flat.perRecordBytes
                : estimateElementBytes(c.element);
              const flatDefaultLength =
                flat && flat.innerSeeds.length > 0 && budgetIsPlainRefFlat
                  ? perRecordBytesFlat + bounded.prefix
                  : undefined;
              // FLAT TLV record under a *SCALED* affine budget (hip's
              // `hipHeaderLength*8 - 32`, gist's `gistMessageLength*4`): the
              // record is the same flat `[type, length X, value = bytes(ref X)]`
              // triplet (so `flat` seeds the per-record value), but its byte
              // budget MULTIPLIES the length field, so `budgetIsPlainRefFlat`
              // (which needs a bare `ref(lengthKey)`) is false and no
              // `defaultLength` is emitted. At load the budget field 0-fills,
              // `floor((budget-prefix)/perRecord)=0` records render, and the
              // ENTIRE TLV section (type, length, value) is invisible — the user
              // sees only the fixed header with no cue the parameter list exists
              // (#11/#12 discoverability, the class babel/isisLsp/bgpOpen already
              // fix via the plain-ref `flatDefaultLength`). Solve the SMALLEST
              // budget-field value giving one record accounting for the `*mul`
              // scale: `ceil((sub + prefix + perRecord) / mul)`. Only attempted
              // when the budget genuinely SCALES its length field (`mul > 1`);
              // unscaled `ref - c` budgets keep their existing (deliberately
              // unseeded) behavior, so only the scaled gap is newly filled.
              const affineParts = budgetAffineParts(bounded.bytes);
              const flatAffineDefaultLength =
                flat &&
                flat.innerSeeds.length > 0 &&
                !budgetIsPlainRefFlat &&
                perRecordBytesFlat > 0 &&
                affineParts !== null &&
                affineParts.mul > 1 &&
                affineParts.field === bounded.key
                  ? Math.max(
                      1,
                      Math.ceil(
                        (affineParts.sub +
                          bounded.prefix +
                          perRecordBytesFlat) /
                          affineParts.mul,
                      ),
                    )
                  : undefined;
              // Seed `defaultLength` so the budget yields >=1 record at load,
              // BUT ONLY for a RECORD-BEARING repeat (its element holds a
              // ref/peek-discriminated switch → a surfaced 'Record variants'
              // picker, e.g. isisLsp byType / bgpFlowSpec flowSpecCompType /
              // babel babelTlvType). Otherwise the length field 0-fills,
              // `floor((budget-prefix)/perRecord)=0` records render, and the
              // populated variant picker sits over an EMPTY TLV region doing
              // nothing until the user discovers the length slider (#11/#12
              // contradiction class, same as the free-repeat defaultCount /
              // tlvExt defaultLength seeds). Solve `bytes @ L` for the smallest
              // L giving one record: `L = c + prefix + perRecordBytes` where c
              // is the budget's affine offset (`ref - c` / `ref*k - c`; 0 for a
              // bare ref). A scalar-list bounded repeat (no variant switch) gets
              // NO seed so it stays empty. Unresolvable budgets (cond, etc.)
              // leave defaultLength absent — no regression. The flat-TLV
              // defaultLength (above) takes precedence when present.
              const affineConst = budgetAffineConst(bounded.bytes);
              const recordSwitchDefaultLength =
                elementHasRecordSwitch(c.element.fields) &&
                affineConst !== null &&
                perRecordBytesFlat > 0
                  ? affineConst + bounded.prefix + perRecordBytesFlat
                  : undefined;
              const seedLength =
                flatDefaultLength ??
                flatAffineDefaultLength ??
                recordSwitchDefaultLength;
              boundedOut.push({
                countKey: c.id,
                lengthKey: bounded.key,
                bytesExpr: bounded.bytes,
                perRecordBytes: perRecordBytesFlat,
                prefixBytes: bounded.prefix,
                ...(flat && flat.innerSeeds.length > 0
                  ? { innerScopeSeeds: flat.innerSeeds }
                  : {}),
                ...(seedLength !== undefined
                  ? { defaultLength: seedLength }
                  : {}),
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
              // bgpPathAttributes (cond budget → tlvExtensionInnerSeeds null,
              // preserving its existing suppression) and ocspRequest (plain group
              // inner scope → null here, but handled by the nestedGroup branch
              // below instead).
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
            } else if (bounded && nestedGroup) {
              // PLAIN-GROUP nested-bounded record (ocspRequest `requests`):
              // `nestedGroupBoundedSeeds` probed a crash-free per-record inner
              // length (`innerScopeSeeds`) and an outer budget (`defaultLength`)
              // that renders exactly one representative record at load. The
              // budget-derived count (`floor((budget - prefix)/perRecordBytes)`)
              // then grows the list as the user raises the length slider — the
              // same single intuitive control every other bounded list uses.
              boundedOut.push({
                countKey: c.id,
                lengthKey: bounded.key,
                bytesExpr: bounded.bytes,
                // perRecordBytes / prefixBytes are DERIVED from layout probes
                // (b2 - b1 / b1 - recordBytes), not the static estimate, so the
                // budget-driven count never over-consumes the scope.
                perRecordBytes: nestedGroup.perRecordBytes,
                prefixBytes: nestedGroup.prefixBytes,
                innerScopeSeeds: nestedGroup.innerSeeds,
                defaultLength: nestedGroup.defaultLength,
              });
              instantiableRepeatIds.add(c.id);
            } else if (
              !bounded &&
              caseNestedBudget &&
              insideRepeat &&
              insideSwitch
            ) {
              // ARM-NESTED eos repeat under a MULTI-ref bounded budget
              // (bgpUpdateFull's AS_PATH / COMMUNITIES path-attribute arms:
              // `bgpAsPathSegments` / `bgpCommunities`, each a `count: eos` repeat
              // living in a `switch on attrTypeCode` case inside
              // `bounded(cond attrExtLen ? bgpAttrLength16 : bgpAttrLength8)`).
              // `bounded` is null (the cond budget isn't single-ref) and
              // `insideBounded` is true, so every other branch skips it: selecting
              // AS_PATH / Communities in the attrTypeCode picker would render only
              // the flags + length cells over an EMPTY body — a region the picker
              // promises but can never populate (see-but-cannot-edit).
              //
              // Derive the count from THIS bounded's budget exactly as the outer
              // record count follows the total-path-attribute-length budget:
              // register a boundedRepeat keyed on the per-attribute budget so
              // PacketViewer's layout memo sets
              // `env[countKey] = floor((budget - prefix) / perRecord)`. The arm is
              // the whole content of its switch case, so prefix is 0. The budget's
              // value-branch length refs (bgpAttrLength8 / bgpAttrLength16) are
              // already seeded to a representative width by the ENCLOSING
              // `bgpPathAttributes` boundedRepeat's innerScopeSeeds — pushed BEFORE
              // this one (its repeat is encountered before we descend into the
              // element), so by the time PacketViewer evaluates this budget the
              // length fields hold that seed and the count is a representative >=1
              // segment / community at load. We deliberately do NOT re-seed those
              // lengths here: PacketViewer / initialState seed first-write-wins, so
              // a smaller seed pushed here could shrink the budget to 0 records. No
              // naked stepper is surfaced (it would over-consume the saturated
              // scope), matching every other bounded list: the budget is the
              // single control.
              boundedOut.push({
                countKey: c.id,
                lengthKey: caseNestedBudget.lengthKeys[0],
                bytesExpr: caseNestedBudget.bytes,
                perRecordBytes: estimateElementBytes(c.element),
                prefixBytes: 0,
              });
              instantiableRepeatIds.add(c.id);
            } else if (
              !bounded &&
              !insideBounded &&
              (!insideRepeat || enclosingInstantiable)
            ) {
              // Free eos/until: a real count env key the user steps directly.
              // Suppressed when nested inside a NON-instantiable parent repeat
              // (bgpUpdateFull's bgpAsPathSegments / bgpCommunities live in
              // bgpPathAttributes, which is in NEITHER freeRepeats NOR
              // boundedRepeats): no surfaced control can make the parent record
              // exist, so a child stepper would be permanently inert — driving it
              // over {0,1,2,3} leaves the diagram byte-identical. A free child of
              // an instantiable parent (dnsResponse dnsQNameLabels) is kept.
              // Also suppressed when ANY bounded ancestor is active
              // (`insideBounded`): the outer bounded repeat is auto-filled to
              // consume the whole budget, so a naked stepper on this inner repeat
              // adds bytes inside the saturated scope and normalize throws
              // `bounded scope … over-consumed`, freezing the diagram
              // (bgpFlowSpec flowSpecOps). `bounded` alone is null here because it
              // is reset at each repeat element; `insideBounded` persists.
              countKey = c.id;
              label = `${label} (${c.count === "eos" ? "eos" : "until"})`;
              defaultCount = 1;
            }
          } else if (
            typeof c.count === "object" &&
            c.count.kind === "ref" &&
            // A ref-count repeat nested INSIDE an enclosing repeat record
            // (igmpv3Report igmpv3Sources count={ref:igmpv3SrcCount}, mldv2Report
            // sourceList, pimJoinPrune grpJoinedSources/grpPrunedSources,
            // lispMapReply lispRecLocators, pimBootstrap gsRpEntries) is surfaced
            // too, but ONLY when (a) its enclosing repeat is itself instantiable
            // (`enclosingInstantiable` — so at least one parent record actually
            // renders and the driver field exists in the diagram) and (b) it is
            // NOT inside a budget-derived bounded scope (`!insideBounded` —
            // bgpUpdateFull bgpAsSegValue lives under the bgpPathAttributes
            // budget; a naked stepper there adds bytes inside a saturated scope,
            // `bounded scope … over-consumed`, AND is inert at the 0-fill load env
            // because no path-attribute record is instantiated). The driver ref
            // names a per-record field, but in the env model a SINGLE env key
            // drives EVERY record's count identically, so a packet-level stepper
            // writing env[ref]=N is consistent with the rendered value — it just
            // applies uniformly to all records. Surfacing it closes the
            // see-but-cannot-edit gap (the user sees N source cells + the count
            // field but otherwise has no control); the documented A7 tradeoff
            // (a global stepper can't give DISTINCT per-instance counts) is
            // accepted, qualified by a label noting it applies to every record.
            (!insideRepeat || (enclosingInstantiable && !insideBounded))
          ) {
            // Only surface when no existing field-bearing widget covers it.
            const ref = c.count.field;
            const covered = fields.find(
              (f) =>
                f.id === ref &&
                (f.controlsLength || f.switchCases || f.enumVariants),
            );
            // A count ref to a `virtual` field is recomputed by normalize every
            // render (walkVirtual `env.set(id, eval(expr))`), clobbering any
            // stepper write — a virtual with a LITERAL expr always renders the
            // same record count regardless of the stepper. EXCEPTION: a
            // SELF-ref virtual (`expr: ref(self.id)`) recomputes to env[id]
            // itself, so a stepper write survives and IS drivable — surface it
            // (kerberosAsReq `padataList count={ref:padataCount}`, whose
            // `padataCount` the preset adapter rewrites from `lit 1` to a
            // self-ref seed so the visible PA-DATA list gets an add/remove
            // control instead of being see-but-cannot-edit).
            if (
              !covered &&
              (!virtualIds.has(ref) || selfRefVirtualIds.has(ref))
            ) {
              countKey = ref;
              if (insideRepeat) {
                // Inner per-record ref-count: the driver lives inside the
                // enclosing record, which already renders (enclosingInstantiable).
                // Annotate the label so it is clear the stepper applies UNIFORMLY
                // to every record of the enclosing repeat (the accepted A7 tradeoff
                // vs distinct per-instance counts), not just one.
                label = `${label} (per record)`;
                // A RECORD-BEARING inner repeat (its element wraps a variant
                // Switch / nested Repeat that surfaces its own refSwitch/peek
                // picker — lispMapReply's `lispRecLocators`, whose element holds
                // the `lispLocAddrByAFI` AFI switch) is seeded to ONE record so
                // that picker is LIVE on load: at the 0-fill natural ref value the
                // enclosing record renders but holds ZERO inner records, so the
                // inner discriminator cell never appears and the "Record variants"
                // picker is inert and contradicts an empty region (#11/#12 —
                // lispLocAddrByAFI). Plain scalar-list inner repeats
                // (igmpv3/mldv2 source lists, pim joined/pruned) are NOT
                // record-bearing, so they stay at the 0-seed — a representative
                // record there carries no extra editable surface. A ref-count (NOT
                // budget) repeat, so seeding 1 never over-consumes a byte budget.
                if (repeatIsRecordBearing(c)) defaultCount = 1;
              } else if (repeatIsRecordBearing(c)) {
                // Top-level record-bearing ref-count repeat: seed ONE record so
                // its element's variant Switch (the surfaced refSwitch/peekSwitch
                // picker) or nested Repeat isn't sitting over an EMPTY region.
                // Without this the count falls back to the 0-seed, so at load (and
                // after every preset switch) there are ZERO records and a "Record
                // variants" picker is INERT (#11/#12 — dnsResponse
                // dnsAnswers/dnsRrType, dnsQuestions, lispMapReply
                // lispReplyRecords). One representative record is a ref-count (NOT
                // a budget) repeat, so seeding 1 never over-consumes a byte
                // budget. Plain scalar-list ref-count repeats stay at 0.
                defaultCount = 1;
              } else if (selfRefVirtualIds.has(ref)) {
                // Top-level repeat counted by a SELF-ref virtual that the PSDL
                // seeds to a representative value (kerberosAsReq `padataCount`).
                // A self-ref virtual evaluates to its env value (fallback 0 when
                // unset), so without a seed the visible PA-DATA record would
                // VANISH at load — a regression from the preset's intent to show
                // one illustrative record. Seed 1 to preserve that representative
                // record AND make the stepper land on a live value (the override
                // survives the recompute; see selfRefVirtualIds). Not record-
                // bearing here so the +1 above doesn't fire; this branch covers
                // the plain-record case the self-ref enables.
                defaultCount = 1;
              }
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
            // Gate a SWITCH-CASE-nested repeat (icmpv6Ndp's rsOptions/raOptions/…
            // each live in a distinct `type` case) on its enclosing case's
            // discriminator, so the panel surfaces this stepper ONLY when the
            // diagram is rendering that arm — and `initialState` can seed the
            // discriminator to one such arm. `surfacedNestedTlv` repeats live
            // directly under a switch case; the plain ref-count / op-count
            // branches are top-level or repeat-nested (caseGate is null there),
            // so this only attaches a gate where one genuinely applies.
            const gate = caseGate ?? undefined;
            // An OPTIONAL-wrapped repeat has no `caseGate` (that mechanism is
            // switch-case only). Its enclosing `optional{when: ref(X)}` makes the
            // whole section absent at load (X is a plain int with no widget, so it
            // 0-fills), yet a `defaultCount` would otherwise make the stepper read
            // live over a diagram drawing NOTHING from the section — a
            // panel-vs-diagram contradiction. Anchor a `fieldRendered` gate on a
            // representative inner field id so OverridePanel disables the stepper
            // with a hint until the optional's `when` is set (the same gate a
            // refSwitch picker uses). Only for a genuinely optional-nested,
            // non-switch-case repeat — no built-in preset hits this.
            const gateFieldId =
              insideOptional && !gate
                ? (firstInnerFieldId(c.element.fields) ?? undefined)
                : undefined;
            out.push({
              name: qualifiedName,
              countKey,
              ...(defaultCount !== undefined ? { defaultCount } : {}),
              ...(transform !== undefined ? { transform } : {}),
              ...(gate !== undefined ? { gate } : {}),
              ...(gateFieldId !== undefined ? { gateFieldId } : {}),
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
          // A repeat element is the repeat's OWN iteration scope, not the switch
          // case: clear the discriminator gate so a deeper repeat isn't gated on
          // an ancestor message-type value (the gate applies to the option repeat
          // itself, surfaced at the case level above).
          null,
          // `bounded` is reset to null (the inner repeat gets its own keys), but
          // `insideBounded` PERSISTS: a repeat nested under a budget-derived
          // bounded scope (bgpFlowSpec flowSpecOps under flowSpecComponents) must
          // not surface a destructive naked stepper.
          insideBounded,
          // A repeat element is its own iteration scope: the enclosing
          // per-attribute budget sizes the ARM that holds this repeat, not this
          // repeat's own nested records — clear it so a deeper eos repeat doesn't
          // mis-derive from an ancestor attribute budget.
          null,
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
          caseGate,
          insideBounded,
          caseNestedBudget,
        );
        continue;
      }
      if (c.kind === "switch") {
        for (const [key, struct] of Object.entries(c.cases)) {
          // Derive a structured discriminator gate for a repeat surfaced
          // directly inside THIS case. Only when the discriminator is a `ref` to
          // a real field (icmpv6Ndp `ref type`) and the case key is a single
          // integer value — so the gate names a controllable env key the diagram
          // actually reads. The `_` default arm and non-ref / range / comma keys
          // yield no gate (fall back to the outer caseGate so an inner switch
          // doesn't drop an enclosing gate).
          const caseValue = firstCaseKeyValue(key);
          const nextCaseGate =
            c.on.kind === "ref" && caseValue !== null
              ? { key: c.on.field, value: caseValue }
              : caseGate;
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
            nextCaseGate,
            insideBounded,
            // A switch case is the ARM the per-attribute budget sizes — keep the
            // budget so an eos repeat directly inside this case (AS_PATH /
            // COMMUNITIES) can derive its count from it.
            caseNestedBudget,
          );
        }
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
          caseGate,
          insideBounded,
          caseNestedBudget,
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
          caseGate,
          insideBounded,
          caseNestedBudget,
        );
        continue;
      }
    }
  };
  visit(body, null, false, false, true, false, null, null, false, null);
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

/** The first field id declared anywhere inside `containers` (document order,
 *  recursing through groups / bounded / optional / switch arms / nested repeats),
 *  or null if none. Used as a `fieldRendered` gate anchor for a control surfaced
 *  over a region that may be absent from the diagram (an optional-wrapped repeat,
 *  a peek switch whose arm isn't drawn): when this id is a rendered cell the
 *  region is present and the control is live; otherwise the panel disables it with
 *  a hint instead of contradicting the diagram. */
function firstInnerFieldId(containers: Container[]): string | null {
  for (const c of containers) {
    if (isField(c)) return c.id;
    if (c.kind === "group") {
      const id = firstInnerFieldId(c.children);
      if (id) return id;
    } else if (c.kind === "bounded") {
      const id = firstInnerFieldId(c.fields);
      if (id) return id;
    } else if (c.kind === "optional") {
      const id = firstInnerFieldId([c.container]);
      if (id) return id;
    } else if (c.kind === "repeat") {
      const id = firstInnerFieldId(c.element.fields);
      if (id) return id;
    } else if (c.kind === "encrypted") {
      const id = firstInnerFieldId(c.plaintext.fields);
      if (id) return id;
    } else if (c.kind === "switch") {
      for (const s of Object.values(c.cases)) {
        const id = firstInnerFieldId(s.fields);
        if (id) return id;
      }
    }
  }
  return null;
}

/** The switch arm (Struct) whose case key covers `value`, mirroring core's
 *  `selectArm` grammar (single int / comma-list / range). Returns undefined when
 *  no LISTED arm matches (the caller falls back to the `_` default arm). Used to
 *  locate the arm `initialState` seeds for a peek picker so its `fieldRendered`
 *  gate anchors on the arm actually drawn at load. */
function findArmByCaseValue(
  cases: Record<string, Struct>,
  value: number,
): Struct | undefined {
  for (const [key, struct] of Object.entries(cases)) {
    if (caseKeyCoversValue(key, value)) return struct;
  }
  return undefined;
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
 * The constant subtracted from a budget expression of shape `ref - c`,
 * `ref*k - c` (or a bare `ref`, → 0). Used to seed a plain-bounded
 * record-bearing repeat's length so the budget `eval(bytes @ L) - prefix`
 * yields >=1 record at load: `defaultLength = c + prefix + perRecordBytes`
 * (mirroring the tlvExt branch's `perRecordBytes + prefix` for a plain ref).
 * Returns null for any other shape (cond budgets, multi-term offsets) — those
 * stay unseeded, no regression.
 */
function budgetAffineConst(bytes: Expr): number | null {
  if (bytes.kind === "ref") return 0;
  if (bytes.kind === "op" && bytes.op === "-" && bytes.b.kind === "lit") {
    // `<left> - lit(c)` where <left> is `ref` or `ref * lit(k)`.
    const left = bytes.a;
    if (left.kind === "ref") return bytes.b.value;
    if (
      left.kind === "op" &&
      left.op === "*" &&
      ((left.a.kind === "ref" && left.b.kind === "lit") ||
        (left.b.kind === "ref" && left.a.kind === "lit"))
    ) {
      return bytes.b.value;
    }
  }
  return null;
}

/**
 * Decompose a budget expression of shape `ref`, `ref - c`, `ref*k`, or
 * `ref*k - c` into `{ field, mul: k, sub: c }` (k defaults to 1, c to 0) so the
 * smallest length-field value yielding >=1 record can be SOLVED accounting for
 * the multiplier. Unlike `budgetAffineConst` (which only recovers the offset),
 * this also recovers `k` — needed when the budget SCALES its length field, e.g.
 * hip's `hipHeaderLength*8 - 32`: seeding the budget value `c + prefix +
 * perRecord` directly into `hipHeaderLength` would over-shoot the scope 8×.
 * The required field value is `ceil((c + prefix + perRecord) / k)`. Returns
 * null for any other shape (cond budgets, multi-ref, etc.) — those stay
 * unseeded, no regression.
 */
function budgetAffineParts(
  bytes: Expr,
): { field: string; mul: number; sub: number } | null {
  const mulParts = (e: Expr): { field: string; mul: number } | null => {
    if (e.kind === "ref") return { field: e.field, mul: 1 };
    if (e.kind === "op" && e.op === "*") {
      if (e.a.kind === "ref" && e.b.kind === "lit")
        return { field: e.a.field, mul: e.b.value };
      if (e.b.kind === "ref" && e.a.kind === "lit")
        return { field: e.b.field, mul: e.a.value };
    }
    return null;
  };
  if (bytes.kind === "op" && bytes.op === "-" && bytes.b.kind === "lit") {
    const m = mulParts(bytes.a);
    return m ? { field: m.field, mul: m.mul, sub: bytes.b.value } : null;
  }
  const m = mulParts(bytes);
  return m ? { field: m.field, mul: m.mul, sub: 0 } : null;
}

/**
 * The LENGTH-bearing field refs of a budget expression — the fields whose value
 * is the byte count, as opposed to a discriminator that merely SELECTS which
 * length applies. For a `cond test ? t : f` budget (bgpUpdateFull's
 * `attrExtLen ? bgpAttrLength16 : bgpAttrLength8`) the `test` is the
 * Extended-Length flag (a selector, not a length) and `t` / `f` are the two
 * actual length fields — so only `t` / `f`'s refs are returned. For any other
 * shape every ref is length-bearing. Used to seed the per-record inner-bounded
 * length(s) of a case-nested boundedRepeat so its budget evaluates to a
 * representative >=1 record at load.
 */
function budgetLengthRefs(bytes: Expr): string[] {
  if (bytes.kind === "cond") {
    const refs = new Set<string>();
    for (const r of exprRefs(bytes.t)) refs.add(r);
    for (const r of exprRefs(bytes.f)) refs.add(r);
    return [...refs];
  }
  return [...new Set(exprRefs(bytes))];
}

/**
 * Whether a repeat element is RECORD-BEARING: it contains a `switch`
 * discriminated by a `ref` or `peek` (a surfaced refSwitch / peekSwitch
 * variant picker is offered over it). Scalar-list bounded repeats (no variant
 * switch) are NOT record-bearing and must stay empty at load.
 */
function elementHasRecordSwitch(containers: Container[]): boolean {
  for (const c of containers) {
    if (isField(c)) continue;
    if (c.kind === "switch" && (c.on.kind === "ref" || c.on.kind === "peek")) {
      return true;
    }
    if (c.kind === "group" && elementHasRecordSwitch(c.children)) return true;
    if (c.kind === "optional" && elementHasRecordSwitch([c.container]))
      return true;
    if (c.kind === "bounded" && elementHasRecordSwitch(c.fields)) return true;
    if (c.kind === "encrypted" && elementHasRecordSwitch(c.plaintext.fields))
      return true;
  }
  return false;
}

/**
 * Return the sibling LENGTH field ids that a nested-bounded budget `bytes`
 * selects between, or `null` if it is not a sibling-length budget we can seed.
 * Accepts:
 *   - a plain `ref(K)` where K is a sibling field (tlsClientHello `extData`),
 *   - a `cond(test, t, f)` whose `t` and `f` are each a plain sibling `ref`
 *     (BGP `bgpAttrValueScope(cond attrExtLen ? bgpAttrLength16 : bgpAttrLength8)`
 *     — the Extended-Length idiom). The `test` flag picks which length is live;
 *     both are seeded so whichever is selected fits the representative arm.
 * Any richer shape (multi-term arithmetic, a non-ref cond branch, a ref to a
 * non-sibling) returns `null`, leaving the record non-auto-derived.
 */
function boundedBudgetSiblingLengths(
  bytes: Expr,
  siblingIds: Set<string>,
): string[] | null {
  if (bytes.kind === "ref") {
    return siblingIds.has(bytes.field) ? [bytes.field] : null;
  }
  if (bytes.kind === "cond") {
    if (bytes.t.kind !== "ref" || bytes.f.kind !== "ref") return null;
    if (!siblingIds.has(bytes.t.field) || !siblingIds.has(bytes.f.field)) {
      return null;
    }
    // Dedup in case both branches name the same length field.
    return [...new Set([bytes.t.field, bytes.f.field])];
  }
  return null;
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
 * Returns, when every direct-child nested bounded has a sibling-length budget
 * AND holds a Switch (the variant idiom):
 *   - `innerSeeds`: `{ key: K, value: <representative-arm bytes> }` per inner
 *     scope — the inner length seeded so cases[0] fits,
 *   - `perRecordBytes`: the record's byte size with each inner scope charged its
 *     seeded (representative-arm) budget — keeps the outer count conservative.
 * The sibling-length budget is either a plain `ref(K)` (tlsClientHello's
 * `extData(ref extLen)`) OR a `cond(test, t: ref(A), f: ref(B))` selecting
 * between two sibling length fields by a sibling flag — the BGP Extended-Length
 * idiom (bgpPathAttributes' `bgpAttrValueScope(cond attrExtLen ? bgpAttrLength16
 * : bgpAttrLength8)`). For the cond form BOTH branch lengths are seeded so
 * whichever the flag selects (attrExtLen defaults 0 → the 1-byte length) fits the
 * representative arm; the inner scope is one physical region so it is charged
 * `innerBytes` once.
 * Returns `null` when no such nested bounded exists, when ANY nested bounded's
 * budget is neither a sibling ref nor a sibling-ref `cond`, or when an inner
 * scope has no Switch (ocspRequest's plain `group` scope, whose exact-fill
 * berLength can't be STATICALLY seeded — it is instead handled by
 * `nestedGroupBoundedSeeds`, which probes a crash-free seed with
 * `resolveLayout`) — those stay non-auto-derived here, preserving the existing
 * suppression.
 */
function tlvExtensionInnerSeeds(element: { fields: Container[] }): {
  innerSeeds: {
    key: string;
    value: number;
    bytesPerUnit?: number;
    derivesBudgetKey?: string;
  }[];
  perRecordBytes: number;
} | null {
  const siblingIds = new Set<string>();
  collectRecordFieldIds(element.fields, siblingIds);
  const innerSeeds: {
    key: string;
    value: number;
    bytesPerUnit?: number;
    derivesBudgetKey?: string;
  }[] = [];
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
    // Budget must select between sibling LENGTH field(s) of this record — a
    // plain `ref(K)` (tlsClientHello) or a `cond ? ref(A) : ref(B)` flag
    // (BGP Extended-Length). Anything else stays non-auto-derived.
    const budgetLengthKeys = boundedBudgetSiblingLengths(c.bytes, siblingIds);
    if (budgetLengthKeys === null) return null;
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
    // Size the inner scope by the LARGEST NUMERIC-case arm — every numeric case
    // is a value the surfaced refSwitch picker can select, so the seeded inner
    // length must fit whichever the user picks, not just cases[0]. Sizing by the
    // first arm alone (BGP's `bgpAttrValue`: ORIGIN=1 B but NEXT_HOP=4 B) seeds a
    // scope too small for the others, and picking one OVER-CONSUMES the inner
    // bounded → normalize throws → the diagram freezes. The `_`/opaque
    // `remaining` arm is excluded (its 64 B allowance would dominate the
    // per-record estimate and bury every record behind a huge length plateau);
    // it stays reachable by raising the length slider. Other (non-switch)
    // siblings in the inner scope add their own bytes once.
    const numericKeys = Object.keys(sw.cases).filter(
      (k) => firstCaseKeyValue(k) !== null,
    );
    let switchBytes = 0;
    for (const k of numericKeys) {
      // Size each arm by the bytes it MINIMALLY needs — its fixed-width fields
      // only. A variable-length value inside the arm flexes to fill the scope (a
      // `remaining`/delimited/sibling-ref `bytes` like MP_REACH's
      // `bgpMpReachRest = bytes(remaining)` consumes leftover budget, it does not
      // demand more), so it imposes no minimum. Using estimateElementBytes here
      // would charge such a value the 64 B unbounded allowance, blowing the seed
      // up to ~67 B and burying every record behind a huge length plateau. The
      // seed must instead be the LARGEST fixed arm so any variant the picker
      // selects (ORIGIN 1 B … AGGREGATOR 6 B) fits the seeded scope without
      // over-consuming it.
      switchBytes = Math.max(switchBytes, armMinFixedBytes(sw.cases[k].fields));
    }
    // A numeric arm may carry a VARIABLE value sized by a sibling length field of
    // THIS record (tlsClientHello SNI: `serverName = bytes(ref nameLen)`). With
    // nameLen at its 0 default the value is empty, so `armMinFixedBytes` (fixed
    // fields only) is the right STATIC seed — but the instant the user raises (or
    // an imported packet carries) nameLen, the value grows past the inner scope's
    // statically-seeded `extLen` budget and core throws `bounded over-consumed` →
    // the diagram FREEZES. Seed each such length to a representative width so the
    // value renders, charge that width into `switchBytes`/`extLen` so the default
    // record holds it, and link the length to the inner budget via
    // `derivesBudgetKey` so PacketViewer grows `env[extLen]` with the live length
    // (every value in range stays crash-free and round-trips losslessly).
    const armValueLengths: {
      key: string;
      seed: number;
      bytesPerUnit: number;
    }[] = [];
    let armValueExtraBytes = 0;
    for (const k of numericKeys) {
      const armSiblingRefs = collectArmSiblingRefValueLengths(
        sw.cases[k].fields,
        siblingIds,
      );
      let armExtra = 0;
      for (const v of armSiblingRefs) {
        if (!armValueLengths.some((e) => e.key === v.key)) {
          armValueLengths.push(v);
        }
        armExtra += v.width;
      }
      // Charge the LARGEST arm's value bytes — one arm renders per record.
      armValueExtraBytes = Math.max(armValueExtraBytes, armExtra);
    }
    let innerBytes = 0;
    for (const f of c.fields) {
      if (f === sw) {
        innerBytes += switchBytes + armValueExtraBytes;
      } else {
        innerBytes += estimateElementBytes({ fields: [f] });
      }
    }
    innerBytes = Math.max(1, innerBytes);
    // Seed every length field the budget can select (both branches of a cond),
    // so whichever the live flag picks fits the representative arm. The inner
    // scope is one physical region, so it is charged `innerBytes` ONCE regardless
    // of how many length keys nominally size it.
    for (const key of budgetLengthKeys) {
      innerSeeds.push({ key, value: innerBytes });
      // Link each per-arm value length to THIS inner budget so PacketViewer grows
      // the budget when the length is raised above its seed.
      for (const v of armValueLengths) {
        innerSeeds.push({
          key: v.key,
          value: v.seed,
          ...(v.bytesPerUnit !== 1 ? { bytesPerUnit: v.bytesPerUnit } : {}),
          derivesBudgetKey: key,
        });
      }
    }
    perRecordBytes += innerBytes;
  }
  if (!sawNestedBounded) return null;
  perRecordBytes += Math.ceil(prefixBits / 8);
  return { innerSeeds, perRecordBytes: Math.max(1, perRecordBytes) };
}

/** Upper bound on the per-record inner length probed by
 *  `nestedGroupBoundedSeeds`, so a pathological record can't run the search
 *  unbounded. A representative CertID-shaped record fits well under this. */
const NESTED_GROUP_MAX_INNER_SEED = 64;
/** Per-record budget slack searched past the inner-length seed when probing the
 *  smallest budget that renders a given record count (covers the record's
 *  type/length prefix and any berLength encoding growth). */
const NESTED_GROUP_BUDGET_PROBE_SPAN = 16;

/**
 * Seed search for the PLAIN-GROUP nested-bounded idiom (ocspRequest `requests`):
 * a bounded eos repeat whose record wraps a PER-RECORD nested `bounded` sized by
 * a sibling length field, whose inner scope is a plain group / leaf set with NO
 * Switch. `tlvExtensionInnerSeeds` deliberately returns null for this shape
 * (its exact-fill berLengths and trailing `remaining` field can't be derived
 * statically — only specific inner-length values render byte-aligned without
 * tripping normalize's mid-byte `remaining` guard), so without this the repeat
 * lands in NEITHER freeRepeats NOR boundedRepeats and gets zero override surface:
 * the `reqListLength` slider is shown but instantiates no records, and every
 * CertID the diagram is shaped to show is see-but-cannot-edit.
 *
 * Because the crash-free inner length is not statically derivable, we PROBE it
 * with `resolveLayout` (the same path PacketViewer runs): for the smallest inner
 * length seed `S`, find the smallest outer budget that renders exactly one
 * record (`b1`) and exactly two (`b2`) without throwing. The on-wire record size
 * is `b2 - b1` (perRecordBytes) and the fixed outer overhead is `b1 -
 * recordBytes` (prefixBytes), both DERIVED from layout so the budget-driven
 * count `floor((budget - prefix)/perRecord)` exactly tracks how many records fit
 * and never over-consumes the scope. `defaultLength = b1` seeds one
 * representative record at load.
 *
 * Returns null (preserving the existing suppression) when the shape doesn't
 * match, the budget isn't a plain `ref(lengthKey)` (so seeding the field == the
 * budget), or no crash-free seed renders a record within the probe bounds.
 */
function nestedGroupBoundedSeeds(
  packet: PsdlPacket,
  repeat: Extract<Container, { kind: "repeat" }>,
  bounded: { key: string; prefix: number; bytes: Expr },
): {
  innerSeeds: {
    key: string;
    value: number;
    bytesPerUnit?: number;
    derivesBudgetKey?: string;
  }[];
  perRecordBytes: number;
  prefixBytes: number;
  defaultLength: number;
} | null {
  // The outer budget must be exactly `ref(lengthKey)`; only then does seeding
  // the length field equal seeding the budget so `defaultLength` is meaningful.
  if (bounded.bytes.kind !== "ref" || bounded.bytes.field !== bounded.key) {
    return null;
  }
  const element = repeat.element;
  // The record must wrap EXACTLY ONE direct-child nested bounded, sized by a
  // single ref to a sibling field, whose inner scope holds NO Switch (the
  // tlvExtensionInnerSeeds case) and NO deeper nested bounded (can't be safely
  // probed as a single inner length). Anything else stays non-auto-derived.
  const siblingIds = new Set<string>();
  collectRecordFieldIds(element.fields, siblingIds);
  let inner: Extract<Container, { kind: "bounded" }> | null = null;
  for (const c of element.fields) {
    if (isField(c)) continue;
    if (c.kind !== "bounded") {
      // A non-bounded container may still hide a nested bounded deeper; that is
      // not the flat per-record shape we can probe — bail.
      if (containsBounded([c])) return null;
      continue;
    }
    if (inner) return null; // more than one nested bounded — not this idiom
    inner = c;
  }
  if (!inner) return null;
  const innerRefs = exprRefs(inner.bytes);
  if (innerRefs.length !== 1 || !siblingIds.has(innerRefs[0])) return null;
  const innerKey = innerRefs[0];
  if (containsSwitch(inner.fields)) return null;
  if (inner.fields.some((f) => !isField(f) && containsBounded([f])))
    return null;

  // Build the same baseline env PacketViewer / the renderer-helpers use: preset
  // defaults plus 0-fill for every unresolved ref. We then overlay the repeat
  // count, the outer budget, and the candidate inner length, and check the
  // record actually renders without throwing.
  // The eos count is read straight from `env[repeat.id]`; the repeat does NOT
  // self-limit to the budget, so an over-large count over-consumes the scope and
  // throws. We therefore probe with the EXACT count and find the smallest budget
  // that renders that many records cleanly (no over-consume, no mid-byte
  // `remaining` throw). `recordFieldIds` are the declared record fields; a
  // rendered cell carries a per-instance suffix (`requestSeqTag#0`).
  const recordFieldIds = siblingIds;
  const rendersCount = (
    innerSeed: number,
    budget: number,
    count: number,
  ): boolean => {
    const env = new Map<string, number>(initialEnv(packet));
    for (const r of collectPsdlRefs(packet)) if (!env.has(r)) env.set(r, 0);
    env.set(repeat.id, count);
    env.set(bounded.key, budget);
    env.set(innerKey, innerSeed);
    // Match PacketViewer's layout env: it seeds dynamic-width leaves (varint /
    // delimited / berLength) to a visible default. A berLength octet inside the
    // inner scope now occupies its 8-bit default (it previously collapsed to 0),
    // so the probe MUST seed it too — otherwise the probed inner length / budget
    // undercount the record and the real (seeded) layout over-consumes the scope.
    seedDynamicWidthDefaults(packet, env);
    try {
      const { cells } = resolveLayout(packet, { env });
      return cells.some((c) => {
        const id = c.field.id;
        const hash = id.indexOf("#");
        return hash !== -1 && recordFieldIds.has(id.slice(0, hash));
      });
    } catch {
      return false;
    }
  };
  // Smallest budget that renders exactly `count` records at this inner seed.
  const minBudgetFor = (innerSeed: number, count: number): number => {
    const max =
      bounded.prefix + count * (innerSeed + NESTED_GROUP_BUDGET_PROBE_SPAN);
    for (let budget = 1; budget <= max; budget++) {
      if (rendersCount(innerSeed, budget, count)) return budget;
    }
    return 0;
  };
  for (
    let innerSeed = 1;
    innerSeed <= NESTED_GROUP_MAX_INNER_SEED;
    innerSeed++
  ) {
    // The smallest budget for one record (b1) and for two (b2). The on-wire
    // record size is `b2 - b1`, and the fixed outer overhead is `b1 -
    // recordBytes` — both DERIVED from layout so the budget-driven count
    // `floor((budget - prefix)/perRecord)` exactly tracks how many records fit
    // and never over-consumes the scope.
    const b1 = minBudgetFor(innerSeed, 1);
    if (!b1) continue;
    const b2 = minBudgetFor(innerSeed, 2);
    if (!b2 || b2 <= b1) continue;
    const recordBytes = b2 - b1;
    const prefixBytes = Math.max(0, b1 - recordBytes);
    // The inner scope holds per-record VALUE fields sized by their own sibling
    // length (ocspRequest CertID: `hashAlgData = bytes(ref hashAlgLength)`,
    // `serialNumberValue = bytes(ref serialNumberLength)`, …). The probe above
    // sized the budget with every such length at its 0 default (values empty),
    // so the instant an imported / shared / round-tripped packet carries a real
    // hash or serial, the value overruns `requestContentScope` and core throws
    // `bounded over-consumed` → the diagram FREEZES. Link each value length to
    // the inner budget (`requestSeqLength`) via `derivesBudgetKey` so PacketViewer
    // grows the budget with the live length, keeping every value crash-free and
    // round-trippable. (These berLength lengths aren't surfaced as controllers;
    // this purely hardens the import / share-URL path against the freeze.)
    const valueLengths = collectArmSiblingRefValueLengths(
      inner.fields,
      siblingIds,
    ).filter((v) => v.key !== innerKey);
    const valueLengthSeeds = valueLengths.map((v) => ({
      key: v.key,
      value: 0,
      ...(v.bytesPerUnit !== 1 ? { bytesPerUnit: v.bytesPerUnit } : {}),
      derivesBudgetKey: innerKey,
    }));
    return {
      innerSeeds: [{ key: innerKey, value: innerSeed }, ...valueLengthSeeds],
      perRecordBytes: recordBytes,
      prefixBytes,
      defaultLength: b1,
    };
  }
  return null;
}

/** True if any container in the tree is (or wraps) a `switch`. */
function containsSwitch(containers: Container[]): boolean {
  for (const c of containers) {
    if (isField(c)) continue;
    if (c.kind === "switch") return true;
    if (c.kind === "group" && containsSwitch(c.children)) return true;
    if (c.kind === "bounded" && containsSwitch(c.fields)) return true;
    if (c.kind === "optional" && containsSwitch([c.container])) return true;
    if (c.kind === "repeat" && containsSwitch(c.element.fields)) return true;
    if (c.kind === "encrypted" && containsSwitch(c.plaintext.fields)) {
      return true;
    }
  }
  return false;
}

/** Representative byte size we want a flat per-record `bytes(ref X)` value to
 *  RESOLVE to so one record's value renders (stun's stunAttrValue → 4 B).
 *  We solve for the seed of its length field X that yields ~this width, then
 *  charge the resolved width into perRecordBytes so the budget-derived outer
 *  count stays conservative. */
const FLAT_TLV_TARGET_VALUE_BYTES = 4;
/** Upper bound on the length-field seed we will search for, so a pathological
 *  budget expr (e.g. `X / 1000`) can't run the seed away unbounded. */
const FLAT_TLV_MAX_LEN_SEED = 64;

/**
 * Solve the length seed for a single `bytes(<expr over ONE sibling X>)` value so
 * the value resolves to ~`FLAT_TLV_TARGET_VALUE_BYTES`. The smallest seed
 * yielding a positive width wins (covers `ref X` → 4, `X - 4` → 8, `X * 4` → 1).
 * `bytesPerUnit` is the value's byte slope per +1 unit of X (`bytes(X)` → 1,
 * `bytes(X*4)` → 4) so a consumer can charge the EXACT extra bytes as X grows.
 * Returns null for a delimited / multi-ref / non-sibling-sized value, or when no
 * positive-width seed exists in range. Shared by `flatTlvInnerSeeds` (flat
 * triplet records) and the TLV-extension inner-arm scan (a value inside a nested
 * bounded's switch arm, e.g. tlsClientHello SNI `serverName = bytes(ref nameLen)`).
 */
function solveSiblingRefValueSeed(
  field: Container,
  siblingIds: Set<string>,
): { key: string; seed: number; bytesPerUnit: number; width: number } | null {
  if (!isField(field) || !isRefToSiblingBytes(field, siblingIds)) return null;
  const rawN = (field.type as Extract<typeof field.type, { kind: "bytes" }>).n;
  if (isBytesDelimited(rawN)) return null;
  const lenRefs = [...new Set(exprRefs(rawN))];
  if (lenRefs.length !== 1) return null; // multi-ref handled only by the flat path
  const key = lenRefs[0];
  let chosen: { seed: number; width: number } | null = null;
  for (let seed = 1; seed <= FLAT_TLV_MAX_LEN_SEED; seed++) {
    const width = evalExprOr(rawN, new Map([[key, seed]]), 0);
    if (width >= 1) {
      chosen = { seed, width };
      if (width >= FLAT_TLV_TARGET_VALUE_BYTES) break;
    }
  }
  if (!chosen) return null;
  const widthAt = (seed: number): number =>
    evalExprOr(rawN, new Map([[key, seed]]), 0);
  const bytesPerUnit = Math.max(
    1,
    widthAt(chosen.seed + 1) - widthAt(chosen.seed),
  );
  return { key, seed: chosen.seed, bytesPerUnit, width: chosen.width };
}

/**
 * Walk a switch arm's fields (descending plain groups, NOT nested bounded — those
 * own their own budget) and return each `bytes(ref X)` value sized by a sibling
 * length field X of the enclosing record, with the seed/slope/width that makes it
 * render. Used to grow a TLV-extension inner bounded budget to fit its own value.
 */
function collectArmSiblingRefValueLengths(
  containers: Container[],
  siblingIds: Set<string>,
): { key: string; seed: number; bytesPerUnit: number; width: number }[] {
  const out: {
    key: string;
    seed: number;
    bytesPerUnit: number;
    width: number;
  }[] = [];
  for (const c of containers) {
    if (isField(c)) {
      const v = solveSiblingRefValueSeed(c, siblingIds);
      if (v) out.push(v);
    } else if (c.kind === "group") {
      out.push(...collectArmSiblingRefValueLengths(c.children, siblingIds));
    }
    // bounded owns its own budget; switch/repeat/optional/encrypted are not the
    // simple per-arm value shape we grow the inner budget for.
  }
  return out;
}

/**
 * Detect a FLAT TLV-shaped record: a repeat element whose top-level fields are a
 * plain triplet `[…, lengthField X (int), …, valueField = bytes(expr over X)]`
 * with NO nested `bounded` (so it is not the TLV-extension idiom) and which is
 * not a single Switch (so it is not isTlvRepeat / TLV-promoted). This is the
 * stun / pppoe / bgpOpen / cops / gist / hip / ipfix / bgpLs / tlsCertificate
 * shape.
 *
 * The per-record length field X defaults to 0, so the value `bytes(expr over X)`
 * collapses to width 0 and is invisible — see-but-cannot-edit. We seed X so the
 * value resolves to a representative ~`FLAT_TLV_TARGET_VALUE_BYTES` so one
 * record's value renders, mirroring tlvExtensionInnerSeeds / isisLsp lengthSeeds.
 * The seed is SOLVED against the value's length Expr (not assumed to equal the
 * target), so an offset/scaled length (`copsObjLength - 4`, `gistObjLen * 4`)
 * still yields a visible value.
 *
 * Returns, when at least one flat value sized by a sibling length field is found:
 *   - `innerSeeds`: `{ key: X, value: <solved seed> }` per such length field,
 *   - `perRecordBytes`: the record's byte estimate with each seeded value charged
 *     its RESOLVED size (instead of the ~0-byte REF_SIZED allowance) so the
 *     budget-derived outer count stays conservative.
 * Returns `null` when the record carries a nested bounded (left to
 * tlvExtensionInnerSeeds), no flat sibling-sized value exists (no seed needed),
 * or no seed in range makes a value visible (don't fabricate a control).
 */
function flatTlvInnerSeeds(element: { fields: Container[] }): {
  innerSeeds: { key: string; value: number; bytesPerUnit?: number }[];
  perRecordBytes: number;
} | null {
  // A record wrapping its OWN nested bounded is the TLV-extension idiom handled
  // elsewhere; this flat path only covers bounded-free records.
  if (containsBounded(element.fields)) return null;
  const siblingIds = new Set<string>();
  collectRecordFieldIds(element.fields, siblingIds);
  const innerSeeds: { key: string; value: number; bytesPerUnit?: number }[] =
    [];
  const seededKeys = new Set<string>();
  // Resolve a single sibling-ref `bytes` value field: push its length seed(s)
  // (deduped via `seededKeys`) and return the bytes the value resolves to once
  // seeded, or null when the field is not a sibling-ref bytes value or no
  // positive-width seed exists in range.
  const processField = (c: Container): number | null => {
    if (!isField(c) || !isRefToSiblingBytes(c, siblingIds)) return null;
    const rawN = (c.type as Extract<typeof c.type, { kind: "bytes" }>).n;
    // isRefToSiblingBytes already excluded the delimited form; narrow here.
    if (isBytesDelimited(rawN)) return null;
    const n = rawN;
    // Dedup — a `cond(test: ref X, t: X - 4, …)` length names X several times.
    const lenRefs = [...new Set(exprRefs(n))];
    // Solve the SINGLE length ref for a seed that makes the value resolve to
    // ~FLAT_TLV_TARGET_VALUE_BYTES. The smallest seed yielding a positive
    // width wins (covers `ref X` → 4, `X - 4` → 8, `X * 4` → 1). A value
    // referencing several length fields (none in the affected presets) is
    // seeded best-effort with the target on each ref.
    if (lenRefs.length === 1) {
      const key = lenRefs[0];
      let chosen: { seed: number; width: number } | null = null;
      for (let seed = 1; seed <= FLAT_TLV_MAX_LEN_SEED; seed++) {
        const width = evalExprOr(n, new Map([[key, seed]]), 0);
        if (width >= 1) {
          chosen = { seed, width };
          if (width >= FLAT_TLV_TARGET_VALUE_BYTES) break;
        }
      }
      if (!chosen) return null; // no positive-width seed in range — skip
      if (!seededKeys.has(key)) {
        seededKeys.add(key);
        // Byte slope of the value per +1 unit of the length field, so a
        // consumer (PacketViewer's bounded derive) can charge the EXACT extra
        // bytes when the field is raised above its seed — `bytes(X)` → 1,
        // `bytes(X * 4)` (gist `gistObjLen`) → 4. Without this a scaled value
        // over-consumes the bounded scope as the field grows.
        const widthAt = (seed: number): number =>
          evalExprOr(n, new Map([[key, seed]]), 0);
        const bytesPerUnit = Math.max(
          1,
          widthAt(chosen.seed + 1) - widthAt(chosen.seed),
        );
        innerSeeds.push(
          bytesPerUnit !== 1
            ? { key, value: chosen.seed, bytesPerUnit }
            : { key, value: chosen.seed },
        );
      }
      return chosen.width;
    }
    const env = new Map(lenRefs.map((r) => [r, FLAT_TLV_TARGET_VALUE_BYTES]));
    const width = evalExprOr(n, env, 0);
    if (width < 1) return null;
    for (const r of lenRefs) {
      if (seededKeys.has(r)) continue;
      seededKeys.add(r);
      innerSeeds.push({ key: r, value: FLAT_TLV_TARGET_VALUE_BYTES });
    }
    return width;
  };
  // Walk the record's flat top level (descending through plain groups, which
  // some presets use to wrap the type/length prefix) to find a value field whose
  // length references ONLY a sibling field in the same record. Returns the
  // resolved value bytes / value-field count contributed by `containers`.
  const scan = (containers: Container[]): { bytes: number; fields: number } => {
    let bytes = 0;
    let fields = 0;
    for (const c of containers) {
      if (isField(c)) {
        const width = processField(c);
        if (width != null) {
          bytes += width;
          fields += 1;
        }
      } else if (c.kind === "group") {
        const inner = scan(c.children);
        bytes += inner.bytes;
        fields += inner.fields;
      } else if (c.kind === "switch") {
        // A switch arm value sized by a sibling length (isisLsp tlvLength,
        // tlsClientHello nameLen, ocspRequest *Length) lives INSIDE the arm, not
        // as a flat record sibling. `collectRecordFieldIds` already counts arm
        // fields as siblings, so `processField` resolves them — but only one arm
        // renders per record, so charge perRecordBytes the LARGEST arm (union of
        // all arms' seeded keys via the shared `seededKeys`/`innerSeeds`).
        let maxBytes = 0;
        let maxFields = 0;
        for (const s of Object.values(c.cases)) {
          const arm = scan(s.fields);
          if (arm.bytes > maxBytes) {
            maxBytes = arm.bytes;
            maxFields = arm.fields;
          }
        }
        bytes += maxBytes;
        fields += maxFields;
      }
      // bounded is excluded above (containsBounded short-circuits the whole
      // record); repeat/optional/encrypted are not the flat shape and contribute
      // no flat sibling-sized seed.
    }
    return { bytes, fields };
  };
  const scanned = scan(element.fields);
  // Bytes the seeded value(s) resolve to, and the count of VALUE fields whose
  // width we resolved (each was charged the ~0-byte REF_SIZED allowance by
  // estimateElementBytes, which perRecordBytes below replaces). A switch arm's
  // value counts the LARGEST arm only — one arm renders per record.
  const resolvedValueBytes = scanned.bytes;
  const resolvedValueFields = scanned.fields;
  if (innerSeeds.length === 0) return null;
  // Per-record estimate charging each seeded value its RESOLVED size: start from
  // the conservative estimate (which charges each ref-sized VALUE field only the
  // ~0-byte REF_SIZED allowance) and replace that allowance with the resolved
  // width for every value we seeded.
  const perRecordBytes =
    estimateElementBytes(element) +
    resolvedValueBytes -
    resolvedValueFields * REF_SIZED_FIELD_BYTE_ALLOWANCE;
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
 * The MINIMUM whole bytes a switch arm's content occupies: the sum of its
 * FIXED-width leaf fields only. Every variable-length leaf (a `bytes(remaining)`
 * / delimited / sibling-ref value, a varint, a nested repeat) is charged 0 — it
 * flexes to fill whatever budget the enclosing bounded scope provides and so
 * imposes no minimum. Used to seed a per-record inner-bounded length large enough
 * for the LARGEST selectable arm without over-counting a `remaining`-style value
 * as the 64 B unbounded allowance (which would bury records behind a huge length
 * plateau). Descends through transparent/structural containers; a nested Switch
 * contributes its largest arm.
 */
function armMinFixedBytes(containers: Container[]): number {
  let bits = 0;
  for (const c of containers) {
    if (isField(c)) {
      const w = typeBits(c.type);
      if (w > 0) bits += w; // fixed width; variable leaves contribute 0
      continue;
    }
    if (c.kind === "group") bits += armMinFixedBytes(c.children) * 8;
    else if (c.kind === "bounded") bits += armMinFixedBytes(c.fields) * 8;
    else if (c.kind === "optional") bits += armMinFixedBytes([c.container]) * 8;
    else if (c.kind === "switch") {
      let maxCase = 0;
      for (const s of Object.values(c.cases)) {
        maxCase = Math.max(maxCase, armMinFixedBytes(s.fields));
      }
      bits += maxCase * 8;
    }
    // repeat / encrypted / align / virtual impose no minimum.
  }
  return Math.ceil(bits / 8);
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
        // Suppress an inert peek picker whose every selectable arm renders to
        // the same geometry: choosing any case can't change the diagram, so the
        // dropdown is a misleading see-but-cannot-edit control. Mirrors the
        // structural-identity gate `attachOverrideMetadata` /
        // `collectRefSwitches` apply to ref-discriminated pickers.
        //
        // EXCEPTION: even when every LISTED arm renders identically, a present
        // `_` default arm whose geometry DIFFERS from those listed arms makes
        // the picker live — selecting a listed value vs. falling through to the
        // distinct default changes the diagram. snmpV2c's `pduSwitch` is exactly
        // this: its 8 PDU-type arms render the same ASN.1 envelope (differing
        // only by per-arm field id / NAME), but its `_` default `unknownPdu` is
        // a degenerate 3-field stub. With the picker suppressed, the unset peek
        // 0-fills → selects `_` → the diagram loads only the Unknown-PDU stub
        // with no surface to reveal any real PDU (see-but-cannot-edit). When the
        // listed arms differ only by name we still surface the picker so the
        // user can name the PDU and, critically, escape the stub.
        const defaultCase = defaultArmSyntheticCase(c.cases);
        const armsLook = !switchArmsRenderIdentical(c.cases);
        if (c.on.kind === "peek" && (armsLook || defaultCase)) {
          const cases: { value: number; label: string }[] = [];
          for (const [key, struct] of Object.entries(c.cases)) {
            const v = firstCaseKeyValue(key);
            if (v === null) continue;
            cases.push({
              value: v,
              label: struct.name ?? prettifyId(struct.id) ?? `case ${key}`,
            });
          }
          // Reach the structurally-distinct `_` default arm (rohcUncompressed
          // `rohcHeader`: listed `126`=IR Packet vs `_`=normal datagram), so
          // the peek picker can select the default-arm layout instead of only
          // the listed value(s). The sentinel value is unlisted, so core's
          // `selectArm` falls through to `_`. When the listed arms genuinely
          // differ, `unshift` (not `push`) places the default FIRST so
          // `initialState` seeds the basic default shape (the RFC 5795 normal
          // datagram) rather than the special listed value (ROHC IR 126); for a
          // switch-nested option-list switch (icmpv6Ndp's NDP option types) the
          // same generic "unknown option" `_` arm is also a real, RFC-defined
          // reachable state, so it is surfaced first too.
          //
          // But when the picker is surfaced ONLY because the default differs
          // (the listed arms render identically — snmpV2c's pduSwitch, whose `_`
          // is the degenerate "Unknown PDU" stub), placing the default first
          // would seed the load to that stub — the very see-but-cannot-edit
          // state we are fixing. So `push` it LAST, leaving the first real
          // listed PDU tag (160 GetRequest) as `cases[0]` for `initialState` to
          // seed — the diagram then shows a real PDU on load.
          if (defaultCase) {
            if (armsLook) cases.unshift(defaultCase);
            else cases.push(defaultCase);
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
              // Anchor a `fieldRendered` gate on a representative inner field id
              // of the arm `initialState` seeds (cases[0].value). A peek picker
              // whose arm isn't currently drawn — its enclosing repeat has no
              // record, or it sits in an absent `optional{when: ref(X)}` region —
              // would read live over a diagram drawing nothing (peekSwitches were
              // never `fieldRendered`-gated). When the seeded arm IS drawn (every
              // built-in preset renders its seeded arm at load) the anchor field
              // is a rendered cell, so the picker stays live and nothing
              // regresses. Anchor on the seeded arm specifically so the gate isn't
              // satisfied by a DIFFERENT arm's field; the synthetic `_` default
              // case (sentinel value not in `c.cases`) anchors on the `_` arm.
              const seededArm =
                findArmByCaseValue(c.cases, cases[0]!.value) ?? c.cases["_"];
              const gateFieldId = seededArm
                ? (firstInnerFieldId(seededArm.fields) ?? undefined)
                : undefined;
              out.push({
                id: c.id,
                name: c.name ?? c.id,
                cases,
                peekKey,
                ...(gateFieldId !== undefined ? { gateFieldId } : {}),
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
        // An opaque (`wireBits`-bounded) encrypted node renders as ciphertext in
        // the default (wire) view — its plaintext switch/optional is never
        // instantiated, so any peek picker surfaced from inside would be inert
        // and contradict the opaque blob the diagram shows (QUIC's frame
        // switch). Don't descend into opaque plaintext (matches
        // `collectEncryptedNestedFieldIds`).
        if (c.wireBits === undefined)
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

  // Find the Group (after flattening transparent scopes) within `scope` that
  // transitively contains a leaf Field with `id`. Used to lazily surface a
  // bit-leaf gate target that `groupToSubfieldField` dropped because the Group
  // also nests a sub-group (so it bailed entirely — gtpv2c's `gtpv2Flags`,
  // which nests `gtpv2SpareGroup`, never reached the mirror, hiding `gtpv2T`).
  // `scope` defaults to the packet body, but the repeat-element recursion
  // passes its own element children so a flags group that lives INSIDE a
  // repeat element (diameter's `avpFlagsGroup`, owning the `avpFlagV` gate of
  // the optional 32-bit `avpVendorId`) is reachable — `flattenForMirror` never
  // descends into a repeat, so the body-only walk could not see it.
  const groupOwning = (id: string, scope: Container[]): Group | null => {
    const containsLeaf = (children: Group["children"]): boolean => {
      for (const child of children) {
        if (isField(child)) {
          if (child.id === id) return true;
        } else if (child.kind === "group" && containsLeaf(child.children)) {
          return true;
        }
      }
      return false;
    };
    for (const c of flattenForMirror(scope, defs)) {
      if (!isField(c) && c.kind === "group" && containsLeaf(c.children)) {
        return c;
      }
    }
    return null;
  };

  // Resolve an Optional's gate `ref` to a stampable target, lazily surfacing
  // its enclosing Group as a deep subfield-bearing mirror field when the gate
  // is a bit leaf that `groupToSubfieldField` collapsed away. Without this the
  // user can SEE the gate flag (and the gated region appear/disappear) but has
  // no control to toggle it — a see-but-cannot-edit dead end. `scope` is the
  // container list currently being visited so a gate owned by a group nested in
  // a repeat element is found in the element's own scope, not just the body.
  const findOrSurfaceGateTarget = (
    id: string,
    scope: Container[],
  ): ReturnType<typeof findTarget> => {
    const direct = findTarget(id);
    if (direct) return direct;
    const owner = groupOwning(id, scope) ?? groupOwning(id, body);
    if (!owner) return null;
    // If the owning Group already surfaced (flat collapse), the leaf is a
    // subfield on it and findTarget would have found it; reaching here means it
    // did not surface. Build a deep collapse so every bit leaf is reachable.
    if (fields.some((x) => x.id === owner.id)) return null;
    const deep = groupToSubfieldFieldDeep(owner);
    if (!deep) return null;
    fields.push(deep);
    const sub = deep.subfields?.find((s) => s.id === id);
    return sub ? { kind: "subfield", sub } : null;
  };

  // Pull the primary ref id out of an Expr — the first field referenced
  // anywhere in it, or null. Backed by core's `exprRefs`, so 0.5 shapes
  // (lookup keys, peek offsets, …) surface a controller too; `op` / `cond`
  // behaviour is unchanged (first ref in walk order still wins).
  const primaryRef = (expr: import("../types").Expr): string | null =>
    exprRefs(expr)[0] ?? null;

  // Map every body `virtual` field id → the refs of its expr. An Optional whose
  // `when` is `ref(V)` where V is a virtual has NO cell to stamp (a virtual is
  // computed, never written), so `findOrSurfaceGateTarget(V)` finds nothing and
  // the gated region is see-but-cannot-edit (gtpv1u / gtpv1c: the optional
  // Sequence-Number / N-PDU / Next-Ext-Header block is gated on the virtual
  // `gtpOptPresent = gtpE | gtpS | gtpPN`). Expanding the virtual to its driving
  // refs lets us stamp each real bit leaf (gtpE / gtpS / gtpPN) as a
  // Present/Absent toggle whose env truthiness ORs back into the virtual.
  // A virtual gate only maps cleanly to per-leaf Present/Absent toggles when
  // its expr is a pure OR of refs (`gtpE | gtpS | gtpPN`): the region is present
  // iff at least one leaf is truthy, so flipping ANY leaf's env truthiness ORs
  // back into the virtual exactly. A virtual built from a `cond` / comparison
  // (rtmp's `tsSentinel = (fmt==0 && timestamp0==0xFFFFFF) || …`) does NOT — its
  // presence hinges on a specific VALUE of an operand, so a checkbox that writes
  // 0/1 onto that operand would be inert or misleading (the same trap the plain
  // op/cond gate guard above avoids). Only OR-of-refs virtuals are expanded.
  const isOrOfRefs = (expr: import("../types").Expr): boolean => {
    if (expr.kind === "ref") return true;
    if (expr.kind === "op" && expr.op === "|") {
      return isOrOfRefs(expr.a) && isOrOfRefs(expr.b);
    }
    return false;
  };
  const virtualRefs = new Map<string, string[]>();
  const virtualIds = new Set<string>();
  const collectVirtuals = (containers: Container[]): void => {
    for (const c of containers) {
      if (isField(c)) continue;
      if (c.kind === "virtual") {
        virtualIds.add(c.id);
        if (isOrOfRefs(c.expr)) virtualRefs.set(c.id, exprRefs(c.expr));
      } else if (c.kind === "group") collectVirtuals(c.children);
      else if (c.kind === "bounded") collectVirtuals(c.fields);
      else if (c.kind === "optional") collectVirtuals([c.container]);
      else if (c.kind === "encrypted") collectVirtuals(c.plaintext.fields);
      else if (c.kind === "repeat") collectVirtuals(c.element.fields);
      else if (c.kind === "switch") {
        for (const struct of Object.values(c.cases))
          collectVirtuals(struct.fields);
      } else if (c.kind === "ref") {
        const def = defs?.[c.ref];
        if (def) collectVirtuals(def.fields);
      }
    }
  };
  collectVirtuals(body);

  // Resolve a gate ref to the set of concrete (non-virtual) ref ids that drive
  // it: a virtual expands (transitively) to its expr's refs; a plain ref stays
  // itself. Virtuals that reference other virtuals chain through.
  const resolveGateRefs = (ref: string): string[] => {
    if (!virtualIds.has(ref)) return [ref];
    // A virtual that is not a pure OR-of-refs (`cond` / comparison / literal)
    // has no expansion we can map to toggles → drive nothing (the gated region
    // surfaces its control elsewhere, or is structurally fixed like a `lit`).
    if (!virtualRefs.has(ref)) return [];
    const out: string[] = [];
    const pending = [ref];
    const expanded = new Set<string>();
    while (pending.length > 0) {
      const r = pending.pop()!;
      if (expanded.has(r)) continue;
      expanded.add(r);
      const refs = virtualRefs.get(r);
      if (!refs) {
        // A concrete leaf (or a virtual we chose not to expand).
        if (!virtualIds.has(r)) out.push(r);
        continue;
      }
      for (const inner of refs) pending.push(inner);
    }
    return out;
  };

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
        // `bytes(ref tlsHandshakeBodyLen)`).
        if (switchArmsAllIdentical(c.cases)) continue;
        // Suppress a field-level `switchCases` picker whose LISTED arms are all
        // mutually identical: every offered listed value yields a byte-identical
        // layout. The diverging `_` arm IS reachable below (we append a
        // defaultArmSyntheticCase, mirroring the peek path), but eap's `eapCode`
        // — the sole preset this catches — is ALSO an `enum(8)` discriminator
        // covering 1–4, and its EnumDropdown (on the same env key) already drives
        // every meaningful state including the empty `_` body at 3 / 4. Surfacing
        // a second, raw-labelled switch picker on the same key would only add an
        // inert (listed arms identical), enum-colliding control; suppress it.
        if (listedArmsAllIdentical(c.cases)) continue;
        // Reach a structurally-distinct `_` default arm through a field-level
        // `switchCases` dropdown, exactly as the peek-switch path does
        // (defaultArmSyntheticCase + unshift, above). Without this the dropdown
        // offers only the LISTED case values, so a Switch whose `_` arm differs
        // from every listed arm is see-but-cannot-edit: the `_`-arm layout
        // renders on the diagram (e.g. http3Frame `payload` at an unlisted
        // http3FrameType, icmpv6Ndp `ndpOpaque` at an unlisted type) but no
        // offered value selects it, and an imported packet whose discriminator
        // falls in `_` cannot round-trip-select. The sentinel value is unlisted,
        // so core's `selectArm` falls through to `_`. `unshift` keeps the
        // default option first. Presets whose discriminator ALSO carries an
        // EnumDropdown on the same env key (ipv6Routing, mobilityHeader, …) were
        // only coincidentally rescued by the enum; this makes the picker itself
        // complete.
        const defaultCase = defaultArmSyntheticCase(c.cases);
        if (defaultCase) cases.unshift(defaultCase);
        if (c.on.kind === "ref") {
          const t = findTarget(c.on.field);
          if (t) {
            if (t.kind === "field") {
              t.field.switchCases = cases;
              // A field that is ALSO the discriminator owns a single env key,
              // and the switchCases picker writes the discriminator VALUE into
              // it. If the same field is dynamic-width (a varint / berLength /
              // delimited bytes — http3Frame's `http3FrameType`), do NOT also
              // surface a WidthPicker on it: that picker would write the same
              // key as a wire width, colliding with the case value. The width
              // is decoupled onto `__varintBits__<id>` (bridge / seed), so the
              // cell still renders at a sane varint width.
              delete t.field.varintEncoding;
              delete t.field.isBerLength;
              delete t.field.isDelimited;
            } else t.sub.switchCases = cases;
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
        // Only a *simple* `when: ref(X)` gate maps cleanly to a Present/Absent
        // toggle on X — the toggle writes `env[X] = 1|0`, which only makes
        // sense when X's truthiness IS the gate. A complex `when` (op/cond)
        // must NOT fall back to its primary ref: that ref is some operand of
        // the predicate (e.g. rtcpBye's `((length+1)*4-4-4) > srcCount*4`
        // nominates `length`, the 32-bit RTCP word count), and stamping
        // `optionalGateFor` on it renders a checkbox whose onChange corrupts
        // that field to 0/1 without intuitively mapping to the gated field's
        // presence (override-audit: rtcpBye). For such gates the controlling
        // value is surfaced through its own editor instead (e.g. the
        // length-driven reason string via `collectOptionalLengthGates`).
        if (c.when.kind === "ref") {
          // A virtual gate (`when: ref(V)` where V has no cell) expands to the
          // real bits its expr ORs together — gtpv1u / gtpv1c's `gtpOptPresent =
          // gtpE | gtpS | gtpPN`. Each driving leaf becomes a Present/Absent
          // toggle whose env truthiness feeds back into the virtual, so the
          // gated block is finally controllable. A plain ref expands to itself.
          for (const ref of resolveGateRefs(c.when.field)) {
            const t = findOrSurfaceGateTarget(ref, containers);
            if (t) {
              if (t.kind === "field") {
                t.field.optionalGateFor = [
                  ...(t.field.optionalGateFor ?? []),
                  gated,
                ];
              } else {
                t.sub.optionalGateFor = [
                  ...(t.sub.optionalGateFor ?? []),
                  gated,
                ];
              }
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
