// PSML 0.2 — RFC ASCII art exporter.
//
// Takes a PSML Packet, normalises it through PSML's expression-aware walker,
// runs the cell-layout in `web/lib/psml/layout.ts`, and prints a canonical
// RFC 791 / 793 style ASCII diagram. Variable-length fields render only
// when the supplied env gives them a concrete bit count.

import { resolveLayout } from "../psml/layout";
import type { PacketEnv, Packet as PsmlPacket } from "../psml/types";
import type { Cell } from "../psml/runtime-types";

type RowCellLike = {
  startBit: number;
  endBit: number;
  isFirst: boolean;
  field: { name: string };
};

export function toAscii(packet: PsmlPacket, env?: PacketEnv): string {
  const layout = resolveLayout(packet, { env });
  const rowBits = packet.rowBits;

  const rowsMap = new Map<number, Cell[]>();
  for (const cell of layout.cells) {
    const list = rowsMap.get(cell.row);
    if (list) list.push(cell);
    else rowsMap.set(cell.row, [cell]);
  }
  const rowIndices = [...rowsMap.keys()].sort((a, b) => a - b);

  const lines: string[] = [];
  lines.push(headerLine1(rowBits));
  lines.push(headerLine2(rowBits));
  lines.push(separator(rowBits));

  for (const r of rowIndices) {
    const row = (rowsMap.get(r) ?? []).slice().sort((a, b) => a.startBit - b.startBit);
    if (row.length === 0) continue;
    const expanded: RowCellLike[] = row.map((c) => ({
      startBit: c.startBit,
      endBit: c.endBit,
      isFirst: c.isFirst,
      field: { name: c.field.name },
    }));
    const last = expanded[expanded.length - 1];
    const rowWidth = last.endBit + 1;
    lines.push(fieldLine(expanded, rowWidth));
    lines.push(separator(rowWidth));
  }

  return lines.join("\n");
}

function headerLine1(rowBits: number): string {
  const width = 1 + rowBits * 2;
  const chars = new Array<string>(width).fill(" ");
  const groups = Math.floor(rowBits / 8);
  for (let g = 0; g < groups; g++) {
    const col = 1 + g * 16;
    const num = String(g);
    for (let i = 0; i < num.length; i++) chars[col + i] = num[i];
  }
  return chars.join("").replace(/\s+$/, "");
}

function headerLine2(rowBits: number): string {
  const parts: string[] = [];
  for (let b = 0; b < rowBits; b++) parts.push(String(b % 10));
  return " " + parts.join(" ");
}

function separator(rowBits: number): string {
  return "+" + "-+".repeat(rowBits);
}

function fieldLine(cells: RowCellLike[], rowWidth: number): string {
  let out = "|";
  for (const c of cells) {
    const bits = c.endBit - c.startBit + 1;
    const cellWidth = bits * 2 - 1;
    let label: string = c.isFirst ? c.field.name : "";
    if (label.length > cellWidth) {
      label =
        cellWidth > 1 ? label.slice(0, cellWidth - 1) + "." : label.slice(0, cellWidth);
    }
    const pad = cellWidth - label.length;
    const left = Math.floor(pad / 2);
    const right = pad - left;
    out += " ".repeat(left) + label + " ".repeat(right) + "|";
  }
  const expected = 1 + 2 * rowWidth;
  if (out.length < expected) out += " ".repeat(expected - out.length);
  return out;
}
