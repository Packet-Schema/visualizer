// Extracted from `index.ts` (PSDL → renderer adapter) — no logic changes.

import { isField } from "../utils";
import type { NamedStruct, Packet as PsdlPacket, Repeat } from "../types";
import type {
  Field as RendererField,
  Packet as RendererPacket,
} from "../renderer";
import { isLikelyChainRepeat } from "./chain";
import { isTlvRepeat } from "./tlv";
import { firstCaseKeyValue, prettifyId } from "./shared";
import {
  collectLengthDrivingRefs,
  collectFieldBits,
  collectFieldDefaults,
  collectFieldCategoriesByBody,
  isExtendedLengthFlagSwitch,
  collectEnumVariants,
  collectFieldNames,
} from "./psdl-queries";
import { flattenForMirrorGuarded } from "./mirror-flatten";
import {
  switchArmsAllZeroWidth,
  switchArmsZeroWidthSiblingLengths,
  switchArmsMixedCollapsedSiblingLengths,
  subByteDiscriminatorSelectsVariant,
  lengthExtensionArmsHaveDistinctWidths,
  structuralShape,
  switchArmsAllIdentical,
  isOpaqueUnknownRecordArm,
  collectArmFieldIds,
  switchArmsDifferByNameOnly,
  collectSwitchCaseFieldIds,
  collectGroupNestedFieldIds,
  collectEncryptedNestedFieldIds,
  collectTopLevelDynamicWidthFieldIds,
  lookupDiscriminatorOf,
  representativeDefaultArmValue,
} from "./switch-arms";
import { REF_SIZED_FIELD_BYTE_ALLOWANCE } from "./repeats-and-budgets";

/**
 * Find Switches inside a plain (non-TLV/non-chain) repeat whose `on` is a
 * `ref(X)`. Because that repeat is dropped from the renderer mirror, the
 * discriminator X has no override widget and the per-record variant is stuck at
 * its default — so surface a packet-level variant picker keyed on X's env id
 * (override-audit A2). Skipped when X already carries a field-bearing widget.
 */
export function collectRefSwitches(
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
  const fieldCategories = collectFieldCategoriesByBody(body);
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
  // Top-level fields whose width is DYNAMIC (a varint / delimited bytes). When
  // such a field is ALSO a switch discriminator the mirror strips its width and
  // forces `bits:0`, so it never hosts a cell-anchored `switchCases` widget —
  // http3Frame's `http3FrameType` (the frame Type / `http3FramePayload`
  // discriminator). Like the case/group/encrypted-nested ids, a TOP-LEVEL switch
  // discriminated on one needs a packet-level refSwitch picker, else the whole
  // packet is see-but-cannot-edit.
  const topLevelDynamicWidthFieldIds = collectTopLevelDynamicWidthFieldIds(
    body,
    defs,
  );
  // Declared field defaults — used to order a field-nested (group/case) picker's
  // cases so `initialState`'s `cases[0]` seed agrees with the author's default.
  const fieldDefaults = collectFieldDefaults(body);
  const seen = new Set<string>();
  const refPath = new Set<string>();
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
    // FULL ordered chain of EVERY top-level / intermediate ref-discriminated
    // case this scope is nested inside, outermost → innermost. Unlike
    // `enclosingCaseGate` (frozen at the outermost link, for the load-seed), this
    // grows by one entry at each deeper case so a refSwitch surfaced several arms
    // down records its real ancestry: rejectStat → [{rpcMsgType:1},{replyStat:1}]
    // while acceptStat → [{rpcMsgType:1},{replyStat:0}]. OverridePanel walks it to
    // hint the FIRST link not yet satisfied — `initialState` already seeds the
    // outermost rpcMsgType=1, so naming it would be a dead no-op; replyStat=1 is
    // the actual unmet step for rejectStat (#11/#12 misleading-hint).
    caseGateChain: { key: string; value: number }[],
  ): void => {
    const { items, release } = flattenForMirrorGuarded(
      containers,
      defs,
      refPath,
    );
    for (const c of items) {
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
            // A lookup-based AFI picker declared inside a top-level message-type
            // switch case (pgm's pgmSpmNlaAfi/pgmNak*/pgmNcf* under pgmType's
            // SPM/NAK/NCF arms) lives in an arm the diagram only renders at one
            // discriminator value. Carry that OUTERMOST case gate exactly as the
            // Switch path below does, so `initialState` seeds the discriminator
            // (pgmType=SPM) and the arm — hence the AFI field's real cell —
            // renders on load instead of the default ODATA arm, which has no NLA
            // field. Without the gate all such pickers load disabled and their
            // disable hint names a field the user cannot directly set (#11/#12).
            // The per-picker `fieldRendered` gate still keeps the other arms'
            // pickers (NAK/NCF) correctly disabled until their case is chosen.
            out.push({
              id: `${disc.refKey}_byAfi`,
              name: fieldNames.get(disc.refKey) ?? disc.refKey,
              cases: cases.map(({ value, label }) => ({ value, label })),
              refKey: disc.refKey,
              ...(enclosingCaseGate ? { gate: enclosingCaseGate } : {}),
              ...(caseGateChain.length > 0 ? { gateChain: caseGateChain } : {}),
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
          caseGateChain,
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
        //   (5) it is a TOP-LEVEL switch discriminated on a TOP-LEVEL field
        //       whose width is DYNAMIC (a varint / delimited bytes) and which is
        //       ITSELF the discriminator (http3Frame `http3FramePayload` on the
        //       `http3FrameType` varint). Because that field carries
        //       `switchCases`, the mirror strips its varint width and forces
        //       `bits:0` — it never hosts a fixed-width, cell-anchored
        //       `switchCases` widget the way a normal int discriminator does, so
        //       the user has no clickable top-level cell to change the frame
        //       Type. Treated identically to the case/group/encrypted-nested
        //       paths: surface a packet-level refSwitch picker.
        const fieldNestedNoWidget =
          !enclosingPlainRepeat &&
          !insideRepeat &&
          c.on.kind === "ref" &&
          (switchCaseFieldIds.has(c.on.field) ||
            groupNestedFieldIds.has(c.on.field) ||
            encryptedNestedFieldIds.has(c.on.field) ||
            topLevelDynamicWidthFieldIds.has(c.on.field));
        const caseNested = fieldNestedNoWidget;
        if ((enclosingPlainRepeat || caseNested) && c.on.kind === "ref") {
          const refKey = c.on.field;
          // A TOP-LEVEL dynamic-width discriminator (http3Frame's varint
          // `http3FrameType`) carries `switchCases` on its mirror field, but the
          // mirror strips its width to `bits:0`, so that widget is NOT
          // cell-anchored the way a fixed-width int discriminator's is — it does
          // not "cover" the discriminator. Don't let bare `switchCases` veto the
          // packet-level picker for these; `controlsLength`/`enumVariants` still
          // count (they drive a real top-level cell). The other branches are
          // unaffected — their discriminators are nested and never carry
          // `switchCases` on a mirror field anyway.
          const dynWidthDisc = topLevelDynamicWidthFieldIds.has(refKey);
          const covered = fields.find(
            (f) =>
              f.id === refKey &&
              (f.controlsLength ||
                (f.switchCases && !dynWidthDisc) ||
                f.enumVariants),
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
          // EXCEPTION #2 (websocketFrame `byPayloadLength7`): a TOP-LEVEL
          // (non-repeat), group/case-nested length-extension switch whose arms
          // insert Extended-Length cells of STRUCTURALLY DISTINCT WIDTH (126 →
          // 16-bit `extPayloadLength16`, 127 → 64-bit `extPayloadLength64`,
          // default → empty) is NOT a length encoder in the CoAP/BGP sense.
          // Two signals would otherwise flag it as an encoder:
          //   * `lengthDriving` — the discriminator IS read by a later width
          //     expression (the `payload` byte count is `cond(payloadLength7 ==
          //     126/127, ext…, payloadLength7)`); but here that just sizes the
          //     trailing payload, it does NOT re-encode a length inside a bounded
          //     scope the switch could over-consume, and
          //   * the sub-byte heuristic — `payloadLength7` is 7 bits and every arm
          //     is a `category:"length"` field.
          // Yet toggling this discriminator visibly GAINS or LOSES a fixed-width
          // Extended-Length cell (126 ≠ 127 ≠ default, in presence AND width) —
          // the diagram is NOT byte-identical across values. The discriminator is
          // itself sub-byte AND group-nested, so it has no top-level cell to host
          // a `switchCases` widget; without the packet-level picker the extended
          // cell is see-but-cannot-edit (an imported 126-frame's
          // `extPayloadLength16` can never be toggled off). Relax BOTH encoder
          // signals for such a switch — but ONLY when it is not inside ANY repeat,
          // so the repeat-nested CoAP `byOptDelta`/`byOptLength` and BGP
          // `bgpAttrLengthByExt` encoders keep their existing suppression (their
          // arms re-encode a length inside a bounded record, not a top-level
          // fixed-width region, and are reachable via their TLV/record editors).
          const topLevelLengthExtensionVariant =
            caseNested &&
            !enclosingPlainRepeat &&
            !insideRepeat &&
            lengthExtensionArmsHaveDistinctWidths(c.cases, c.cases["_"]);
          // EXCEPTION #3 (coap `byOptDelta`): a REPEAT-NESTED extended-nibble
          // switch whose discriminator is a 4-bit nibble (`optDelta`) selecting a
          // DISTINCT-width extension cell per arm (13 → 8-bit `optDeltaExt1`,
          // 14 → 16-bit `optDeltaExt2`) — the same extended-nibble class as the
          // now-surfaced top-level `coapSigLen`/`payloadLength7`, but living inside
          // the `options` plain repeat. With `options` instantiated (defaultCount 1)
          // the option record and the `optDelta` cell render, and driving the
          // nibble to 13/14 visibly GAINS the extension byte(s) on the diagram — yet
          // the blanket sub-byte length-encoder heuristic suppressed it, leaving the
          // option-delta cell and its extension bytes see-but-cannot-edit. Relax ONLY
          // the sub-byte heuristic for such a switch — NEVER `lengthDriving`, which
          // still pins a discriminator that re-encodes a bounded value-scope length
          // (BGP `attrExtLen` reads into a bounded Attribute Value scope) as an
          // encoder. The discriminator must ALSO not already be a surfaced length
          // controller (`controlledIds`): coap's sibling `optLength` sizes `optValue`
          // and is editable via its length-controller widget, so it stays suppressed
          // here (no redundant, length-desyncing picker) while `optDelta` — which
          // sizes nothing — is surfaced. Gated on an INSTANTIABLE enclosing plain
          // repeat, so a never-rendered record's nibble is not offered.
          const repeatNestedDeltaExtensionVariant =
            !!enclosingPlainRepeat &&
            instantiableRepeatIds.has(enclosingPlainRepeat.id) &&
            // Exactly the switch the sub-byte length-encoder heuristic suppresses:
            // a sub-byte (< 8-bit) nibble whose arms are length-extension cells
            // (`subByteDiscriminatorSelectsVariant` is false). An ≥ 8-bit
            // record-type code (the ref-def `rtype` variant selector) is NOT this
            // class — it is already surfaced by the normal path and must not gain a
            // spurious literal option.
            discBits !== undefined &&
            discBits < 8 &&
            !subByteDiscriminatorSelectsVariant(c.cases) &&
            // …and the nibble must size NOTHING (so toggling it cannot desync a
            // bounded value scope): not a width-driving ref (BGP `attrExtLen`) and
            // not an already-surfaced length controller (CoAP `optLength`).
            !lengthDriving.has(refKey) &&
            !controlledIds.has(refKey) &&
            // …with arms of STRUCTURALLY DISTINCT fixed width (13 → 8-bit ext1,
            // 14 → 16-bit ext2), so each value genuinely changes the geometry.
            lengthExtensionArmsHaveDistinctWidths(c.cases, c.cases["_"]);
          // EXCEPTION #4 (bgpUpdateFull `bgpAttrLengthByExt`): a REPEAT-NESTED
          // Extended-Length FLAG switch — `attrExtLen` is a 1-bit `flags` bit, case
          // `1` → 16-bit `bgpAttrLength16`, `_` → 8-bit `bgpAttrLength8`. It is the
          // SAME Extended-Length discriminator class as the now-surfaced top-level
          // coap/websocket nibbles, but a flags BIT inside the per-record
          // `bgpPathAttributes` repeat. With that repeat instantiable, toggling the
          // flag visibly swaps the rendered Attribute Length cell (8-bit ⇄ 16-bit)
          // and the diagram resolves cleanly at either value — yet the blanket
          // sub-byte length-encoder heuristic (AND `lengthDriving`: the flag reads
          // into the bounded Attribute Value scope) suppressed it, leaving the
          // visible flag bit and length cell see-but-cannot-edit. Surface it. This
          // is narrower than the sub-byte heuristic it relaxes — a 1-bit `flags`
          // discriminator with ALL-length arms at ≥ 2 distinct widths — so it never
          // catches a record-type code or a value-selecting nibble (CoAP `optDelta`
          // is `category` "length", `optLength` is a surfaced length controller).
          const repeatNestedExtLenFlag =
            !!enclosingPlainRepeat &&
            instantiableRepeatIds.has(enclosingPlainRepeat.id) &&
            isExtendedLengthFlagSwitch(
              c.cases,
              discBits,
              fieldCategories.get(refKey),
            );
          const isEncoder =
            !topLevelLengthExtensionVariant &&
            !repeatNestedDeltaExtensionVariant &&
            !repeatNestedExtLenFlag &&
            (lengthDriving.has(refKey) ||
              (discBits !== undefined &&
                discBits < 8 &&
                !subByteDiscriminatorSelectsVariant(c.cases)));
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
            // A repeat-nested delta-extension switch (coap `byOptDelta`: cases
            // 13/14 only, no `_` arm) lists ONLY the extension-bearing values, so
            // the picker could reach the ext1/ext2 states but never RETURN to the
            // literal "no extension" state the diagram loads at (`env[optDelta]=0`).
            // Prepend a synthetic value-0 "literal (no extension)" option so the
            // control is reversible and its first option AGREES with the load
            // diagram, instead of contradicting it by defaulting to case 13.
            if (
              repeatNestedDeltaExtensionVariant &&
              !c.cases["_"] &&
              !cases.some((cc) => cc.value === 0)
            ) {
              cases.unshift({ value: 0, label: "Literal (no extension)" });
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
            // For a repeat-nested Extended-Length FLAG (BGP `attrExtLen`), the
            // diagram loads at the cleared flag (env[attrExtLen]=0 → the 8-bit
            // length, the `_` default arm). `initialState` seeds env[refKey] to
            // cases[0].value, so order the value-0 case FIRST — otherwise the load
            // diagram would silently default to the set flag (case 1, the 16-bit
            // length) and contradict the cleared-flag default the packet renders.
            if (repeatNestedExtLenFlag) {
              const i = cases.findIndex((cc) => cc.value === 0);
              if (i > 0) {
                const [hit] = cases.splice(i, 1);
                cases.unshift(hit);
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
              // `gateChain` carries the FULL ancestry (outermost → innermost) so
              // OverridePanel can hint the FIRST unmet link instead of the
              // already-seeded outermost gate — rejectStat's real unmet step is
              // replyStat=1, not the satisfied rpcMsgType=1 (#11/#12).
              out.push({
                id: c.id,
                name: c.name ?? refKey,
                cases,
                refKey,
                ...(lengthSeeds ? { lengthSeeds } : {}),
                ...(enclosingCaseGate ? { gate: enclosingCaseGate } : {}),
                ...(caseGateChain.length > 0
                  ? { gateChain: caseGateChain }
                  : {}),
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
          // A top-level / intermediate (not repeat-nested) ref-discriminated case
          // with a single integer key. `enclosingCaseGate` freezes the OUTERMOST
          // such link (for the load-seed); `thisCaseLink` is THIS case's own
          // gate, captured at every depth so the chain records the full ancestry.
          const thisCaseLink =
            !enclosingPlainRepeat &&
            !insideRepeat &&
            c.on.kind === "ref" &&
            caseValue !== null
              ? { key: c.on.field, value: caseValue }
              : null;
          const nextCaseGate = enclosingCaseGate ?? thisCaseLink;
          const nextCaseGateChain = thisCaseLink
            ? [...caseGateChain, thisCaseLink]
            : caseGateChain;
          visit(
            struct.fields,
            enclosingPlainRepeat,
            insideRepeat,
            nextCaseGate,
            nextCaseGateChain,
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
          caseGateChain,
        );
        continue;
      }
      if (c.kind === "optional") {
        visit(
          [c.container],
          enclosingPlainRepeat,
          insideRepeat,
          enclosingCaseGate,
          caseGateChain,
        );
        continue;
      }
      if (c.kind === "encrypted") {
        visit(
          c.plaintext.fields,
          enclosingPlainRepeat,
          insideRepeat,
          enclosingCaseGate,
          caseGateChain,
        );
        continue;
      }
    }
    release();
  };
  visit(body, null, false, null, []);
  return out;
}
