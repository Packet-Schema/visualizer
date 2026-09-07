// Extracted from `index.ts` (PSDL → renderer adapter) — no logic changes.

import { isField } from "../utils";
import { peekEnvKey } from "../expr";
import { isBytesDelimited } from "../normalize";
import {
  collectSwitchOnRefIds,
  isRemainingSizedBytes,
  seedDynamicWidthDefaults,
} from "../dynamic-width-defaults";
import type { Container, Expr, Packet as PsdlPacket } from "../types";
import type { Packet as RendererPacket } from "../renderer";
import { resolveLayout } from "../layout";
import { initialEnv, berLenEnvKey } from "../normalize";
import { collectPsdlRefs } from "../collect-refs";
import { matchPeekGate, singleRefController } from "./psdl-queries";

/** One berLength prefix octet discovered by the layout probe, together with the
 *  enclosing peek-gate (switch-on-peek / peek-gated optional) seeds that must be
 *  set in `env` for the octet to actually render. */
type BerLengthLeafSite = {
  id: string;
  /** `{ peekKey -> value }` for every peek gate enclosing the leaf. Overlaid on
   *  the base env so the leaf's switch arm / optional region is entered. */
  peekSeeds: Map<string, number>;
};

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
export function collectNestedDynamicWidthLeaves(
  packet: PsdlPacket,
): NonNullable<RendererPacket["dynamicWidthLeaves"]> {
  const out: NonNullable<RendererPacket["dynamicWidthLeaves"]> = [];
  const seen = new Set<string>();
  const discriminators = collectSwitchOnRefIds(packet);
  const defs = packet.defs ?? {};
  const seenRefs = new Set<string>();
  const add = (
    id: string,
    kind: "delimited" | "varint" | "berLength" | "remaining",
  ): void => {
    if (discriminators.has(id) || seen.has(id)) return;
    seen.add(id);
    out.push({ id, kind });
  };
  // `insideRepeat` gates the `bytes(remaining)` seed exactly as
  // `collectRemainingFieldIds` / `collectDynamicWidthFlags` do: a top-level /
  // switch-arm remaining tail is sized from the packet budget (its
  // `__remainingBytes__<id>` width override), but a remaining leaf inside a
  // repeat is governed by the repeat / bounded budget, so it carries no
  // budget-key width to seed.
  const visit = (containers: Container[], insideRepeat: boolean): void => {
    for (const c of containers) {
      if (isField(c)) {
        if (c.type.kind === "varint") add(c.id, "varint");
        else if (c.type.kind === "berLength") add(c.id, "berLength");
        else if (c.type.kind === "bytes" && isBytesDelimited(c.type.n)) {
          add(c.id, "delimited");
        } else if (!insideRepeat && isRemainingSizedBytes(c.type)) {
          add(c.id, "remaining");
        }
        continue;
      }
      switch (c.kind) {
        case "group":
          visit(c.children, insideRepeat);
          break;
        case "repeat":
          visit(c.element.fields, true);
          break;
        case "switch":
          for (const s of Object.values(c.cases)) visit(s.fields, insideRepeat);
          break;
        case "encrypted":
          visit(c.plaintext.fields, insideRepeat);
          break;
        case "optional":
          visit([c.container], insideRepeat);
          break;
        case "bounded":
          visit(c.fields, insideRepeat);
          break;
        case "ref": {
          const def = defs[c.ref];
          if (def && !seenRefs.has(c.ref)) {
            seenRefs.add(c.ref);
            visit(def.fields, insideRepeat);
            seenRefs.delete(c.ref);
          }
          break;
        }
      }
    }
  };
  visit(packet.body, false);
  return out;
}

/**
 * Collect berLength leaf ids whose width PICKER must be SUPPRESSED because every
 * non-default width freezes the diagram.
 *
 * A berLength octet inside a `bounded` scope whose budget is `bytes(ref X)` for a
 * `length`-category sibling X is sized by a DECODED value, not a fixed numeric
 * constant — the scope's byte budget is computed assuming every nested berLength
 * prefix octet is at its 8-bit (1-byte) default. Widening the octet (the
 * WidthPicker's only purpose) grows the prefix, overflows the fixed value-budget,
 * and core's `normalize` throws `bounded scope over-consumed`. PacketViewer's
 * layout try/catch then swallows the throw, so the picker's active option visibly
 * moves to the clicked width while the diagram does NOT change — an inert /
 * misleading control that silently no-ops. The existing `innerScopeSeeds`
 * `derivesBudgetKey` grow-path only grows a budget for a widened VALUE length, not
 * for a widened PREFIX octet that itself sizes the (possibly multiply-nested)
 * budget — there is no crash-free grow path here. So OverridePanel suppresses the
 * WidthPicker for these ids; the octet still renders at its valid 8-bit short-form
 * default, and nothing is shown that cannot change the diagram.
 *
 * Across all 184 presets this matches ONLY ocspRequest's 6 CertID berLength leaves
 * (requestSeqLength / certIdLength / hashAlgLength / issuerNameHashLength /
 * issuerKeyHashLength / serialNumberLength), each nested in
 * `requestListScope = bytes(ref reqListLength)` or
 * `requestContentScope = bytes(ref requestSeqLength)`.
 */
export function collectBerLengthWidthLocked(packet: PsdlPacket): string[] {
  const out = new Set<string>();
  const defs = packet.defs ?? {};
  const seenRefs = new Set<string>();
  const categoryById = collectFieldCategories(packet);
  const isValueBudgetedBounded = (
    c: Extract<Container, { kind: "bounded" }>,
  ): boolean => {
    if (c.bytes.kind !== "ref") return false;
    const ref = singleRefController(c.bytes);
    return ref !== null && categoryById.get(ref) === "length";
  };
  const visit = (
    containers: Container[],
    insideValueBudgeted: boolean,
  ): void => {
    for (const c of containers) {
      if (isField(c)) {
        if (c.type.kind === "berLength" && insideValueBudgeted) out.add(c.id);
        continue;
      }
      switch (c.kind) {
        case "group":
          visit(c.children, insideValueBudgeted);
          break;
        case "repeat":
          visit(c.element.fields, insideValueBudgeted);
          break;
        case "switch":
          for (const s of Object.values(c.cases))
            visit(s.fields, insideValueBudgeted);
          break;
        case "encrypted":
          visit(c.plaintext.fields, insideValueBudgeted);
          break;
        case "optional":
          visit([c.container], insideValueBudgeted);
          break;
        case "bounded":
          visit(c.fields, insideValueBudgeted || isValueBudgetedBounded(c));
          break;
        case "ref": {
          const def = defs[c.ref];
          if (def && !seenRefs.has(c.ref)) {
            seenRefs.add(c.ref);
            visit(def.fields, insideValueBudgeted);
            seenRefs.delete(c.ref);
          }
          break;
        }
      }
    }
  };
  visit(packet.body, false);
  return [...out];
}

/** Map every declared field id to its `category` (descending through every
 *  structural container and inlining `ref` defs). Used to classify a
 *  `bounded(ref X)` budget as value-sized when X is a `length` field. */
function collectFieldCategories(packet: PsdlPacket): Map<string, string> {
  const out = new Map<string, string>();
  const defs = packet.defs ?? {};
  const seenRefs = new Set<string>();
  const visit = (containers: Container[]): void => {
    for (const c of containers) {
      if (isField(c)) {
        if (c.category) out.set(c.id, c.category);
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
 * Walk the body and collect every berLength prefix octet together with the
 * peek-gate seeds (`__peek__<off>__<bits>` = caseValue) needed to render it.
 * A leaf that lives in N nested switch/optional peek gates is emitted once with
 * all N seeds; a leaf reachable through several distinct gate combinations is
 * emitted once per combination (so the probe can pick the arm that renders it).
 */
function collectBerLengthLeafSites(packet: PsdlPacket): BerLengthLeafSite[] {
  const out: BerLengthLeafSite[] = [];
  const defs = packet.defs ?? {};
  const seenRefs = new Set<string>();
  const visit = (containers: Container[], peekSeeds: Map<string, number>) => {
    for (const c of containers) {
      if (isField(c)) {
        if (c.type.kind === "berLength")
          out.push({ id: c.id, peekSeeds: new Map(peekSeeds) });
        continue;
      }
      switch (c.kind) {
        case "group":
          visit(c.children, peekSeeds);
          break;
        case "repeat":
          visit(c.element.fields, peekSeeds);
          break;
        case "switch": {
          const peekKey = switchPeekKey(c.on);
          for (const [caseKey, arm] of Object.entries(c.cases)) {
            const next = new Map(peekSeeds);
            if (peekKey !== null) {
              const v = Number(caseKey);
              if (Number.isFinite(v)) next.set(peekKey, v);
            }
            visit(arm.fields, next);
          }
          break;
        }
        case "encrypted":
          visit(c.plaintext.fields, peekSeeds);
          break;
        case "optional": {
          const gate = matchPeekGate(c.when);
          const next = new Map(peekSeeds);
          if (gate) next.set(gate.peekKey, gate.value);
          visit([c.container], next);
          break;
        }
        case "bounded":
          visit(c.fields, peekSeeds);
          break;
        case "ref": {
          const def = defs[c.ref];
          if (def && !seenRefs.has(c.ref)) {
            seenRefs.add(c.ref);
            visit(def.fields, peekSeeds);
            seenRefs.delete(c.ref);
          }
          break;
        }
      }
    }
  };
  visit(packet.body, new Map());
  return out;
}

/** The `__peek__<offset>__<bits>` env key a `switch on peek(...)` reads, or null
 *  for a switch keyed on anything else (a plain `ref`, a non-literal offset). */
function switchPeekKey(on: Expr): string | null {
  if (on.kind !== "peek") return null;
  const offset = on.offset;
  if (offset && offset.kind !== "lit") return null;
  return peekEnvKey(offset?.kind === "lit" ? offset.value : 0, on.bits);
}

const BER_WIDTH_PROBE_WIDTHS = [8, 16, 24] as const;

/**
 * Build-time layout probe that finds berLength prefix octets whose WidthPicker
 * is INERT / MISLEADING: widening the octet (the picker's only purpose) either
 * throws inside `resolveLayout` — PacketViewer's layout try/catch swallows it so
 * the active option visibly moves while the diagram does NOT (the ocspRequest
 * `bounded(ref length)` over-consume) — OR changes ONLY the octet's own cell
 * width while every OTHER cell (count, bits, segmentation, order) stays
 * byte-for-byte identical, because the grown prefix is absorbed by a trailing
 * length-prefixed sibling rather than reshaping the packet (snmpV2c / snmpv3
 * TLV-style length-prefixed scalars: requestId* / errorIndex* / maxRepetitions*
 * / ctxEngineIdLength). In both cases the dropdown is a control the user can move
 * with zero meaningful effect on the diagram — exactly what `berLengthWidthLocked`
 * exists to suppress; the octet still renders at its valid 8-bit short-form
 * default.
 *
 * A leaf is KEPT EDITABLE (not locked) when widening it adds/removes a cell,
 * wraps it into a new row segment, or resizes ANY sibling/parent cell — e.g.
 * snmpV2c `errorStatusLengthGR` (its octet wraps to a second segment, +1 cell)
 * or `communityLength` (whose enclosing `snmpCommunity` group cell grows). The
 * non-own-cell signature is compared at the field-id level so a leaf that
 * collapses into a parent group cell (and so has no own cell) is locked only if
 * even the parent cell is unchanged.
 */
export function collectBerLengthWidthLockedByProbe(
  packet: PsdlPacket,
): string[] {
  const sites = collectBerLengthLeafSites(packet);
  if (sites.length === 0) return [];

  // Base env mirrors PacketViewer's layout-env build: preset defaults, 0-fill for
  // every unresolved ref, then a visible default width for every dynamic-width
  // (varint / delimited / berLength) leaf. Peek-gate seeds for each leaf's arm
  // are overlaid per-probe so the leaf actually renders.
  const baseEnv = new Map<string, number>(initialEnv(packet));
  for (const r of collectPsdlRefs(packet))
    if (!baseEnv.has(r)) baseEnv.set(r, 0);
  seedDynamicWidthDefaults(packet, baseEnv);

  // Layout signature capturing (a) the total cell count and (b) every cell whose
  // field id !== `exclude`, with its identity, size and segmentation. A trailing
  // length-prefixed sibling that absorbs the grown prefix leaves BOTH unchanged;
  // any real reshape changes one of them — an added cell, the leaf's own octet
  // WRAPPING into a second row segment (which raises the count even though the
  // extra cell shares the excluded id — snmpV2c errorStatusLengthGR), or a
  // resized parent group cell the leaf collapsed into (communityLength's
  // snmpCommunity). Returns null when layout throws (PacketViewer swallows that,
  // so the diagram is unchanged == inert).
  const layoutSignature = (
    env: Map<string, number>,
    exclude: string,
  ): string | null => {
    let cells;
    try {
      cells = resolveLayout(packet, { env }).cells;
    } catch {
      return null; // a throw == diagram unchanged (PacketViewer swallows it)
    }
    const nonOwn = cells
      .filter((c) => c.field.id !== exclude)
      .map((c) => `${c.field.id}:${c.bitsTotal}:${c.segmentIndex}`)
      .join("|");
    return `${cells.length}#${nonOwn}`;
  };

  const locked = new Set<string>();
  for (const site of sites) {
    if (locked.has(site.id)) continue;
    const widthKey = berLenEnvKey(site.id);
    const envFor = (width: number): Map<string, number> => {
      const env = new Map(baseEnv);
      for (const [k, v] of site.peekSeeds) env.set(k, v);
      env.set(widthKey, width);
      return env;
    };
    // The leaf must render at its 8-bit default under this site's arm — else the
    // probe can't observe it (it lives in a non-entered arm) and we leave it
    // alone (some other site, or the structural detector, covers it).
    const baseSig = layoutSignature(envFor(8), site.id);
    if (baseSig === null) continue;
    let inert = true;
    for (const width of BER_WIDTH_PROBE_WIDTHS) {
      if (width === 8) continue;
      const sig = layoutSignature(envFor(width), site.id);
      if (sig === null) continue; // widening threw → diagram frozen → still inert
      if (sig !== baseSig) {
        inert = false;
        break;
      }
    }
    if (inert) locked.add(site.id);
  }
  return [...locked];
}
