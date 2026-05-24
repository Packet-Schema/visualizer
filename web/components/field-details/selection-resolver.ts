// Shared selection resolver for the field-detail panels.
//
// `selectedFieldId` (set by HybridDiagram cell clicks) carries one of these
// shapes:
//   * `null` — nothing selected.
//   * `<fieldId>` — top-level cell.
//   * `<fieldId>#<repeatIndex>` — a virtual cell emitted by Repeat expansion
//     (e.g. `type#0` for the first IPv4 Option's Type cell). The leaf belongs
//     to the parent's TLV catalog; routing back to the parent surfaces the
//     correct editor.
//   * `<parentId>:<subId>` — subfield (e.g. `flagsBits:flags_df`).
//
// Two panels (DetailPanel and OverridePanel) need the same resolution, so
// the lookup lives here.

import type { Field, Packet, SubField } from "@/lib/psml/renderer";

export type Resolution =
  | { kind: "empty" }
  | { kind: "subfield"; parent: Field; sub: SubField }
  | { kind: "subfield-not-found" }
  | { kind: "field"; field: Field }
  | { kind: "field-not-found" };

export function resolveSelection(
  packet: Packet,
  selectedFieldId: string | null,
): Resolution {
  if (!selectedFieldId) return { kind: "empty" };
  // Subfield ids are `<parent>:<sub>`. The parent half may itself carry
  // a `#<repeatIndex>` decoration when emitted from inside a Repeat
  // (e.g. `flagsBits#0:flags_df`), so strip the repeat tag only from
  // the parent half. Splitting on `#` first would have swallowed the
  // `:flags_df` portion entirely.
  if (selectedFieldId.includes(":")) {
    const [parentRaw, subId] = selectedFieldId.split(":");
    const parentId = parentRaw.replace(/#\d+$/, "");
    const parent = packet.fields.find((f) => f.id === parentId);
    const sub = parent?.subfields?.find((s) => s.id === subId);
    return parent && sub
      ? { kind: "subfield", parent, sub }
      : { kind: "subfield-not-found" };
  }
  // Non-subfield ids strip `#<N>` and the various TLV synthetic
  // suffixes alike — the recovery target is always the underlying
  // renderer-mirror field.
  const baseId = selectedFieldId.replace(/#\d+$/, "");
  // Bare subfield id (groups whose children render as their own top-level
  // cells lose the `parent:` prefix in the id stream).
  for (const parent of packet.fields) {
    const sub = parent.subfields?.find((s) => s.id === baseId);
    if (sub) return { kind: "subfield", parent, sub };
  }
  const field = packet.fields.find((f) => f.id === baseId);
  return field ? { kind: "field", field } : { kind: "field-not-found" };
}
