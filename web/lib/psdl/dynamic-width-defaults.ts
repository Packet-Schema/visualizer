// Seed visible default widths for dynamic-width leaf fields.
//
// core's normalize gives a varint or delimiter-terminated `bytes` field 0 bits
// when its width env key is unset, so the field renders as NO cell — invisible,
// and (for a top-level field) its width picker, which lives on the missing
// cell, is unreachable. berLength already defaults to a visible 8 bits; this
// brings varint and delimited bytes to parity by seeding a representative width
// when the user hasn't set one. `bridgeDynamicWidthKeys` (layout.ts) then lifts
// the per-field value to the right `__varintBits__` / `__bytesDelimLen__` key,
// so seeding `env[fieldId]` is enough. The seed only fills an unset/0 value, so
// a user-driven width (from the width picker, share URL, …) always wins.

import { exprContains } from "@packet-schema/core";

import type { Container, Expr, Packet as PsdlPacket, Type } from "./types";
import {
  berLenEnvKey,
  bytesDelimLenEnvKey,
  isBytesDelimited,
  varintBitsEnvKey,
} from "./normalize";
import { isField } from "./utils";

/** A varint with no width is 1 byte minimum on the wire; a delimited string is
 *  shown at a small representative length until the user sets one. Exported so
 *  the renderer-mirror bootstrap (`initialState`) can seed the SAME defaults
 *  into the `controllers` React state, keeping the OverridePanel WidthPicker's
 *  highlighted option in agreement with the seeded diagram cell. */
export const VARINT_DEFAULT_BITS = 8;
export const DELIMITED_DEFAULT_BYTES = 4;
/** A BER length octet (ASN.1 short form) is 1 byte = 8 bits — matching core's
 *  `typeBits` berLength fallback. Unlike varint/delimited, a berLength field's
 *  BARE env key often doubles as the byte-COUNT of a sibling `bytes(ref id)`
 *  value (the normal length-of-value pattern, e.g. snmpV2c `versionValue =
 *  bytes(ref versionLength)`), so its wire width is seeded on the DEDICATED
 *  `__berLen__<id>` key — never on `env[id]`, which would also resize the value
 *  AND get 0-stomped by PacketViewer's `psdlRef` 0-seed before the bridge could
 *  read it. The WidthPicker drives the same dedicated key. */
export const BER_LENGTH_DEFAULT_BITS = 8;
/** A `bytes(remaining)` payload (the variable tail of a packet / switch arm) has
 *  NO wire-width env key in core — its size is the leftover of the enclosing
 *  scope's budget. The layout's `normalizeWithBudget` fallback gives such a
 *  region one default row (`max(rowBits, 32)` bits = 4 bytes at the common
 *  32-bit rowBits) so it paints a representative cell; this constant mirrors that
 *  default for the OverridePanel WidthPicker / `initialState` seed so the
 *  picker's active option agrees with the seeded diagram. The user-chosen width
 *  rides on the dedicated `__remainingBytes__<id>` key (a visualizer-only key the
 *  layout honors by sizing the packet budget to `fixedPrefix + bytes*8`); it is
 *  never handed to core, which keeps deriving `remaining` from that budget. */
export const REMAINING_DEFAULT_BYTES = 4;

/** Env key carrying the user-chosen BYTE count of a `bytes(remaining)` payload
 *  field. Visualizer-only (see `REMAINING_DEFAULT_BYTES`): `resolveLayout` reads
 *  it to size the packet budget, never forwarding it to core's normalize. */
export function remainingBytesEnvKey(id: string): string {
  return `__remainingBytes__${id}`;
}

/**
 * True when a `bytes` leaf is sized off the enclosing scope's leftover budget —
 * either a BARE `bytes(remaining)` (`n.kind === "remaining"`) OR a `remaining`
 * wrapped in an arithmetic / conditional expression, the most common being
 * `bytes(remaining - k)` (ppp `information` = `remaining-2`, quicLong
 * `retryToken` = `remaining-16`, ipsecEsp `payloadData` = `remaining-2`) or a
 * `cond` that selects a `remaining`-bearing arm (amt `amtMqData`). Such a field
 * has NO wire-width env key in core — its size derives from the packet budget —
 * so the visualizer drives it through the dedicated `__remainingBytes__<id>`
 * budget key (see `remainingBytesEnvKey` / `readRemainingBytesOverride`).
 *
 * Detecting only the bare form left every op/cond-wrapped remaining payload with
 * no width control: it renders (core sizes it from the real budget) but the user
 * cannot grow / shrink it — a see-but-cannot-edit gap that also breaks
 * edit/round-trip for any PSDL using `remaining - k`.
 */
export function isRemainingSizedBytes(type: Type): boolean {
  // `type.n` is either an `Expr` or a `BytesDelimited` (`{ delimiter }`, no
  // `kind`). `exprContains` / `walkExpr` throw on a non-Expr node, so exclude the
  // delimited descriptor (and any numeric literal count) before walking.
  return (
    type.kind === "bytes" &&
    typeof type.n === "object" &&
    !isBytesDelimited(type.n) &&
    exprContains(type.n as Expr, (e) => e.kind === "remaining")
  );
}

/**
 * Collect the authored ids of every `bytes(remaining)` leaf that is reachable
 * OUTSIDE a repeat (top-level, or nested only in switch cases / optionals /
 * groups / bounded scopes). These render as the variable tail of the packet (or
 * the active switch arm) and their size is the leftover budget of the enclosing
 * scope — the single budget `resolveLayout` controls — so a per-field
 * `__remainingBytes__<id>` override can drive their width.
 *
 * Remaining leaves INSIDE a repeat are excluded: there the per-iteration size is
 * governed by the repeat / bounded budget (its count or length controller), not
 * a packet-level budget knob, so a single byte-count override would not map
 * cleanly onto one cell.
 */
export function collectRemainingFieldIds(psdl: PsdlPacket): Set<string> {
  return new Set(collectRemainingFieldTypes(psdl).keys());
}

/**
 * Like `collectRemainingFieldIds` but maps each rendered remaining-sized leaf id
 * to its `bytes` type. Same `insideRepeat` gating as `collectRemainingFieldIds`.
 * The layout uses the ids as budget-calibration targets so a `bytes(remaining -
 * k)` payload (or one with a fixed trailing sibling) lands the user's chosen
 * byte count on the FIELD rather than the raw leftover (see `resolveLayout`).
 */
export function collectRemainingFieldTypes(
  psdl: PsdlPacket,
): Map<string, Type> {
  const out = new Map<string, Type>();
  const visit = (containers: Container[], insideRepeat: boolean): void => {
    for (const c of containers) {
      if (isField(c)) {
        if (!insideRepeat && isRemainingSizedBytes(c.type))
          out.set(c.id, c.type);
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
        // virtual / align / ref host no top-level `remaining` tail to size.
      }
    }
  };
  visit(psdl.body, false);
  return out;
}

/**
 * Collect the ids of every field that is a `switch ... on: ref(field)`
 * discriminator anywhere in the packet body. Such a field's env key carries the
 * discriminator VALUE (which case core selects), NOT its wire bit-width, so the
 * dynamic-width seed must steer clear of `env[id]` for it and seed the dedicated
 * `__varintBits__<id>` (etc.) width key directly instead — otherwise the two
 * roles of the single key collide (http3Frame's `http3FrameType` is both a quic
 * varint and the `on:ref` target of the frame-payload switch).
 */
export function collectSwitchOnRefIds(psdl: PsdlPacket): Set<string> {
  const ids = new Set<string>();
  const isRef = (e: Expr): e is Expr & { kind: "ref"; field: string } =>
    e.kind === "ref" && typeof (e as { field?: unknown }).field === "string";
  const visit = (containers: Container[]): void => {
    for (const c of containers) {
      if (isField(c)) continue;
      switch (c.kind) {
        case "switch":
          if (isRef(c.on)) ids.add(c.on.field);
          for (const s of Object.values(c.cases)) visit(s.fields);
          break;
        case "group":
          visit(c.children);
          break;
        case "repeat":
          visit(c.element.fields);
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
        // virtual / align / ref host no nested switch discriminator.
      }
    }
  };
  visit(psdl.body);
  return ids;
}

export function seedDynamicWidthDefaults(
  psdl: PsdlPacket,
  env: Map<string, number>,
): void {
  const seed = (id: string, value: number) => {
    const cur = env.get(id);
    if (cur === undefined || cur === 0) env.set(id, value);
  };
  // A dynamic-width field that is ALSO a switch discriminator overloads its env
  // key for the discriminator value; seed its wire width on the dedicated bits
  // key instead so the value key stays free to select a case.
  const discriminators = collectSwitchOnRefIds(psdl);
  const defs = psdl.defs ?? {};
  const seenRefs = new Set<string>(); // guard recursive defs.
  const widthKeyFor = (c: Container): string | null => {
    if (!isField(c)) return null;
    if (c.type.kind === "varint") return varintBitsEnvKey(c.id);
    if (c.type.kind === "berLength") return berLenEnvKey(c.id);
    if (c.type.kind === "bytes" && isBytesDelimited(c.type.n))
      return bytesDelimLenEnvKey(c.id);
    return null;
  };
  const visit = (containers: Container[]): void => {
    for (const c of containers) {
      if (isField(c)) {
        if (discriminators.has(c.id)) {
          // Seed the wire width on the dedicated key; leave env[id] (the
          // discriminator value) untouched so the case picker stays in control.
          const widthKey = widthKeyFor(c);
          if (widthKey) {
            const widthDefault =
              c.type.kind === "berLength"
                ? BER_LENGTH_DEFAULT_BITS
                : c.type.kind === "bytes"
                  ? DELIMITED_DEFAULT_BYTES
                  : VARINT_DEFAULT_BITS;
            seed(widthKey, widthDefault);
          }
          continue;
        }
        if (c.type.kind === "varint") seed(c.id, VARINT_DEFAULT_BITS);
        else if (c.type.kind === "berLength") {
          // Seed the DEDICATED width key (not env[c.id]): a berLength's bare key
          // can carry the length VALUE that sizes a sibling `bytes(ref c.id)`,
          // and PacketViewer's psdlRef 0-seed pre-fills env[c.id]=0. Seeding the
          // dedicated key both renders the octet at its default width AND, via
          // `bridgeDynamicWidthKeys`' `!env.has(key)` guard, stops that bare 0
          // from being copied onto the width key (which dropped the octet to 0
          // bits — invisible, with its WidthPicker unreachable).
          seed(berLenEnvKey(c.id), BER_LENGTH_DEFAULT_BITS);
        } else if (c.type.kind === "bytes" && isBytesDelimited(c.type.n)) {
          seed(c.id, DELIMITED_DEFAULT_BYTES);
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
          // A `ref` expands a named struct; a varint / delimited-bytes leaf
          // inside it is a real, paintable cell whose width core reads under the
          // bare leaf id (varint via typeBits(field.id); delimited via the bare
          // value fanned onto per-instance keys by qualifyDelimitedWidthKeys), so
          // it must be seeded too — without descending here it stays 0 bits and
          // renders no cell (see-but-cannot-edit). Seed the bare authored leaf id.
          const def = defs[c.ref];
          if (def && !seenRefs.has(c.ref)) {
            seenRefs.add(c.ref);
            visit(def.fields);
            seenRefs.delete(c.ref);
          }
          break;
        }
        // virtual / align expose no dynamic-width leaf to seed.
      }
    }
  };
  visit(psdl.body);
}
