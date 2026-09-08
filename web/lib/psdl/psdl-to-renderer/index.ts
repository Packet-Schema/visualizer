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
import type { Field as PsdlField, Packet as PsdlPacket } from "../types";
import type {
  Field as RendererField,
  Packet as RendererPacket,
} from "../renderer";

import { isLikelyChainRepeat, repeatToChainField } from "./chain";
import {
  groupToSubfieldField,
  groupToSubfieldFieldDeep,
  plainFieldToRenderer,
} from "./subfield";
import { isTlvRepeat, repeatToTlvField } from "./tlv";
import { typeBits } from "./shared";
// `resolveLayout` is used ONLY by `nestedGroupBoundedSeeds` to probe a
// crash-free per-record inner length for the rare plain-group nested-bounded
// idiom (ocspRequest). layout.ts imports `./normalize` + the leaf
// `./psdl-to-renderer/tlv-cell-id`, neither of which re-imports this module, so
// there is no import cycle.
import { flattenForMirrorQualified } from "./mirror-flatten";
import {
  collectNestedDynamicWidthLeaves,
  collectBerLengthWidthLocked,
  collectBerLengthWidthLockedByProbe,
} from "./dynamic-width";
import {
  attachOverrideMetadata,
  type PreMetadataField,
} from "./override-metadata";
import { collectPeekSwitches } from "./peek-switches";
import { collectFreeRepeats } from "./repeats-and-budgets";
import { collectRefSwitches } from "./ref-switches";
import {
  constraintToController,
  collectBoundedControllers,
  collectTlvOwnedBoundedControllers,
  collectOptionalLengthGates,
  collectSiblingLengthControllers,
  collectPlainRepeatLengthControllers,
  collectFlatTlvInnerLengthControllers,
  collectGroupNestedLengthControllers,
  collectCondWidthLengthControllers,
  collectRepeatCountRefs,
  collectOptionalGateLengthControllers,
} from "./length-controllers";

export { rendererToPsdl } from "./to-psdl";
export { applyTlvInstances } from "./apply-tlv";
export { applyChainInstances, parseChainCellId } from "./apply-chain";
export { applyByteOrderOverrides } from "./apply-byte-order";
export { mergeInstancesIntoPsdl } from "./merge-instances";

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
  // `mirror` until `attachOverrideMetadata` stamps the metadata onto it; see
  // `PreMetadataField` for why the two names are different types.
  const mirror: PreMetadataField[] = [];
  for (const c of flattenForMirrorQualified(packet.body, packet.defs, "")) {
    if (isField(c)) {
      mirror.push(plainFieldToRenderer(c));
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
      if (flat) mirror.push(flat);
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
            ? mirror.find((f) => f.id === baseId)
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
          mirror.push(chainField);
        }
      } else if (isTlvRepeat(c)) {
        mirror.push(repeatToTlvField(c));
      }
      continue;
    }
    if (c.kind === "switch") {
      // Bare Switch — flatten to a placeholder. Carry its `doc` across so the
      // DetailPanel can surface the description, mirroring the Encrypted branch.
      const fld: RendererField = { id: c.id, name: c.name ?? c.id, bits: 0 };
      if (c.doc) fld.description = c.doc;
      mirror.push(fld);
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
      mirror.push(fld);
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
      const target = mirror.find((f) => f.id === fromId);
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
    const target = mirror.find((f) => f.id === fromId);
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
    for (const f of mirror) {
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
    mirror,
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
    const target = mirror.find((f) => f.id === id);
    if (target) {
      // Don't steal a cell that already drives the diagram another way: an
      // `enumVariants` discriminator or an already-stamped length controller
      // keeps its existing widget.
      //
      // The `switchCases` half of that intent cannot be expressed here —
      // `attachOverrideMetadata` has not run yet, so the property is always
      // undefined at this point and the term was silently inert. It is
      // enforced once, after the metadata exists, further down this function.
      if (!target.controlsLength && !target.enumVariants) {
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
    mirror,
    packet.defs,
  )) {
    if (!controllerIds.has(lc.id)) {
      controllerIds.add(lc.id);
      lengthControllers.push(lc);
    }
  }
  // A `bytes(cond …)` width selects the payload's byte count between several
  // length fields by a discriminator (websocketFrame `payload` driven by
  // `extPayloadLength16` / `extPayloadLength64` / inline `payloadLength7`). The
  // branch refs live inside Switch arms and the discriminator is treated purely
  // as a refSwitch key, so NONE of the paths above reaches them and the payload
  // length — the most important editable quantity in the frame — is undrivable.
  // Surface a length controller per leaf ref (the discriminator's inline slider
  // is capped below its magic escape values so it never flips the diagram into an
  // extended-length arm; the refSwitch still owns 126/127). Deduped against the
  // controllers above.
  for (const lc of collectCondWidthLengthControllers(
    packet.body,
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
    mirror,
    packet.defs,
  )) {
    controllerIds.add(id);
  }
  // Everything above this line sees `mirror` as `PreMetadataField[]`: the
  // stage boundary is what stops an upstream guard from reading metadata that
  // has not been stamped yet. From here on the mirror is a full RendererField.
  const fields = attachOverrideMetadata(packet.body, mirror, packet.defs);
  // A chain's base field carries a chainCatalog (the chain editor's surface);
  // attachOverrideMetadata ALSO stamps switchCases on it from the same Switch.
  // OverridePanel dispatches chainCatalog first, so the switchCases are dead
  // redundant metadata — drop them so the mirror carries one control per
  // discriminator (override-design-audit).
  for (const f of fields) {
    if (f.chainCatalog && f.switchCases) delete f.switchCases;
  }
  // Same collision, one stage later: a cell stamped as a sibling length
  // controller upstream may ALSO be a Switch discriminator, and
  // attachOverrideMetadata has only just given it `switchCases`. Two
  // independent widgets on one env key is the failure this adapter keeps
  // chasing, so the discriminator — which actually selects what the diagram
  // renders — keeps the cell and the slider stands down.
  //
  // The upstream stages used to try to express this themselves with a
  // `!target.switchCases` term, but at that point the property is always
  // undefined, so the term was inert; `PreMetadataField` now makes writing it
  // there a compile error. Across all 184 built-in presets this pass changes
  // nothing (measured: zero fields carry both), so it exists for arbitrary
  // user PSDL.
  for (const f of fields) {
    if (f.controlsLength && f.switchCases) delete f.controlsLength;
  }
  const { freeRepeats, boundedRepeats, instantiableRepeatIds } =
    collectFreeRepeats(packet, fields);
  // Repeat ids that own a surfaced count stepper (freeRepeat / boundedRepeat).
  // A peek-gated optional wrapping such a repeat must NOT also surface a gate
  // picker — the stepper is the live control (ROHC Padding / Feedback).
  const surfacedRepeatCountKeys = new Set<string>([
    ...freeRepeats.map((fr) => fr.countKey),
    ...boundedRepeats.map((br) => br.countKey),
  ]);
  const peekSwitches = collectPeekSwitches(
    packet.body,
    packet.defs,
    instantiableRepeatIds,
    surfacedRepeatCountKeys,
  );
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
  // berLength leaves whose width PICKER must be suppressed because every
  // non-default width is inert: it either freezes the diagram (the structural
  // `bounded(ref length)` over-consume — collectBerLengthWidthLocked) or grows
  // only the octet's own cell while the rest of the diagram is unchanged (the
  // probe — collectBerLengthWidthLockedByProbe; snmpV2c / snmpv3 TLV-style
  // length-prefixed scalars). Union both: the structural pass is a cheap exact
  // match, the probe a faithful resolveLayout sweep that catches the cases the
  // `bounded` shape misses.
  const berLengthWidthLocked = [
    ...new Set([
      ...collectBerLengthWidthLocked(packet),
      ...collectBerLengthWidthLockedByProbe(packet),
    ]),
  ];
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
    ...(berLengthWidthLocked.length > 0 ? { berLengthWidthLocked } : {}),
  };
}
