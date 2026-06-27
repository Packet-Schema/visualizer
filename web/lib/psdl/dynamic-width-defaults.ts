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

import type { Container, Packet as PsdlPacket } from "./types";
import { isBytesDelimited } from "./normalize";
import { isField } from "./utils";

/** A varint with no width is 1 byte minimum on the wire; a delimited string is
 *  shown at a small representative length until the user sets one. */
const VARINT_DEFAULT_BITS = 8;
const DELIMITED_DEFAULT_BYTES = 4;

export function seedDynamicWidthDefaults(
  psdl: PsdlPacket,
  env: Map<string, number>,
): void {
  const seed = (id: string, value: number) => {
    const cur = env.get(id);
    if (cur === undefined || cur === 0) env.set(id, value);
  };
  const visit = (containers: Container[]): void => {
    for (const c of containers) {
      if (isField(c)) {
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
        // virtual / align / ref expose no dynamic-width leaf to seed.
      }
    }
  };
  visit(psdl.body);
}
