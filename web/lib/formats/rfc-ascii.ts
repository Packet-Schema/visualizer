// PSDL 0.2/0.3 — RFC ASCII art exporter.
//
// Takes a PSDL Packet, normalises it through PSDL's expression-aware walker,
// runs the cell-layout in `web/lib/psdl/layout.ts`, and prints a canonical
// RFC 791 / 793 style ASCII diagram. Variable-length fields render only
// when the supplied env gives them a concrete bit count.
//
// PSDL 0.3 additions:
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

import { evalExpr } from "../psdl/expr";
import { resolveLayout } from "../psdl/layout";
import type {
  Container,
  Encrypted,
  Field,
  Optional,
  PacketEnv,
  Packet as PsdlPacket,
  ViewMode,
} from "../psdl/types";
import type { Cell } from "../psdl/renderer";

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
  packet: PsdlPacket,
  env?: PacketEnv,
  opts: AsciiOptions = {},
): string {
  // Single-pass collection: gather `id → encoding` for every varint Field
  // reachable through the body's container tree. We then seed worst-case
  // widths into a local env copy for any varints the caller didn't override,
  // so the renderer has a concrete bit count to lay out.
  const localEnv: PacketEnv = new Map(env ?? []);
  const varintEncodings = new Map<string, string>();
  const berLengthFieldIds = new Set<string>();
  const absentOptionals: Optional[] = [];
  collectPsdl04(
    packet.body,
    varintEncodings,
    berLengthFieldIds,
    absentOptionals,
    localEnv,
  );
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
  // dedicated `~Encrypted Payload~` label so they stand out; varint fields
  // get a `(varint)` marker; PSDL 0.4 berLength fields use a `BER len`
  // label; per-field `byteOrder: 'LE'` appends a `[LE]` suffix.
  const displayName = (cell: Cell): string => {
    if (cell.encrypted) return "~Encrypted Payload~";
    let name: string;
    if (berLengthFieldIds.has(cell.field.id)) {
      name = "BER len";
    } else if (varintEncodings.has(cell.field.id)) {
      name = `${cell.field.name} (varint)`;
    } else {
      name = cell.field.name;
    }
    if (cell.byteOrder === "LE") name += " [LE]";
    return name;
  };

  for (const r of rowIndices) {
    // The `?? []` and `length === 0` guards are defensive; rowIndices is
    // populated from the same Map we read here, so every key always has a
    // non-empty array. Keeping the guards for safety, ignored for coverage.
    /* v8 ignore start */
    const row = (rowsMap.get(r) ?? [])
      .slice()
      .sort((a, b) => a.startBit - b.startBit);
    if (row.length === 0) continue;
    /* v8 ignore stop */
    // Layout collapses Group children into one Cell with `subCells[]` so
    // the modern HybridDiagram can show e.g. flags as a nested block. For
    // ASCII output we want the historical per-bit view, so expand back
    // into one entry per sub-cell when present.
    const expanded: RowCellLike[] = row.flatMap((c) => {
      if (c.subCells && c.subCells.length > 0) {
        return c.subCells.map((sc) => ({
          startBit: sc.startBit,
          endBit: sc.endBit,
          isFirst: sc.isFirst,
          field: { name: sc.subfield.name },
        }));
      }
      return [
        {
          startBit: c.startBit,
          endBit: c.endBit,
          isFirst: c.isFirst,
          field: { name: displayName(c) },
        },
      ];
    });
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

  // PSDL 0.4 — render any Optional whose `when` evaluates falsy as a single
  // `|~ Optional <fieldName> ~|` placeholder row so the reader sees the slot
  // exists in the schema even when it's absent on this wire. The interior is
  // padded to the ruler width so the row aligns with every other field-line
  // (i.e. ends with "|"); a trailing separator keeps the alternating
  // field-line / separator pattern that downstream consumers expect.
  if (absentOptionals.length > 0) {
    const interiorWidth = 2 * packet.rowBits - 1;
    for (const opt of absentOptionals) {
      const inner = opt.container;
      const innerName =
        (!("kind" in inner) || inner.kind === "field"
          ? (inner as Field).name
          : "name" in inner
            ? inner.name
            : undefined) ?? "field";
      const label = `~ (Optional ${innerName}) ~`;
      // Pad to the ruler width when the label fits, otherwise keep the full
      // label intact (the row will be wider than rowBits — readers prefer a
      // truthful label to a truncated one).
      const interior =
        label.length < interiorWidth
          ? label + " ".repeat(interiorWidth - label.length)
          : label;
      lines.push(`|${interior}|`);
      lines.push(separator(packet.rowBits));
    }
  }

  return lines.join("\n");
}

/**
 * Walk the container tree and record:
 *   * every varint Field as `id → encoding` (for worst-case width seeding);
 *   * every berLength Field id (so the renderer can show a `BER len` label);
 *   * every Optional whose `when` evaluates falsy in the supplied env (so the
 *     renderer can emit a placeholder row for the absent slot).
 *
 * Recurses through every compound primitive: Group children, Repeat element
 * fields, every Switch case (including default), Encrypted plaintext, and
 * the inner field of present Optionals.
 */
function collectPsdl04(
  containers: Container[],
  varints: Map<string, string>,
  berIds: Set<string>,
  absent: Optional[],
  env: PacketEnv,
): void {
  for (const c of containers) {
    if (!("kind" in c) || c.kind === "field") {
      const f = c as Field;
      if (f.type.kind === "varint") varints.set(f.id, f.type.encoding);
      if (f.type.kind === "berLength") berIds.add(f.id);
      continue;
    }
    switch (c.kind) {
      case "group":
        collectPsdl04(c.children, varints, berIds, absent, env);
        break;
      case "repeat":
        collectPsdl04(c.element.fields, varints, berIds, absent, env);
        break;
      case "switch":
        for (const v of Object.values(c.cases)) {
          collectPsdl04(v.fields, varints, berIds, absent, env);
        }
        break;
      case "encrypted":
        collectPsdl04(
          (c as Encrypted).plaintext.fields,
          varints,
          berIds,
          absent,
          env,
        );
        break;
      case "bounded":
        // PSDL 0.5 — a Bounded is a transparent wire-scope; descend into its
        // children so any varint / berLength leaf inside still seeds.
        collectPsdl04(c.fields, varints, berIds, absent, env);
        break;
      // PSDL 0.5 — "align" (padding, no leaf), "virtual" (zero-width computed
      // field) and "ref" (resolved transparently by resolveLayout against
      // packet.defs) carry no varint / berLength leaf for this seeding pass, so
      // they need no case and fall through to the switch's implicit no-op.
      case "optional": {
        // Evaluate `when` against the (already seeded) env. Refs that don't
        // resolve are treated as "absent" — the placeholder row is the safer
        // default for a documentation diagram.
        let present = false;
        try {
          present = evalExpr(c.when, env) !== 0;
        } catch {
          present = false;
        }
        if (present) {
          // The inner container lays out normally; recurse so any berLength /
          // varint inside it still seeds correctly.
          const inner = c.container;
          if (!("kind" in inner) || inner.kind === "field") {
            const f = inner as Field;
            if (f.type.kind === "varint") varints.set(f.id, f.type.encoding);
            if (f.type.kind === "berLength") berIds.add(f.id);
          } else {
            collectPsdl04([inner], varints, berIds, absent, env);
          }
        } else {
          absent.push(c);
        }
        break;
      }
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
        cellWidth > 1
          ? label.slice(0, cellWidth - 1) + "."
          : label.slice(0, cellWidth);
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
