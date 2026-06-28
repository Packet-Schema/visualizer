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

import type { Container, Expr, Packet as PsdlPacket } from "./types";
import {
  berLenEnvKey,
  bytesDelimLenEnvKey,
  isBytesDelimited,
  varintBitsEnvKey,
} from "./normalize";
import { isField } from "./utils";

/** A varint with no width is 1 byte minimum on the wire; a delimited string is
 *  shown at a small representative length until the user sets one. */
const VARINT_DEFAULT_BITS = 8;
const DELIMITED_DEFAULT_BYTES = 4;

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
              c.type.kind === "bytes"
                ? DELIMITED_DEFAULT_BYTES
                : VARINT_DEFAULT_BITS;
            seed(widthKey, widthDefault);
          }
          continue;
        }
        if (c.type.kind === "varint") seed(c.id, VARINT_DEFAULT_BITS);
        else if (c.type.kind === "bytes" && isBytesDelimited(c.type.n)) {
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
