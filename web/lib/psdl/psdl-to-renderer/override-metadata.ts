// Extracted from `index.ts` (PSDL → renderer adapter) — no logic changes.

import { isField } from "../utils";
import { exprRefs } from "../expr";
import type {
  Container,
  Field as PsdlField,
  Group,
  NamedStruct,
  Packet as PsdlPacket,
  Struct,
} from "../types";
import type { Field as RendererField } from "../renderer";
import { groupToSubfieldFieldDeep, plainFieldToRenderer } from "./subfield";
import { firstCaseKeyValue } from "./shared";
import { flattenForMirror, flattenForMirrorGuarded } from "./mirror-flatten";
import {
  switchArmsAllIdentical,
  listedArmsAllIdentical,
  defaultArmSyntheticCase,
  switchArmsDifferByNameOnly,
} from "./switch-arms";

/**
 * The renderer mirror BEFORE `attachOverrideMetadata` has run.
 *
 * `switchCases` and `optionalGateFor` are stamped by that pass and by nothing
 * else, so upstream stages cannot meaningfully read them — a guard like
 * `!target.switchCases` in a collector that runs earlier is always true and
 * silently protects nothing. Omitting the two keys here turns that class of
 * mistake into a compile error instead of a comment nobody can check.
 *
 * Every stage that runs before `attachOverrideMetadata` should take
 * `PreMetadataField[]`; everything after it takes `RendererField[]`.
 */
export type PreMetadataField = Omit<
  RendererField,
  "switchCases" | "optionalGateFor"
>;

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
export function attachOverrideMetadata(
  body: PsdlPacket["body"],
  fields: PreMetadataField[],
  defs: Record<string, NamedStruct> | undefined,
): RendererField[] {
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

  // Locate a plain leaf Field that is a DIRECT child of a Switch case struct
  // (`switch.cases[k].fields`), i.e. NOT wrapped in any Group and NOT inside a
  // Repeat element. Switch-case fields never reach `mirror.fields` (only the
  // Switch's own discriminator field surfaces), so an Optional gated by such a
  // plain ref has no target for `groupOwning` (no group owns it) and no
  // top-level field — a see-but-cannot-edit gate. amt (Membership Query) is the
  // sole preset where this occurs: `amtMqG` (a 1-bit int declared directly in
  // the `amtType` case-4 struct) gates `optional{group: amtMqGateway}`. We only
  // relax the surface for this exact shape — a bare leaf directly under a case,
  // outside any repeat — so unrelated switch-case fields are not promoted.
  const switchCaseLeafGate = (id: string): PsdlField | null => {
    let found: PsdlField | null = null;
    // Cycle guard: a user-authored def may reference itself (directly or via a
    // chain), e.g. `optional{ container: ref(self) }`. Without tracking the refs
    // already on the descent path, `scanStruct` would recurse forever and throw
    // a RangeError, crashing the whole override mirror for a packet the diagram
    // renders fine. Mirrors the `*RefSeen`/`seenDefs` pattern used elsewhere.
    const scanRefSeen = new Set<string>();
    const scanStruct = (
      struct: Struct,
      insideCase: boolean,
      insideRepeat: boolean,
    ): void => {
      for (const child of struct.fields) {
        if (found) return;
        if (isField(child)) {
          if (insideCase && !insideRepeat && child.id === id) found = child;
          continue;
        }
        if (child.kind === "switch") {
          for (const sub of Object.values(child.cases))
            scanStruct(sub, true, insideRepeat);
        } else if (child.kind === "group") {
          // A bare leaf directly under a case is what we want; a leaf inside a
          // Group is handled by `groupOwning` instead, so don't descend with
          // `insideCase` still set — clear it so a group-nested leaf is ignored.
          scanStruct({ fields: child.children } as Struct, false, insideRepeat);
        } else if (child.kind === "repeat") {
          scanStruct(child.element, insideCase, true);
        } else if (child.kind === "optional") {
          scanStruct(
            { fields: [child.container] } as Struct,
            insideCase,
            insideRepeat,
          );
        } else if (child.kind === "encrypted") {
          scanStruct(child.plaintext, insideCase, insideRepeat);
        } else if (child.kind === "bounded") {
          scanStruct({ fields: child.fields } as Struct, insideCase, true);
        } else if (child.kind === "ref") {
          const def = defs?.[child.ref];
          if (def && !scanRefSeen.has(child.ref)) {
            scanRefSeen.add(child.ref);
            scanStruct(def, insideCase, insideRepeat);
            scanRefSeen.delete(child.ref);
          }
        }
      }
    };
    scanStruct({ fields: body } as Struct, false, false);
    return found;
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
    if (owner) {
      // If the owning Group already surfaced (flat collapse), the leaf is a
      // subfield on it and findTarget would have found it; reaching here means
      // it did not surface. Build a deep collapse so every bit leaf is
      // reachable.
      if (fields.some((x) => x.id === owner.id)) return null;
      const deep = groupToSubfieldFieldDeep(owner);
      if (!deep) return null;
      fields.push(deep);
      const sub = deep.subfields?.find((s) => s.id === id);
      return sub ? { kind: "subfield", sub } : null;
    }
    // No group owns the gate — it may be a plain leaf declared directly inside a
    // Switch case (amt's `amtMqG`). Such a field never reaches `mirror.fields`,
    // so lazily promote it to a top-level mirror field carrying the gate stamp.
    // The diagram cell for the leaf already uses this id, so OverridePanel's
    // selection resolver lands on the promoted field and renders an
    // OptionalToggle keyed on `env[id]`; the merge-based lift looks fields up by
    // id and finds no byteOrder/tlv/chain on it, so the promotion is a no-op for
    // export round-trips.
    const leaf = switchCaseLeafGate(id);
    if (!leaf) return null;
    const promoted = plainFieldToRenderer(leaf);
    fields.push(promoted);
    return { kind: "field", field: promoted };
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
  const collectVirtualsRefSeen = new Set<string>();
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
        if (collectVirtualsRefSeen.has(c.ref)) continue;
        const def = defs?.[c.ref];
        if (def) {
          collectVirtualsRefSeen.add(c.ref);
          collectVirtuals(def.fields);
          collectVirtualsRefSeen.delete(c.ref);
        }
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

  const refPath = new Set<string>();
  const visit = (containers: PsdlPacket["body"]): void => {
    const { items, release } = flattenForMirrorGuarded(
      containers,
      defs,
      refPath,
    );
    for (const c of items) {
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
        // A name-only relabel picker (arms render identically but carry DISTINCT
        // NAMES — `switchArmsDifferByNameOnly`) is only worth surfacing when the
        // discriminator does NOT ALREADY own a label control on the same env key.
        // When the discriminator is itself an `enum`, its EnumDropdown already
        // selects every arm value and relabels the cell per arm, so a second raw
        // `switchCases` picker on the same key would merely duplicate it (the
        // eap / tlsHandshake precedent: both discriminators are `enum(8)`, both
        // surface a complete EnumDropdown, both keep `switchCases` suppressed).
        // Only a discriminator with NO enum (a plain `int` — the arbitrary-PSDL
        // P1c shape, two `bytes(ref len)` arms differing only by name) is left
        // with no labeled case picker, which is the see-but-cannot-edit gap.
        const onRef = c.on.kind === "ref" ? c.on.field : primaryRef(c.on);
        const discTarget = onRef ? findTarget(onRef) : null;
        const discHasEnum =
          discTarget?.kind === "field"
            ? Boolean(discTarget.field.enumVariants)
            : discTarget?.kind === "subfield"
              ? Boolean(discTarget.sub.enumVariants)
              : false;
        const nameOnlyRelabel =
          !discHasEnum && switchArmsDifferByNameOnly(c.cases);
        // Suppress a multi-option case picker whose every selectable arm is
        // structurally identical: choosing any value yields a byte-identical
        // layout, so the dropdown can never change the diagram (an inert
        // see-but-cannot-edit control). collectRefSwitches has its own
        // zero-width gate for repeat-nested discriminators; this covers the
        // top-level / plain-field discriminators it never reaches — e.g.
        // tlsHandshake's 10-arm `handshakeType` (each arm a single
        // `bytes(ref tlsHandshakeBodyLen)`).
        //
        // EXCEPTION (snmpV2c/QUIC `switchArmsDifferByNameOnly` precedent,
        // mirrored from the case-nested path above): when the selectable arms
        // render to the SAME geometry but carry DISTINCT NAMES — and the
        // discriminator has no enum already labeling the cell — selecting
        // between them still relabels the diagram cell, a real diagram-visible
        // semantic edit, so we keep the picker surfaced. Without this, two arms
        // that differ ONLY by name (both `bytes(ref len)`) leave a plain-int
        // discriminator with no labeled case picker even though the diagram
        // visibly relabels the cell per arm (see-but-cannot-edit for the labels).
        if (switchArmsAllIdentical(c.cases) && !nameOnlyRelabel) continue;
        // Suppress a field-level `switchCases` picker whose LISTED arms are all
        // mutually identical: every offered listed value yields a byte-identical
        // layout. The diverging `_` arm IS reachable below (we append a
        // defaultArmSyntheticCase, mirroring the peek path), but eap's `eapCode`
        // — the sole preset this catches — is ALSO an `enum(8)` discriminator
        // covering 1–4, and its EnumDropdown (on the same env key) already drives
        // every meaningful state including the empty `_` body at 3 / 4. Surfacing
        // a second, raw-labelled switch picker on the same key would only add an
        // inert (listed arms identical), enum-colliding control; suppress it.
        //
        // EXCEPTION (same `nameOnlyRelabel` escape hatch as above): a plain-int
        // discriminator whose listed arms render identically but carry DISTINCT
        // NAMES still relabels the diagram cell, so keep the picker surfaced.
        if (listedArmsAllIdentical(c.cases) && !nameOnlyRelabel) continue;
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
    release();
  };

  visit(body);
  // Same array, now carrying the metadata this pass stamps (and any fields it
  // pushed). Handing it back is what lets the caller switch from
  // `PreMetadataField[]` to `RendererField[]` at exactly this point.
  return fields as RendererField[];
}
