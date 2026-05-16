// PSML 0.2/0.3 — RFC ASCII art exporter.
//
// Takes a PSML Packet, normalises it through PSML's expression-aware walker,
// runs the cell-layout in `web/lib/psml/layout.ts`, and prints a canonical
// RFC 791 / 793 style ASCII diagram. Variable-length fields render only
// when the supplied env gives them a concrete bit count.
//
// PSML 0.3 additions:
//   * `viewMode` option ('wire' | 'semantic', default 'wire') threads through
//     to the layout adapter so Encrypted containers can either collapse to a
//     single virtual field (wire) or expand into their plaintext (semantic).
//   * In semantic mode every row that contains plaintext from an Encrypted
//     container is prefixed with a `>>> ` indent marker so the reader can
//     tell decrypted contents from on-the-wire bytes.
//   * Varint Type: when a Field has `type.kind === 'varint'` and the env does
//     not already supply a concrete bit count for it, we seed the worst-case
//     width for the encoding (QUIC: 64 bits / 8 bytes incl. 2-bit prefix;
//     protobuf: 80 bits / 10 bytes; CBOR: 72 bits / 9 bytes), and annotate
//     the rendered name with a ` (varint)` suffix so the diagram makes the
//     variable-length nature obvious.

import { resolveLayout } from "../psml/layout";
import type {
  Container,
  Encrypted,
  Field,
  PacketEnv,
  Packet as PsmlPacket,
  ViewMode,
} from "../psml/types";
import type { Cell } from "../psml/renderer";

type RowCellLike = {
  startBit: number;
  endBit: number;
  isFirst: boolean;
  field: { name: string };
};

export type AsciiOptions = {
  /** Wire vs. semantic view of Encrypted containers (default 'wire'). */
  viewMode?: ViewMode;
};

/**
 * Worst-case wire bit width for an un-seeded varint, by encoding. Keep these
 * conservative — they're the maximum sized form so the rendered cell can
 * advertise the largest a varint could grow to in the absence of runtime
 * data.
 *
 *   * QUIC: 2-bit prefix + 62-bit value = 8 bytes = 64 bits (RFC 9000 §16).
 *   * protobuf: 10 bytes of continuation-bit-prefixed payload = 80 bits.
 *   * CBOR: initial byte + up to 8 data bytes = 9 bytes = 72 bits.
 */
const VARINT_WORST_CASE_BITS: Record<string, number> = {
  quic: 64,
  protobuf: 80,
  cbor: 72,
};

export function toAscii(
  packet: PsmlPacket,
  env?: PacketEnv,
  opts: AsciiOptions = {},
): string {
  // Single-pass collection: gather `id → encoding` for every varint Field
  // reachable through the body's container tree. We then seed worst-case
  // widths into a local env copy for any varints the caller didn't override,
  // so the renderer has a concrete bit count to lay out.
  const localEnv: PacketEnv = new Map(env ?? []);
  const varintEncodings = new Map<string, string>();
  collectVarints(packet.body, varintEncodings);
  for (const [id, encoding] of varintEncodings) {
    if (!localEnv.has(id)) {
      localEnv.set(id, VARINT_WORST_CASE_BITS[encoding]);
    }
  }

  const viewMode: ViewMode = opts.viewMode ?? "wire";
  const layout = resolveLayout(packet, { env: localEnv, viewMode });
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

  // Decorate field names for display. Encrypted-wire-mode fields use a
  // dedicated `~Encrypted Payload~` label so they stand out, and any field
  // emitted from a varint Type gets a trailing `(varint)` marker.
  const displayName = (cell: Cell): string => {
    if (cell.encrypted) return "~Encrypted Payload~";
    if (varintEncodings.has(cell.field.id)) return `${cell.field.name} (varint)`;
    return cell.field.name;
  };

  for (const r of rowIndices) {
    // The `?? []` and `length === 0` guards are defensive; rowIndices is
    // populated from the same Map we read here, so every key always has a
    // non-empty array. Keeping the guards for safety, ignored for coverage.
    /* v8 ignore start */
    const row = (rowsMap.get(r) ?? []).slice().sort((a, b) => a.startBit - b.startBit);
    if (row.length === 0) continue;
    /* v8 ignore stop */
    const expanded: RowCellLike[] = row.map((c) => ({
      startBit: c.startBit,
      endBit: c.endBit,
      isFirst: c.isFirst,
      field: { name: displayName(c) },
    }));
    const last = expanded[expanded.length - 1];
    const rowWidth = last.endBit + 1;
    // Semantic mode: mark every row whose cells come from inside an Encrypted
    // container with a `>>> ` indent. The separator above and below the row
    // gets the same prefix so the run-of-`+ - +` shape stays aligned visually.
    const semanticEncrypted =
      viewMode === "semantic" &&
      row.some((c) => c.encryptedParentId !== undefined);
    const indent = semanticEncrypted ? ">>> " : "";
    lines.push(indent + fieldLine(expanded, rowWidth));
    lines.push(indent + separator(rowWidth));
  }

  return lines.join("\n");
}

/**
 * Walk the container tree and record every varint Field as `id → encoding`.
 * Recurses through every compound primitive: Group children, Repeat element
 * fields, every Switch case (including default), and Encrypted plaintext.
 */
function collectVarints(containers: Container[], out: Map<string, string>): void {
  for (const c of containers) {
    if (!("kind" in c) || c.kind === "field") {
      const f = c as Field;
      if (f.type.kind === "varint") out.set(f.id, f.type.encoding);
      continue;
    }
    switch (c.kind) {
      case "group":
        collectVarints(c.children, out);
        break;
      case "repeat":
        collectVarints(c.element.fields, out);
        break;
      case "switch":
        for (const v of Object.values(c.cases)) collectVarints(v.fields, out);
        if (c.default) collectVarints(c.default.fields, out);
        break;
      case "encrypted":
        collectVarints((c as Encrypted).plaintext.fields, out);
        break;
    }
  }
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
  // Defensive pad-out — cell widths sum to exactly `expected` so this branch
  // is unreachable in normal renders. Ignored for coverage.
  /* v8 ignore start */
  if (out.length < expected) out += " ".repeat(expected - out.length);
  /* v8 ignore stop */
  return out;
}
