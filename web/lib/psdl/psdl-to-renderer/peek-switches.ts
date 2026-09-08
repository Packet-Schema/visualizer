// Extracted from `index.ts` (PSDL → renderer adapter) — no logic changes.

import { peekEnvKey } from "../expr";
import type { Container, NamedStruct, Packet as PsdlPacket } from "../types";
import type { Packet as RendererPacket } from "../renderer";
import { isLikelyChainRepeat } from "./chain";
import { isTlvRepeat } from "./tlv";
import { firstCaseKeyValue, prettifyId } from "./shared";
import {
  findArmByCaseValue,
  firstInnerFieldId,
  matchPeekGate,
  surfacedNestedTlvRepeat,
} from "./psdl-queries";
import { flattenForMirrorGuarded } from "./mirror-flatten";
import {
  defaultArmSyntheticCase,
  switchArmsRenderIdentical,
} from "./switch-arms";

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
 * True when `container` IS, or transitively wraps, a `repeat` whose id is in
 * `surfacedCountKeys` (a repeat already given its own count stepper as a
 * freeRepeat / boundedRepeat). Used by the optional peek-gate path to decide
 * whether the gate picker would merely duplicate that stepper.
 *
 * Only descends the "skeleton" wrappers that keep the repeat on the SAME
 * always-present spine as the optional itself — group / bounded / a lone
 * optional / a single-armed switch. A repeat buried inside a multi-arm switch
 * case or a sibling list isn't the thing the gate reveals, so we don't treat it
 * as the live control. (For ROHC the optional wraps a `group` holding the
 * `rohcPadding` / `rohcFeedback` until-repeats directly.)
 */
function optionalWrapsSurfacedRepeat(
  container: Container,
  surfacedCountKeys: Set<string>,
): boolean {
  const c = container;
  if (c.kind === "repeat") {
    if (typeof c.id === "string" && surfacedCountKeys.has(c.id)) return true;
    // A repeat's element is its own scope; a nested surfaced repeat there is
    // controlled independently and is not what THIS gate reveals.
    return false;
  }
  if (c.kind === "group")
    return c.children.some((child) =>
      optionalWrapsSurfacedRepeat(child, surfacedCountKeys),
    );
  if (c.kind === "bounded")
    return c.fields.some((child) =>
      optionalWrapsSurfacedRepeat(child, surfacedCountKeys),
    );
  if (c.kind === "optional")
    return optionalWrapsSurfacedRepeat(c.container, surfacedCountKeys);
  return false;
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
 * the gating peek key the region is otherwise unreachable: a see-but-cannot-edit
 * dead end. We publish one synthetic picker per distinct peek key, with a case
 * per gate value plus an "(absent)" case so the region can be toggled back off.
 *
 * EXCEPTION: when the optional wraps a count-driven `repeat` that ALREADY has
 * its own surfaced count stepper (ROHC's `rohcPadding` / `rohcFeedback`
 * until-repeats), that stepper is the live, granular control — `initialState`
 * seeds the gate peek to its "present" value, so raising the stepper reveals the
 * records and lowering it to 0 hides them. A second peek picker that only
 * toggles the same region off/on is a redundant, misleading duplicate (setting
 * the peek alone, with count 0, does nothing). We suppress the gate picker in
 * that case and only emit one when the optional wraps a directly-renderable
 * field (ROHC's Add-CID octet) with no count stepper of its own.
 */
export function collectPeekSwitches(
  body: PsdlPacket["body"],
  defs: Record<string, NamedStruct> | undefined,
  // Repeat ids whose records actually render (a surfaced count control OR a
  // literal count). Used to relax the in-repeat nested-TLV peek picker only when
  // the enclosing repeat is instantiable, mirroring collectFreeRepeats.
  instantiableRepeatIds: Set<string>,
  // Repeat ids that already own a surfaced count stepper (freeRepeat /
  // boundedRepeat). A peek-gated optional wrapping one of these gets NO gate
  // picker — the stepper is the live control (see EXCEPTION above).
  surfacedRepeatCountKeys: Set<string>,
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
  const refPath = new Set<string>();
  const visit = (
    containers: PsdlPacket["body"],
    insideSwitch: boolean,
    insideRepeat: boolean,
    // Mirrors collectFreeRepeats: true when descending an `optional` wrapper, so
    // a TLV-shaped repeat directly inside it surfaces its peek picker (the eos
    // count stepper comes from collectFreeRepeats).
    insideOptional: boolean,
    // True when the NEAREST enclosing repeat is instantiable (its records render
    // — a surfaced count control or a literal count). Lets a switch/optional-
    // nested TLV repeat that is itself inside an instantiable repeat surface its
    // peek picker, matching collectFreeRepeats' enclosingInstantiable relaxation.
    enclosingInstantiable: boolean,
  ): void => {
    const { items, release } = flattenForMirrorGuarded(
      containers,
      defs,
      refPath,
    );
    for (const c of items) {
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
        // Gate on the discriminator kind BEFORE doing any case-key work: all of
        // it is peek-only, and `defaultArmSyntheticCase` scans for a default-arm
        // sentinel, so running it for ref/plain switches was pure waste. NB the
        // gate must not `continue` — the recursion into `c.cases` below still
        // has to run, or a peek switch nested inside a ref switch's arm is never
        // visited.
        // (The `if` repeats the kind test rather than reusing `isPeek` so TS
        // still narrows `c.on` to the peek variant inside the block.)
        const isPeek = c.on.kind === "peek";
        const defaultCase = isPeek ? defaultArmSyntheticCase(c.cases) : null;
        const armsLook = isPeek && !switchArmsRenderIdentical(c.cases);
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
          visit(
            struct.fields,
            true,
            insideRepeat,
            false,
            enclosingInstantiable,
          );
        continue;
      }
      if (c.kind === "group") {
        visit(
          c.children,
          insideSwitch,
          insideRepeat,
          insideOptional,
          enclosingInstantiable,
        );
        continue;
      }
      if (c.kind === "repeat") {
        // A peek Switch that IS a top-level TLV/chain repeat's own dispatch is
        // already handled by the (more capable) TLV/chain editor; surfacing a
        // duplicate peek picker is redundant AND goes inert once
        // applyTlvInstances materialises the records (the peek key is no longer
        // read). So don't collect peek switches from inside such a repeat.
        //
        // EXCEPTION: a switch-nested TLV repeat (icmpv6Ndp rsOptions/raOptions/…)
        // is NOT lifted to a tlv field, so its peek type-picker is the ONLY
        // surface for choosing the option type — descend into it (paired with the
        // eos count stepper from collectFreeRepeats). The optional-wrapped TLV
        // repeat (`optional(flag){ repeat eos { switch on peek } }`) is the same
        // gap reached via `insideOptional`. When such a TLV repeat is itself
        // INSIDE another repeat, descend only if that enclosing repeat is
        // instantiable (its records render), mirroring collectFreeRepeats'
        // enclosingInstantiable relaxation so the peek picker pairs with the
        // surfaced count stepper one level deeper. A DIRECT repeat-of-repeat TLV
        // repeat (no intervening switch case/optional) reaches here with
        // insideSwitch=insideOptional=false and insideRepeat=true; descend it too
        // (gated on enclosingInstantiable) so its peek picker pairs with the
        // count stepper collectFreeRepeats now surfaces for that shape.
        const surfacedNestedTlv = surfacedNestedTlvRepeat({
          isTlvRepeat: isTlvRepeat(c),
          insideSwitch,
          insideOptional,
          insideRepeat,
          enclosingInstantiable,
        });
        if ((!isTlvRepeat(c) && !isLikelyChainRepeat(c)) || surfacedNestedTlv)
          visit(
            c.element.fields,
            false,
            true,
            false,
            // The repeat element's records render iff THIS repeat is instantiable
            // (a surfaced count control populated it, or a literal count).
            instantiableRepeatIds.has(c.id),
          );
        continue;
      }
      if (c.kind === "optional") {
        const gate = matchPeekGate(c.when);
        // Suppress the gate picker when the optional wraps a count-driven repeat
        // that already has its own surfaced count stepper — that stepper is the
        // live control, so a peek picker only duplicates the region's on/off
        // (ROHC Padding / Feedback). Still descend below for any genuinely
        // distinct nested picker.
        if (
          gate &&
          !optionalWrapsSurfacedRepeat(c.container, surfacedRepeatCountKeys)
        ) {
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
        visit(
          [c.container],
          insideSwitch,
          insideRepeat,
          true,
          enclosingInstantiable,
        );
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
          visit(
            c.plaintext.fields,
            insideSwitch,
            insideRepeat,
            insideOptional,
            enclosingInstantiable,
          );
        continue;
      }
    }
    release();
  };
  // The packet body is the top-level scope: no enclosing repeat, so its records
  // (the top-level fields) always render — enclosingInstantiable starts true.
  visit(body, false, false, false, true);
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
    // Preserve the `fieldRendered` gate when every aliasing picker shares the
    // SAME gateFieldId — which they do for NDP's five option pickers, whose
    // seeded arm's first inner field is `ndpOptType` in each case. Without this
    // the merged picker drops its gate and reads ENABLED even when the live
    // variant draws no option (e.g. icmpv6Ndp at type=0 routes to the `_` arm),
    // making the dropdown inert and contradicting an empty diagram. A divergent
    // gate (or any member missing one) can't safely gate the union, so we only
    // carry a gate every member agrees on.
    const commonGate = group.every((g) => g.gateFieldId === first.gateFieldId)
      ? first.gateFieldId
      : undefined;
    out.push({
      id: first.id,
      name: sharedName.length >= 3 ? sharedName : first.name,
      cases,
      peekKey: first.peekKey,
      ...(commonGate !== undefined ? { gateFieldId: commonGate } : {}),
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
