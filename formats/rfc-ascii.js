// RFC ASCII art exporter.
//
// Renders a fixed-only header diagram in the canonical RFC 791 / 793 style:
//
//    0                   1                   2                   3
//    0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//   |Version|  IHL  |Type of Service|          Total Length         |
//   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//
// Variable-length fields are rendered only when the active controller state
// gives them a concrete (non-zero) bit count; otherwise they are skipped.
// (The caller can still force a render by passing controllers that select
// the desired length.)

import { resolvePacket } from "../packets.js";

export function toAscii(packet, controllers = {}) {
  const layout = resolvePacket(packet, controllers);
  const rowBits = packet.rowBits;

  // Group cells by row. TLV-expanded cells (those whose field carries a
  // tlvParent) get their parent label replaced by the per-sub-field labels so
  // each row shows Kind/Length/Value rather than the outer block name.
  const rowsMap = new Map();
  for (const cell of layout.cells) {
    if (!rowsMap.has(cell.row)) rowsMap.set(cell.row, []);
    rowsMap.get(cell.row).push(cell);
  }
  const rowIndices = [...rowsMap.keys()].sort((a, b) => a - b);

  const lines = [];
  lines.push(headerLine1(rowBits));
  lines.push(headerLine2(rowBits));
  lines.push(separator(rowBits));

  for (const r of rowIndices) {
    const row = rowsMap.get(r).sort((a, b) => a.startBit - b.startBit);
    // Expand TLV / chain cells with subCells into per-subfield segments so the
    // ASCII diagram shows the inner Kind/Length/Value fields directly rather
    // than the enclosing block name.
    const expanded = expandTlvCells(row);
    const last = expanded[expanded.length - 1];
    const rowWidth = last.endBit + 1;
    lines.push(fieldLine(expanded, rowWidth));
    lines.push(separator(rowWidth));
  }

  return lines.join("\n");
}

// If a cell came from a TLV-expanded (or chain-expanded) virtual field, drop
// the parent box and emit one slim cell per sub-cell instead. Non-TLV cells
// pass through unchanged.
function expandTlvCells(row) {
  const out = [];
  for (const cell of row) {
    const virtualParent = cell.field
      && (cell.field.tlvParent || cell.field.chainBlock);
    if (virtualParent && cell.subCells && cell.subCells.length > 0) {
      const subs = cell.subCells.slice().sort((a, b) => a.startBit - b.startBit);
      for (const sub of subs) {
        out.push({
          startBit: sub.startBit,
          endBit: sub.endBit,
          isFirst: sub.isFirst,
          field: { name: sub.subfield.name },
        });
      }
    } else {
      out.push(cell);
    }
  }
  return out;
}

// Top scale: " 0                   1                   2                   3"
// Each digit aligned to start of its 8-bit byte: bit 0, 8, 16, 24
// In the canonical RFC style, the top digits sit above the units digit of the
// per-bit ruler (positions 0, 8, 16, 24 -> column 1, 17, 33, 49).
function headerLine1(rowBits) {
  // Each bit takes 2 columns ("X "), starting at column 1.
  // Row width = 1 + rowBits * 2.
  const width = 1 + rowBits * 2;
  const chars = new Array(width).fill(" ");
  const groups = Math.floor(rowBits / 8);
  for (let g = 0; g < groups; g++) {
    const col = 1 + g * 16; // bit 0, 8, 16, 24...
    const num = String(g);
    for (let i = 0; i < num.length; i++) chars[col + i] = num[i];
  }
  return chars.join("").replace(/\s+$/, "");
}

function headerLine2(rowBits) {
  // " 0 1 2 3 4 5 6 7 8 9 0 1 ..."
  const parts = [];
  for (let b = 0; b < rowBits; b++) {
    parts.push(String(b % 10));
  }
  return " " + parts.join(" ");
}

function separator(rowBits) {
  return "+" + "-+".repeat(rowBits);
}

function fieldLine(cells, rowWidth) {
  // Build the row: each bit occupies 2 visual columns ("X "), but cells
  // are delimited by "|" so the column model per row is:
  //   | <bit-region> | <bit-region> | ...
  // A bit-region of N bits has visual width (N * 2 - 1).
  // Total width (including bordering pipes): 1 + sum(N_i*2 - 1) + (#cells)*1 = 1 + 2*rowBits.
  let out = "|";
  for (const c of cells) {
    const bits = c.endBit - c.startBit + 1;
    const cellWidth = bits * 2 - 1; // chars between the surrounding pipes
    let label;
    if (c.isFirst) {
      label = c.field.name;
    } else {
      label = ""; // continuation segments are blank in RFC style
    }
    if (label.length > cellWidth) {
      // Truncate to fit
      label = cellWidth > 1 ? label.slice(0, cellWidth - 1) + "." : label.slice(0, cellWidth);
    }
    // Center-pad
    const pad = cellWidth - label.length;
    const left = Math.floor(pad / 2);
    const right = pad - left;
    out += " ".repeat(left) + label + " ".repeat(right) + "|";
  }
  // If row underfilled (shouldn't happen for valid packets, but guard):
  const expected = 1 + 2 * rowWidth;
  if (out.length < expected) out += " ".repeat(expected - out.length);
  return out;
}
