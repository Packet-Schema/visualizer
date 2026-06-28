// Stamp the renderer mirror's diagram-driven byteOrder flips back onto the
// PSDL packet that feeds `resolveLayout`, so a flip on a Switch-case- /
// Repeat-element-nested cell actually changes the diagram's `[LE]`/`[BE]`
// marker.
//
// Top-level fields carry their byteOrder on `mirror.fields`, and the diagram
// re-derives from that mirror outside editMode (or from `studioState.packet`
// inside editMode). A NESTED field is only ever a `Cell` — it never reaches
// `mirror.fields` — so its flip is recorded on `mirror.byteOrderOverrides`
// (keyed by field id) instead. This pass deep-walks the PSDL body (every
// composition primitive: Group / Optional / Switch / Encrypted / Repeat /
// Bounded) and applies those overrides to the matching `Field`, leaving the
// body's shape otherwise untouched.
//
// The walk is shape-preserving: a subtree with no override inside it returns
// the same reference, so the common no-edit case is O(body) with zero churn.

import { isField } from "../utils";
import type { Container, Packet as PsdlPacket } from "../types";
import type { Packet as RendererPacket } from "../renderer";

type Overrides = Record<string, "BE" | "LE">;

function applyToContainer(c: Container, overrides: Overrides): Container {
  if (isField(c)) {
    const next = overrides[c.id];
    if (next !== undefined && c.byteOrder !== next) {
      return { ...c, byteOrder: next };
    }
    return c;
  }
  if (c.kind === "group") {
    const children = c.children.map((ch) => applyToContainer(ch, overrides));
    return children.some((ch, i) => ch !== c.children[i])
      ? { ...c, children }
      : c;
  }
  if (c.kind === "repeat") {
    const fields = c.element.fields.map((f) => applyToContainer(f, overrides));
    return fields.some((f, i) => f !== c.element.fields[i])
      ? { ...c, element: { ...c.element, fields } }
      : c;
  }
  if (c.kind === "switch") {
    let mutated = false;
    const cases: Record<string, (typeof c.cases)[string]> = {};
    for (const [k, v] of Object.entries(c.cases)) {
      const fields = v.fields.map((f) => applyToContainer(f, overrides));
      if (fields.some((f, i) => f !== v.fields[i])) {
        mutated = true;
        cases[k] = { ...v, fields };
      } else {
        cases[k] = v;
      }
    }
    return mutated ? { ...c, cases } : c;
  }
  if (c.kind === "encrypted") {
    const fields = c.plaintext.fields.map((f) =>
      applyToContainer(f, overrides),
    );
    return fields.some((f, i) => f !== c.plaintext.fields[i])
      ? { ...c, plaintext: { ...c.plaintext, fields } }
      : c;
  }
  if (c.kind === "optional") {
    const container = applyToContainer(c.container, overrides);
    return container !== c.container ? ({ ...c, container } as typeof c) : c;
  }
  if (c.kind === "bounded") {
    const fields = c.fields.map((f) => applyToContainer(f, overrides));
    return fields.some((f, i) => f !== c.fields[i]) ? { ...c, fields } : c;
  }
  // align / ref carry no nested Field to stamp.
  return c;
}

/** Return a new PSDL packet whose Fields carry the renderer mirror's
 *  diagram-driven byteOrder flips (`mirror.byteOrderOverrides`). When the
 *  mirror has no recorded overrides the input packet is returned unchanged
 *  (same reference), so callers can chain it cheaply in a layout memo. */
export function applyByteOrderOverrides(
  psdl: PsdlPacket,
  mirror: RendererPacket,
): PsdlPacket {
  const overrides = mirror.byteOrderOverrides;
  if (!overrides || Object.keys(overrides).length === 0) return psdl;
  const body = psdl.body.map((c) => applyToContainer(c, overrides));
  return body.some((c, i) => c !== psdl.body[i]) ? { ...psdl, body } : psdl;
}
