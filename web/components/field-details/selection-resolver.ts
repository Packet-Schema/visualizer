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
import { parseTlvCellId } from "@/lib/psml/psml-to-renderer/tlv-cell-id";

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
  // TLV synthetic cells (`<X>__inst_N`, `<X>__inst_N__<leaf>`,
  // `<X>__inst_N:<...>`, `<X>__remaining`) are minted by
  // `applyTlvInstances` and don't exist on `packet.fields`. Resolve them
  // back to the parent TLV field so the DetailPanel shows that field's
  // info instead of "subfield not found" (Codex P2). OverridePanel does
  // its own `parseTlvCellId` routing for the editing surface; here we
  // only need the parent for the read-only detail view.
  const tlvRole = parseTlvCellId(selectedFieldId);
  if (tlvRole.kind !== "plain") {
    const field = packet.fields.find((f) => f.id === tlvRole.baseId && f.tlv);
    return field ? { kind: "field", field } : { kind: "field-not-found" };
  }
  // Subfield ids are `<parent>:<sub>`. The parent half may itself carry
  // a `#<repeatIndex>` decoration when emitted from inside a Repeat
  // (e.g. `flagsBits#0:flags_df`), so strip the repeat tag only from
  // the parent half. Splitting on `#` first would have swallowed the
  // `:flags_df` portion entirely.
  // Repeat decoration may be multi-segment when Groups nest inside
  // multiple Repeats (`flagsBits#0_1` for `[0][1]`). Strip the whole
  // `#a(_b)*` chain, not just the trailing `#N` (Codex P1).
  const STRIP_REPEAT_TAG = /#\d+(?:_\d+)*$/;
  // Use `lastIndexOf` rather than `split(":")` so that ids containing
  // a literal colon (TLV synthetic ids like
  // `options__inst_0:options__inst_0__type`) split on the rightmost
  // separator only — splitting from the left misattributes the parent
  // half and the editor stops opening (Codex P2). `validatePsmlPacket`
  // also rejects `:` in user-authored field ids so this only ever runs
  // on renderer-minted shapes, but defense in depth is cheap.
  const colonIdx = selectedFieldId.lastIndexOf(":");
  if (colonIdx >= 0) {
    const parentRaw = selectedFieldId.slice(0, colonIdx);
    const subId = selectedFieldId.slice(colonIdx + 1);
    const parentId = parentRaw.replace(STRIP_REPEAT_TAG, "");
    const parent = packet.fields.find((f) => f.id === parentId);
    const sub = parent?.subfields?.find((s) => s.id === subId);
    return parent && sub
      ? { kind: "subfield", parent, sub }
      : { kind: "subfield-not-found" };
  }
  // Non-subfield ids strip the same chain — the recovery target is
  // always the underlying renderer-mirror field.
  const baseId = selectedFieldId.replace(STRIP_REPEAT_TAG, "");
  // Bare subfield id (groups whose children render as their own top-level
  // cells lose the `parent:` prefix in the id stream).
  for (const parent of packet.fields) {
    const sub = parent.subfields?.find((s) => s.id === baseId);
    if (sub) return { kind: "subfield", parent, sub };
  }
  const field = packet.fields.find((f) => f.id === baseId);
  return field ? { kind: "field", field } : { kind: "field-not-found" };
}
