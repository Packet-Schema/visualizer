// Extracted from `index.ts` (PSDL → renderer adapter) — no logic changes.

import { isField } from "../utils";
import { peekEnvKey } from "../expr";
import type {
  Container,
  Expr,
  NamedStruct,
  Packet as PsdlPacket,
  Struct,
} from "../types";
import { caseKeyCoversValue } from "./shared";

/** Collect every `ref` field id reachable inside an arbitrary value (Expr tree,
 *  type node, …). Generic so it doesn't need to enumerate the Expr union. */
export function refsIn(value: unknown, acc: Set<string>): void {
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
export function collectLengthDrivingRefs(
  body: PsdlPacket["body"],
): Set<string> {
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
export function collectFieldBits(
  body: PsdlPacket["body"],
): Map<string, number> {
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
export function collectFieldDefaults(
  body: PsdlPacket["body"],
): Map<string, number> {
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

/** Map each field id to its declared `category` (descending through every
 *  structural container). Used to classify a switch discriminator: an
 *  Extended-Length FLAG (`category: "flags"`, e.g. BGP `attrExtLen`) whose arms
 *  are all length ints at distinct widths is surfaced as a refSwitch even when
 *  repeat-nested, where the blanket sub-byte length-encoder heuristic would
 *  otherwise suppress it. (The `PsdlPacket`-shaped `collectFieldCategories` walks
 *  ref-defs too; this body-only variant is what `collectRefSwitches` consults.) */
export function collectFieldCategoriesByBody(
  body: PsdlPacket["body"],
): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (containers: PsdlPacket["body"]): void => {
    for (const c of containers) {
      if (isField(c)) {
        if (c.category) out.set(c.id, c.category);
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

/**
 * True for a repeat-nested Extended-Length FLAG switch — the BGP `attrExtLen`
 * idiom: a 1-bit discriminator of `category: "flags"` whose every arm (the listed
 * cases AND the `_` default) is a SINGLE `length` int, and whose arms render at
 * ≥ 2 DISTINCT widths (case `1` → 16-bit `bgpAttrLength16`, `_` → 8-bit
 * `bgpAttrLength8`). This is the same Extended-Length discriminator class as the
 * already-surfaced top-level coap/websocket nibbles, but expressed as a flags BIT
 * inside a per-record repeat. Driving it visibly swaps the rendered Attribute
 * Length cell (8-bit ⇄ 16-bit) and the diagram resolves cleanly at either value —
 * yet the blanket sub-byte length-encoder heuristic suppressed it, leaving the
 * visible flag bit and length cell see-but-cannot-edit. Surfacing it is therefore
 * safe and required. Narrower than the sub-byte heuristic it relaxes: it demands a
 * 1-bit `flags` discriminator with ALL-length arms at distinct widths, so it never
 * catches a record-type code (≥ 8 bits) or a variant-selecting nibble.
 */
export function isExtendedLengthFlagSwitch(
  cases: Record<string, { fields: Container[] }>,
  discBits: number | undefined,
  discCategory: string | undefined,
): boolean {
  if (discBits !== 1 || discCategory !== "flags") return false;
  const widths = new Set<number>();
  for (const struct of Object.values(cases)) {
    if (struct.fields.length !== 1) return false;
    const f = struct.fields[0]!;
    if (!isField(f) || f.category !== "length") return false;
    const t = f.type as { bits?: number; n?: unknown };
    const w =
      typeof t.bits === "number"
        ? t.bits
        : typeof t.n === "number"
          ? t.n
          : undefined;
    if (w === undefined) return false;
    widths.add(w);
  }
  return widths.size >= 2;
}

/** Map each `enum` field id to its `value → label` table. Used to render a
 *  switch discriminator value (msdpType=3) as a human-readable case label
 *  ("SA-Response") when disambiguating colliding switch-case-nested freeRepeat
 *  steppers. Plain int discriminators (icmpv6Ndp `type`) have no entry; the
 *  caller falls back to the bare numeric value. */
export function collectEnumVariants(
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
export function collectFieldNames(
  body: PsdlPacket["body"],
): Map<string, string> {
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
export function collectVirtualIds(
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
export function collectSelfRefVirtualIds(
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

/** The first field id declared anywhere inside `containers` (document order,
 *  recursing through groups / bounded / optional / switch arms / nested repeats),
 *  or null if none. Used as a `fieldRendered` gate anchor for a control surfaced
 *  over a region that may be absent from the diagram (an optional-wrapped repeat,
 *  a peek switch whose arm isn't drawn): when this id is a rendered cell the
 *  region is present and the control is live; otherwise the panel disables it with
 *  a hint instead of contradicting the diagram. */
export function firstInnerFieldId(containers: Container[]): string | null {
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
export function findArmByCaseValue(
  cases: Record<string, Struct>,
  value: number,
): Struct | undefined {
  for (const [key, struct] of Object.entries(cases)) {
    if (caseKeyCoversValue(key, value)) return struct;
  }
  return undefined;
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
export function matchPeekGate(
  when: Expr,
): { peekKey: string; value: number } | null {
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
