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

import type { Cell, Field, Packet, SubField } from "@/lib/psdl/renderer";
import { parseTlvCellId } from "@/lib/psdl/psdl-to-renderer/tlv-cell-id";

export type Resolution =
  | { kind: "empty" }
  | { kind: "subfield"; parent: Field; sub: SubField }
  | { kind: "subfield-not-found" }
  | { kind: "field"; field: Field }
  | { kind: "field-not-found" };

export function resolveSelection(
  packet: Packet,
  selectedFieldId: string | null,
  cells?: readonly Cell[],
): Resolution {
  const mirror = resolveFromMirror(packet, selectedFieldId);
  // The renderer mirror only carries fields for the TLV/chain idioms plus flat
  // top-level fields; cells emitted from inside a plain (non-TLV/non-chain)
  // repeat have no mirror field, so a click on one used to dead-end at "Field
  // not found". The diagram cells ARE the source of truth for what is on
  // screen, so fall back to them — every clickable cell resolves by
  // construction (override-audit finding A1).
  if (
    cells &&
    selectedFieldId &&
    (mirror.kind === "field-not-found" || mirror.kind === "subfield-not-found")
  ) {
    const fromCells = resolveFromCells(cells, selectedFieldId);
    if (fromCells) return fromCells;
  }
  return mirror;
}

/** Resolve a clicked cell id against the diagram's own cells. The cell `field`
 *  (and group `subCells`) carry name/bits/category/description straight from
 *  the normalized layout, so this covers every rendered cell — including the
 *  ~170 presets whose repeated records never reach the renderer mirror. */
function resolveFromCells(
  cells: readonly Cell[],
  id: string,
): Resolution | null {
  for (const cell of cells) {
    if (cell.field.id === id) {
      // core stamps a per-field byteOrder onto `Cell.byteOrder` (the source of
      // the diagram's `[LE]`/`[BE]` marker) but NEVER copies it onto
      // `cell.field.byteOrder`. A nested field reaches the panel only through
      // this cell path, so surface the cell's effective byteOrder on the
      // resolved field — otherwise OverridePanel's `field.byteOrder` gate is
      // always false and the user can see a byte-swapped cell they cannot flip.
      return {
        kind: "field",
        field:
          cell.byteOrder && cell.byteOrder !== cell.field.byteOrder
            ? { ...cell.field, byteOrder: cell.byteOrder }
            : cell.field,
      };
    }
    for (const sc of cell.subCells ?? []) {
      if (sc.id === id) {
        return {
          kind: "subfield",
          parent: sc.parentField,
          // Same fix for a Group-nested sub-cell: `SubCell.byteOrder` carries
          // the per-child marker, but `sc.subfield.byteOrder` does not.
          sub:
            sc.byteOrder && sc.byteOrder !== sc.subfield.byteOrder
              ? { ...sc.subfield, byteOrder: sc.byteOrder }
              : sc.subfield,
        };
      }
    }
  }
  return null;
}

function resolveFromMirror(
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
  // half and the editor stops opening (Codex P2). `validatePsdlPacket`
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
