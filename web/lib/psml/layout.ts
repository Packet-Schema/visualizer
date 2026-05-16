// PSML 0.2 — layout adapter.
//
// `resolveLayout(psmlPacket, env)` is the entry point used by the format
// hub to compute a renderer-shaped layout from a PSML Packet. It runs
// PSML's `normalize()` to expand Repeat/Switch/Group, then walks the flat
// NormalizedField[] to produce a `ResolvedLayout` with row-segmented cells
// matching the v1 cell-layout output (so existing format renderers stay
// surface-level — they only need to know how to read cells).

import type { NormalizedField, PacketEnv, Packet as PsmlPacket, ViewMode } from "./types";
import { initialEnv, normalize } from "./normalize";
import type { Cell, Field as RuntimeField, ResolvedLayout } from "./runtime-types";

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
  const env: PacketEnv = new Map(options.env ?? initialEnv(packet));
  const viewMode: ViewMode = options.viewMode ?? "wire";
  const norm = normalize(packet, env, { viewMode });
  const cells: Cell[] = [];
  let bitPos = 0;
  for (const nf of norm.fields) {
    const synthetic: RuntimeField = {
      id: nf.id,
      name: nf.name,
      bits: nf.bits,
      ...(nf.category ? { category: nf.category } : {}),
      ...(nf.doc ? { description: nf.doc } : {}),
    };
    bitPos = emitField(synthetic, nf, bitPos, packet.rowBits, cells);
  }
  return { cells, totalBits: norm.totalBits };
}

function emitField(
  field: RuntimeField,
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
    cells.push(cell);
    remaining -= take;
    bitPos += take;
    segmentIndex++;
  }
  return bitPos;
}

function computeSegmentCount(startPos: number, bits: number, rowBits: number): number {
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
