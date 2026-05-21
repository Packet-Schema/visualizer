// PSML 0.2 — layout adapter.
//
// `resolveLayout(psmlPacket, env)` is the entry point used by the format
// hub to compute a renderer-shaped layout from a PSML Packet. It runs
// PSML's `normalize()` to expand Repeat/Switch/Group, then walks the flat
// NormalizedField[] to produce a `ResolvedLayout` with row-segmented cells
// matching the v1 cell-layout output (so existing format renderers stay
// surface-level — they only need to know how to read cells).

import type {
  NormalizedField,
  PacketEnv,
  Packet as PsmlPacket,
  ViewMode,
} from "./types";
import { initialEnv, normalize } from "./normalize";
import type {
  Cell,
  Field as RendererField,
  ResolvedLayout,
  SubCell,
} from "./renderer";

export type LayoutOptions = {
  /** Environment overlay merged on top of preset defaults. */
  env?: PacketEnv;
  /**
   * Wire vs. semantic view of any Encrypted containers in the schema.
   * Defaults to `'wire'`. See `web/lib/psml/normalize.ts` for the full
   * contract.
   */
  viewMode?: ViewMode;
};

/** Compute a renderer-shaped layout for a PSML packet. */
export function resolveLayout(
  packet: PsmlPacket,
  options: LayoutOptions = {},
): ResolvedLayout {
  // `validate.ts` already requires rowBits > 0 on the import path, but
  // callers that hand-build a PsmlPacket in tests / fuzz harness can
  // reach `resolveLayout` without going through validation. Guarding
  // here keeps the `bitPos % rowBits` / `Math.floor(bitPos / rowBits)`
  // arithmetic below from collapsing into NaN.
  if (!Number.isInteger(packet.rowBits) || packet.rowBits <= 0) {
    throw new Error(
      `resolveLayout: rowBits must be a positive integer; got ${String(packet.rowBits)}.`,
    );
  }
  const env: PacketEnv = new Map(options.env ?? initialEnv(packet));
  const viewMode: ViewMode = options.viewMode ?? "wire";
  const norm = normalize(packet, env, { viewMode });
  const cells: Cell[] = [];
  let bitPos = 0;
  // Renderer interpretation pass (see PSML design principles —
  // "semantic, not presentational"): runs of consecutive NormalizedFields
  // that share the same non-empty `originalContainerPath` come from the
  // same Group / Switch case / Repeat iteration; collapse them into one
  // synthetic cell whose `subfields[]` lists the children. Top-level
  // fields (path === "") stay flat. The visual interpretation is purely
  // additive — `NormalizedField[]` itself is unchanged, so RFC ASCII /
  // JSON / other consumers keep the flat structure.
  const groups = groupConsecutiveByContainer(norm.fields);
  for (const g of groups) {
    if (g.kind === "flat") {
      const nf = g.field;
      const synthetic: RendererField = {
        id: nf.id,
        name: nf.name,
        bits: nf.bits,
        ...(nf.category ? { category: nf.category } : {}),
        ...(nf.doc ? { description: nf.doc } : {}),
      };
      bitPos = emitField(synthetic, nf, bitPos, packet.rowBits, cells);
      continue;
    }
    // Collapsed group: synthesise one parent cell with subfields.
    const first = g.children[0];
    const totalBits = g.children.reduce((a, f) => a + f.bits, 0);
    if (totalBits === 0) continue;
    const synthetic: RendererField = {
      id: g.parentId,
      name: g.parentName,
      bits: totalBits,
      subfields: g.children.map((c) => ({
        id: c.id.replace(/#\d+$/, ""), // strip repeatIndex for stable subfield id
        name: c.name,
        bits: c.bits,
        ...(c.doc ? { description: c.doc } : {}),
      })),
      ...(g.children.find((c) => c.category)?.category
        ? { category: g.children.find((c) => c.category)!.category! }
        : {}),
    };
    const proxy: typeof first = {
      ...first,
      id: g.parentId,
      name: g.parentName,
      bits: totalBits,
    };
    bitPos = emitField(synthetic, proxy, bitPos, packet.rowBits, cells);
  }
  return { cells, totalBits: norm.totalBits };
}

type GroupedRun =
  | { kind: "flat"; field: NormalizedField }
  | {
      kind: "collapsed";
      parentId: string;
      parentName: string;
      children: NormalizedField[];
    };

/**
 * Walk the flat NormalizedField list and combine consecutive entries that
 * share the same `groupId` (i.e. they were emitted as siblings inside
 * the same `Group` container). The combined run becomes a single cell
 * whose `subfields[]` lists each child — canonical use: IPv4/TCP flags
 * (3 1-bit children of a Group become one cell with three sub-cells)
 * and TLV instance Groups (per-instance leaf list becomes one cell
 * named after the variant). Fields outside any Group stay flat. Single-
 * child Groups also stay flat (no benefit from a 1-child collapse).
 */
function groupConsecutiveByContainer(
  fields: NormalizedField[],
): GroupedRun[] {
  const out: GroupedRun[] = [];
  let i = 0;
  while (i < fields.length) {
    const f = fields[i];
    if (!f.groupId) {
      out.push({ kind: "flat", field: f });
      i++;
      continue;
    }
    const groupId = f.groupId;
    const run: NormalizedField[] = [f];
    let j = i + 1;
    while (j < fields.length && fields[j].groupId === groupId) {
      run.push(fields[j]);
      j++;
    }
    if (run.length === 1) {
      out.push({ kind: "flat", field: f });
      i = j;
      continue;
    }
    out.push({
      kind: "collapsed",
      parentId: groupId,
      parentName: f.groupName ?? groupId,
      children: run,
    });
    i = j;
  }
  return out;
}

function emitField(
  field: RendererField,
  nf: NormalizedField,
  bitPos: number,
  rowBits: number,
  cells: Cell[],
): number {
  const bits = nf.bits;
  if (bits === 0) return bitPos;
  let remaining = bits;
  let segmentIndex = 0;
  const totalSegments = computeSegmentCount(bitPos, bits, rowBits);
  while (remaining > 0) {
    const row = Math.floor(bitPos / rowBits);
    const colInRow = bitPos % rowBits;
    const take = Math.min(remaining, rowBits - colInRow);
    const cell: Cell = {
      field,
      bitsTotal: bits,
      row,
      startBit: colInRow,
      endBit: colInRow + take - 1,
      segmentIndex,
      totalSegments,
      isFirst: segmentIndex === 0,
      isLast: remaining === take,
      fieldStartOffset: bits - remaining,
      fieldEndOffset: bits - remaining + take - 1,
    };
    if (nf.encrypted) cell.encrypted = true;
    if (nf.encryptedParentId !== undefined) {
      cell.encryptedParentId = nf.encryptedParentId;
    }
    if (nf.encryptedContextNote !== undefined) {
      cell.encryptedContextNote = nf.encryptedContextNote;
    }
    if (nf.headerProtected) cell.headerProtected = true;
    if (nf.byteOrder) cell.byteOrder = nf.byteOrder;
    if (field.subfields && field.subfields.length > 0) {
      cell.subCells = buildSubCells(
        field,
        field.subfields,
        cell.fieldStartOffset,
        cell.fieldEndOffset,
        colInRow,
        rowBits,
      );
    }
    cells.push(cell);
    remaining -= take;
    bitPos += take;
    segmentIndex++;
  }
  return bitPos;
}

/**
 * Build the per-segment SubCell list for a parent cell that owns
 * `subfields`. The parent cell's segment covers the parent-field offset
 * range [`fieldStartOffset`, `fieldEndOffset`]; we walk every subfield's
 * own offset range and emit a SubCell for the slice that intersects this
 * segment. A 3-bit `flagsBits` Group fully on one row produces three 1-bit
 * SubCells; a longer subfield that straddles rows emits two SubCells
 * (one per row segment) with `isFirst`/`isLast` markers matching how
 * parent cells segment.
 */
function buildSubCells(
  parentField: RendererField,
  subfields: NonNullable<RendererField["subfields"]>,
  fieldStartOffset: number,
  fieldEndOffset: number,
  segmentColInRow: number,
  _rowBits: number,
): SubCell[] {
  const out: SubCell[] = [];
  let cursor = 0;
  for (const sf of subfields) {
    const subStart = cursor;
    const subEnd = cursor + sf.bits;
    cursor = subEnd;
    const lo = Math.max(subStart, fieldStartOffset);
    const hi = Math.min(subEnd, fieldEndOffset + 1);
    if (lo >= hi) continue;
    const startBit = segmentColInRow + (lo - fieldStartOffset);
    const endBit = startBit + (hi - lo) - 1;
    out.push({
      parentField,
      subfield: sf,
      id: `${parentField.id}:${sf.id}`,
      startBit,
      endBit,
      isFirst: lo === subStart,
      isLast: hi === subEnd,
      bitsTotal: sf.bits,
    });
  }
  return out;
}

function computeSegmentCount(
  startPos: number,
  bits: number,
  rowBits: number,
): number {
  let remaining = bits;
  let pos = startPos;
  let count = 0;
  while (remaining > 0) {
    const colInRow = pos % rowBits;
    const take = Math.min(remaining, rowBits - colInRow);
    remaining -= take;
    pos += take;
    count++;
  }
  return count;
}
