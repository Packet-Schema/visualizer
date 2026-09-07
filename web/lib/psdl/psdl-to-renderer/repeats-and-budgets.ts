// Extracted from `index.ts` (PSDL → renderer adapter) — no logic changes.

import { isField } from "../utils";
import { evalExprOr, exprRefs } from "../expr";
import { isBytesDelimited } from "../normalize";
import { seedDynamicWidthDefaults } from "../dynamic-width-defaults";
import type { Container, Expr, Packet as PsdlPacket, Repeat } from "../types";
import type {
  Field as RendererField,
  Packet as RendererPacket,
} from "../renderer";
import { isLikelyChainRepeat } from "./chain";
import { isTlvRepeat } from "./tlv";
import { firstCaseKeyValue, typeBits } from "./shared";
import { resolveLayout } from "../layout";
import { initialEnv } from "../normalize";
import { collectPsdlRefs } from "../collect-refs";
import {
  refsIn,
  collectEnumVariants,
  collectFieldNames,
  collectVirtualIds,
  collectSelfRefVirtualIds,
  firstInnerFieldId,
  matchPeekGate,
} from "./psdl-queries";
import { switchCaseLabel } from "./switch-arms";

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
 * A Repeat whose count is a compile-time literal >= 1 ALWAYS materialises its
 * records — there is no control that adds/removes them, but the diagram renders
 * the fixed number of iterations unconditionally. Such a repeat is therefore
 * "instantiable" for the purpose of surfacing controls on cells INSIDE its
 * records: an inner record-variant switch / nested option-list repeat lives in
 * a region the user can SEE on every load, so its variant picker / count stepper
 * is a live control (the discriminator / count drives every rendered instance
 * uniformly — the documented A7 per-record tradeoff). Without treating a
 * literal-count repeat as instantiable, an inner refSwitch / nested-TLV repeat
 * one level down is suppressed as "never-rendered" even though the records are
 * always on screen — a see-but-cannot-edit gap for arbitrary PSDL (no built-in
 * preset nests a record-variant switch under a literal-count repeat). Returns
 * the literal count, or null when the count is dynamic (eos/until/ref/op/cond).
 */
function repeatLiteralCount(repeat: Repeat): number | null {
  const count = repeat.count;
  if (
    typeof count === "object" &&
    "kind" in count &&
    count.kind === "lit" &&
    count.value >= 1
  ) {
    return count.value;
  }
  return null;
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
export function collectFreeRepeats(
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
  // Visited ref-def names on the current descent path; guards a self/mutually
  // recursive `defs` reference from recursing forever.
  const visitRefSeen = new Set<string>();
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
    // Peek-gate `{ key: __peek__<off>__<bits>, value }` of the nearest enclosing
    // `optional{when: peek(N)==lit}` whose region wraps a count-driven repeat
    // (rohcUncompressed's rohcPadding / rohcFeedback: `optional(peek==224|30){
    // group{ until-repeat } }`). The until-repeat surfaces as a freeRepeat with
    // its own count stepper, so collectPeekSwitches DELIBERATELY suppresses the
    // entry peek-gate picker (optionalWrapsSurfacedRepeat) — leaving NO surfaced
    // control to enter the region. Carry the gate here so the freeRepeat records
    // `peekGate` and `initialState` can seed `env[key]=value` on load: the region
    // is entered, the stepper is live (gateFieldId renders), and lowering it to 0
    // still hides the records. Null outside such an optional. Share-url-default-
    // safe (same default-set pattern as the refSwitch / freeRepeat gate seeds).
    optionalPeekGate: { key: string; value: number } | null,
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
          // A bounded byte-budget is a transparent wrapper on the optional's
          // always-present spine — keep the enclosing peek-gate.
          optionalPeekGate,
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
        if (visitRefSeen.has(c.ref)) continue;
        const def = defs?.[c.ref];
        if (def) {
          visitRefSeen.add(c.ref);
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
            // A ref is a transparent wire scope — keep the enclosing peek-gate.
            optionalPeekGate,
          );
          visitRefSeen.delete(c.ref);
        }
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
        //
        // ONE LEVEL DEEPER (arbitrary PSDL): the same TLV-shaped repeat can live
        // inside a switch case (or optional) that is ITSELF inside another repeat
        // — e.g. `repeat lit N { switch on kind { case: repeat eos { switch on
        // peek } } }`. The `!insideRepeat` guard suppressed it there, so the inner
        // option cells render per outer instance (`#i_j`) but get NO count stepper
        // or peek picker (see-but-cannot-edit). Relax the guard to also allow the
        // insideRepeat case, but ONLY when the enclosing repeat is itself
        // instantiable (`enclosingInstantiable` — its records actually render, so
        // the inner repeat's records are on screen). The surfaced stepper is keyed
        // on the repeat's bare id (`env[repeat.id]`), which core's eos-count
        // injection reads for EVERY outer instance — so it drives all instances
        // uniformly (the documented A7 per-record tradeoff), exactly like the
        // existing in-repeat ref-count steppers. Per-instance switch/peek
        // discrimination is NOT representable (core reads the switch `on` from the
        // bare discriminator key, never a `#i`-qualified one), so a single shared
        // control is the correct, non-inert surface. No built-in preset nests this
        // deep, so only the arbitrary-PSDL gap is newly filled.
        // DIRECT repeat-of-repeat (arbitrary PSDL): the TLV-shaped repeat can
        // also be a DIRECT child of an OUTER repeat's element with NO intervening
        // switch case or optional — `repeat lit N { repeat eos { switch on peek
        // } }`. Here insideSwitch=insideOptional=false (the inner repeat is reached
        // straight through the outer repeat's element descent), so the
        // switch/optional branch never fires and the inner option records render
        // per outer instance (`ikd#i_j`) with NO count stepper or peek picker
        // (see-but-cannot-edit). Allow `insideRepeat && enclosingInstantiable` as
        // an INDEPENDENT qualifying branch: when the enclosing repeat is itself
        // instantiable its records are on screen, so the inner repeat's records are
        // too. Same A7 tradeoff as the deeper switch-nested case — the surfaced
        // stepper is keyed on the repeat's bare id (`env[repeat.id]`), which core's
        // eos-count injection reads for EVERY outer instance, so one shared control
        // drives them all and the peek discriminator (bare key) is likewise shared.
        // No built-in preset hits this exact shape (rtcpSdesItems / lispRecLocators
        // carry a discriminator FIELD before the switch, so isTlvRepeat is false),
        // so only the arbitrary-PSDL gap is filled.
        const surfacedNestedTlv =
          isTlvRepeat(c) &&
          (insideSwitch || insideOptional
            ? !insideRepeat || enclosingInstantiable
            : insideRepeat && enclosingInstantiable);
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
              // A RECORD-BEARING element whose variant switch has an arm that is
              // purely a scope-terminated (eos/until) repeat — bgpFlowSpec's `_`
              // Op-List arm of `flowSpecCompValue`, holding the `flowSpecOps`
              // operator/value-pair list. That inner repeat is deliberately NOT
              // surfaced as a free stepper (it lives insideRepeat + insideBounded,
              // so a naked stepper would over-consume this budget-derived scope —
              // ref-switch.test.ts:679) and 0-fills to 0, so picking that arm
              // collapses the component to its bare 1-byte discriminator and every
              // pair is invisible with no control to add it (see-but-cannot-edit).
              // Seed each such repeat id to 1 via `innerScopeSeeds` (the same
              // mechanism `prefixLength`/`extLen` use): `initialState` writes it to
              // `env[id]`, which the until-repeat reads as its count, materialising
              // ONE representative pair the instant the arm is picked. The seed is
              // NOT a surfaced control, so the no-free-stepper guard stays intact;
              // `perRecordBytes` (the conservative prefix-arm estimate) already
              // covers the smaller op-list record, so the count never over-consumes.
              const innerScopeRepeatSeeds = recordSwitchInnerScopeRepeatIds(
                c.element.fields,
              ).map((id) => ({ key: id, value: 1 }));
              const innerScopeSeeds = [
                ...(flat ? flat.innerSeeds : []),
                ...innerScopeRepeatSeeds,
              ];
              boundedOut.push({
                countKey: c.id,
                lengthKey: bounded.key,
                bytesExpr: bounded.bytes,
                perRecordBytes: perRecordBytesFlat,
                prefixBytes: bounded.prefix,
                ...(innerScopeSeeds.length > 0 ? { innerScopeSeeds } : {}),
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
              // An arm-nested segment record can itself carry a per-record
              // ref-count repeat sized by a SIBLING length field
              // (bgpUpdateFull AS_PATH segment = `[bgpAsSegType, bgpAsSegLength,
              // bgpAsSegValue = repeat count:ref(bgpAsSegLength)]`): the inner
              // repeat draws one AS-number cell per `bgpAsSegLength`, so the AS
              // count IS editable in principle, but the ref-count stepper is
              // suppressed (`!insideBounded`) because a naked stepper inside this
              // saturated budget over-consumes the scope and freezes the diagram.
              // The user then SEES AS-number cells they cannot add to or remove —
              // a see-but-cannot-edit gap on AS_PATH, a defining BGP field.
              //
              // Surface that sibling length as an innerScopeSeed so (a)
              // `collectFlatTlvInnerLengthControllers` gives it a length-style
              // slider (this record wraps NO nested bounded, so it is eligible),
              // and (b) PacketViewer charges its live overage into the per-record
              // byte cost. Raising the AS count grows each segment, which SHRINKS
              // the budget-derived segment count to stay within the fixed
              // per-attribute budget — never over-consuming the scope (no freeze)
              // — while the AS-number list under the rendered segment(s) grows
              // with the slider. Deliberately NO `derivesBudgetKey`: the segment
              // budget is itself the inner budget of the EARLIER-processed
              // `bgpPathAttributes` repeat, so growing it here (after that
              // repeat's count was already derived) would not enlarge the outer
              // total in the same memo pass and could collapse the attribute
              // record. The safe in-scope shrink keeps every selectable
              // attrTypeCode / attrExtLen rendering.
              const innerSeed = findInnerSiblingRefCountSeed(c.element);
              boundedOut.push({
                countKey: c.id,
                lengthKey: caseNestedBudget.lengthKeys[0],
                bytesExpr: caseNestedBudget.bytes,
                perRecordBytes: estimateElementBytes(c.element),
                prefixBytes: 0,
                ...(innerSeed ? { innerScopeSeeds: [innerSeed] } : {}),
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
            // When the enclosing optional is peek-gated (rohcUncompressed's
            // `optional(peek==224|30){ group{ until-repeat } }`), carry the gate's
            // present value so `initialState` seeds env[key]=value and the region
            // is ENTERED on load. Without it the gate peek (a no-byte expr with no
            // dedicated widget) 0-fills, the optional is never entered, gateFieldId
            // never renders, and OverridePanel disables this stepper with a hint
            // pointing at a field the user has NO surfaced control to set — a
            // permanently-inert see-but-cannot-edit gap. The peek picker is
            // suppressed here (optionalWrapsSurfacedRepeat) precisely because this
            // stepper is the live control, so the seed is the missing piece.
            const peekGate =
              insideOptional && !gate
                ? (optionalPeekGate ?? undefined)
                : undefined;
            out.push({
              name: qualifiedName,
              countKey,
              ...(defaultCount !== undefined ? { defaultCount } : {}),
              ...(transform !== undefined ? { transform } : {}),
              ...(gate !== undefined ? { gate } : {}),
              ...(gateFieldId !== undefined ? { gateFieldId } : {}),
              ...(peekGate !== undefined ? { peekGate } : {}),
            });
            instantiableRepeatIds.add(c.id);
          }
        }
        // A LITERAL-count repeat (count: lit N>=1) has no surfaced count control
        // — its records are fixed — but it ALWAYS renders those records, so cells
        // inside them are genuinely on screen and any inner record-variant switch
        // / nested option-list repeat is a live, editable surface. Mark it
        // instantiable so the descent below sets `enclosingInstantiable` and the
        // inner refSwitch / TLV-repeat is surfaced instead of suppressed as
        // never-rendered (see-but-cannot-edit for arbitrary PSDL; no preset nests
        // this deep). Done here, AFTER the control branches, so a repeat that
        // already earned a surfaced control keeps it and a literal-count one still
        // counts as instantiable for its children.
        if (repeatLiteralCount(c) !== null) instantiableRepeatIds.add(c.id);
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
          // A repeat element is its own scope (insideOptional cleared above) — the
          // enclosing optional's peek-gate no longer applies to its records.
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
          // A group is a transparent wrapper on the optional's always-present
          // spine — keep the enclosing peek-gate so a repeat directly inside the
          // group (rohcPadding / rohcFeedback under `optional{ group{ repeat }}`)
          // carries it.
          optionalPeekGate,
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
            // A switch case is a flattened scope (insideOptional cleared above),
            // not the optional's always-present spine — drop the peek-gate.
            null,
          );
        }
        continue;
      }
      if (c.kind === "optional") {
        // Mark the descent so a TLV-shaped repeat directly inside this optional
        // gets its count/variant controls surfaced (see the guard above).
        //
        // When the optional's `when` is `peek(N)==lit` (rohcUncompressed's
        // `optional(peek==224|30){ group{ until-repeat }}`), carry the gate's
        // present value down so the surfaced freeRepeat records `peekGate` and
        // initialState seeds env[key]=value — entering the region on load so the
        // stepper is live and its records render (the peek picker is suppressed
        // for this case, so the seed is the ONLY way to enter the region). A
        // nested optional's own gate REPLACES the outer one (the inner region is
        // what its inner repeat's records belong to). A non-peek `when` (ref gate)
        // yields null — those surface via gateFieldId / optionalGateFor instead.
        const peekGate = matchPeekGate(c.when);
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
          peekGate
            ? { key: peekGate.peekKey, value: peekGate.value }
            : optionalPeekGate,
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
          // Encrypted plaintext is a transparent wrapper — keep the peek-gate.
          optionalPeekGate,
        );
        continue;
      }
    }
  };
  visit(body, null, false, false, true, false, null, null, false, null, null);
  linkBudgetDrivingInnerLengths(boundedOut);
  return {
    freeRepeats: out,
    boundedRepeats: boundedOut,
    instantiableRepeatIds,
  };
}

/**
 * A per-record TLV-extension length (bgpUpdateFull's per-Path-Attribute
 * `bgpAttrLength8` / `bgpAttrLength16`) seeded on an OUTER bounded repeat
 * (`bgpPathAttributes`, budget `bgpTotalPathAttributeLength`) is normally treated
 * as outer-record overage: raising it shrinks `floor((budget - prefix) /
 * livePerRecordBytes)`, so the natural edit (grow the AS_PATH / COMMUNITIES list)
 * instead drops the outer count to 0 and the WHOLE attribute record (flags, type
 * code, the length cell, every AS-segment / community) VANISHES from the diagram
 * — a panel-vs-diagram contradiction on the defining payload of a BGP UPDATE. The
 * length is recoverable only by ALSO raising `bgpTotalPathAttributeLength` far
 * beyond what a user would expect.
 *
 * That inner length is special: it is itself the BUDGET of a nested bounded
 * repeat (`bgpAsPathSegments` / `bgpCommunities`, whose `bytesExpr` is the
 * `cond ? bgpAttrLength16 : bgpAttrLength8` Extended-Length selector). So raising
 * it is meant to GROW a nested list, which legitimately needs the enclosing
 * budget to grow with it — exactly the `derivesBudgetKey` contract that
 * tlsClientHello / ocspRequest already use for per-record VALUE lengths. Tag each
 * such outer budget-length seed with `derivesBudgetKey` pointing at its own outer
 * budget so PacketViewer grows `env[outerBudget]` by the live overage (keeping the
 * record present) and excludes it from the outer count's overage (no
 * double-charge that re-collapses it).
 *
 * Gated on the inner length being a nested repeat's budget so it fires ONLY for
 * the BGP path-attribute idiom: a plain TLV-extension length whose value merely
 * flexes within its own inner scope (tlsClientHello `extLen`, isisLsp `tlvLength`,
 * bgpFlowSpec / tlsCertificate length seeds) is NOT a nested-repeat budget and
 * stays outer overage, preserving its existing budget-consuming behaviour.
 */
function linkBudgetDrivingInnerLengths(
  boundedRepeats: NonNullable<RendererPacket["boundedRepeats"]>,
): void {
  // Every length field that sizes some bounded repeat's budget (its `bytesExpr`,
  // including both branches of an Extended-Length `cond`). An OUTER seed whose key
  // is in this set drives a nested list rather than flexing in place.
  const nestedBudgetRefs = new Set<string>();
  for (const br of boundedRepeats) {
    for (const r of exprRefs(br.bytesExpr)) nestedBudgetRefs.add(r);
  }
  for (const br of boundedRepeats) {
    const seeds = br.innerScopeSeeds;
    if (!seeds) continue;
    for (const seed of seeds) {
      // Only re-tag an UNTAGGED budget-length seed (a value-length seed already
      // carries its own derivesBudgetKey). It must size a nested repeat's budget
      // AND differ from this repeat's own budget (a self-reference can't grow).
      if (seed.derivesBudgetKey) continue;
      if (seed.key === br.lengthKey) continue;
      if (nestedBudgetRefs.has(seed.key)) {
        seed.derivesBudgetKey = br.lengthKey;
      }
    }
  }
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
export const REF_SIZED_FIELD_BYTE_ALLOWANCE = 1;

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
export function containsBounded(containers: Container[]): boolean {
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
 * Within a RECORD-BEARING repeat element (one whose `switch` is discriminated by
 * a `ref`/`peek`), find the ids of `eos`/`until` repeats that live INSIDE a
 * switch CASE and whose own element does NOT wrap a nested `bounded`. These are
 * the inner operator/value-pair lists (bgpFlowSpec's `flowSpecOps` in the `_`
 * Op-List arm of `flowSpecCompValue`): an arm whose content is purely a
 * scope-terminated repeat.
 *
 * Such an inner repeat is deliberately NOT given a free count stepper — it lives
 * `insideRepeat + insideBounded`, so a naked stepper would over-consume the
 * budget-derived outer scope (ref-switch.test.ts:679). But because it is
 * scope-terminated and NOT seeded, picking that arm collapses the component to
 * its bare discriminator byte — every operator/value pair is invisible with NO
 * control to make it appear (see-but-cannot-edit). Seeding the repeat id to a
 * representative count (1) via the OUTER boundedRepeat's `innerScopeSeeds` —
 * which `initialState` writes into `env[id]` and the until-repeat reads as its
 * count — materialises one representative pair the instant the arm is picked,
 * exactly as `prefixLength`/`extLen` seeds do for their arms. The no-free-stepper
 * guard stays intact: this is a seed, not a surfaced control.
 *
 * Only a switch-CASE-nested, non-nested-bounded eos/until repeat qualifies, so
 * the surfaced TLV-extension / nested-group idioms (whose inner repeats wrap
 * their own per-record bounded) are untouched and no other preset is affected.
 */
function recordSwitchInnerScopeRepeatIds(containers: Container[]): string[] {
  const out: string[] = [];
  for (const c of containers) {
    if (isField(c)) continue;
    if (c.kind === "switch" && (c.on.kind === "ref" || c.on.kind === "peek")) {
      for (const arm of Object.values(c.cases)) {
        for (const inner of arm.fields) {
          if (isField(inner)) continue;
          if (
            inner.kind === "repeat" &&
            (inner.count === "eos" ||
              (typeof inner.count === "object" && "until" in inner.count)) &&
            !containsBounded(inner.element.fields)
          ) {
            out.push(inner.id);
          }
        }
      }
    }
    if (c.kind === "group")
      out.push(...recordSwitchInnerScopeRepeatIds(c.children));
    else if (c.kind === "optional")
      out.push(...recordSwitchInnerScopeRepeatIds([c.container]));
    else if (c.kind === "bounded")
      out.push(...recordSwitchInnerScopeRepeatIds(c.fields));
    else if (c.kind === "encrypted")
      out.push(...recordSwitchInnerScopeRepeatIds(c.plaintext.fields));
  }
  return out;
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
 * For an arm-nested budget record (bgpUpdateFull AS_PATH segment) find a DIRECT
 * child `repeat` whose `count` is a `ref` to a SIBLING `length`-category field in
 * the same record (`bgpAsSegValue = repeat count:ref(bgpAsSegLength)` inside the
 * segment). Returns an innerScopeSeed for that length keyed on `env[<sibling>]`:
 *   - `value` 0: the smallest legal record has an EMPTY list, matching the
 *     load-time render (no AS numbers), so the seed never inflates the default.
 *   - `bytesPerUnit`: the byte width of one inner element (a 2-octet ASN → 2), so
 *     PacketViewer charges `(env[len] - 0) * bytesPerUnit` into the per-record
 *     cost and the budget-derived segment count shrinks to stay in scope as the
 *     AS list grows. Surfaced (via `collectFlatTlvInnerLengthControllers`) as a
 *     length-style slider so the AS count is editable instead of inert.
 * Returns null when the record has no such sibling-ref-count repeat (COMMUNITIES'
 * `bgpCommunities` element is a flat 4-octet community, no inner repeat).
 */
function findInnerSiblingRefCountSeed(struct: {
  fields: Container[];
}): { key: string; value: number; bytesPerUnit: number } | null {
  const siblingIds = new Set<string>();
  collectRecordFieldIds(struct.fields, siblingIds);
  for (const c of struct.fields) {
    if (isField(c) || c.kind !== "repeat") continue;
    const count = c.count;
    if (typeof count !== "object" || !("kind" in count)) continue;
    if (count.kind !== "ref") continue;
    if (!siblingIds.has(count.field)) continue;
    return {
      key: count.field,
      value: 0,
      bytesPerUnit: estimateElementBytes(c.element),
    };
  }
  return null;
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
