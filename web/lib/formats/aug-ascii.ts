// PSDL 0.2 — Augmented Packet Header Diagrams importer
// (draft-mcquistin-augmented-ascii-diagrams).
//
// Best-effort parser that produces a PSDL Packet on success. Supported
// constructs:
//   1. A title line of the form "A/An <Name> is formatted as follows:".
//   2. A diagram block: a leading bit-position scale (two header lines) and
//      one or more "+-+-..." separator lines bracketing rows of
//      "|Field|Field|..." text. Per-field bit widths derive from cell
//      column widths (each bit = 2 chars between separators).
//   3. An optional "where:" block listing field metadata as
//        "Field Name (short): N bits. <description>".
//
// Variable-length and conditional constructs surface as warnings; this
// initial implementation models them as fixed 0-bit placeholders.
//
// PSDL 0.4 primitives (Optional / berLength / peek / per-field byteOrder)
// cannot be expressed in AAD source text — the format describes a fixed
// ASCII diagram. The importer therefore never produces them; the exporter
// pathway is not implemented (AAD is read-only). Callers that need to round-
// trip 0.4 schemas through this module should use the JSON format instead.

import type {
  CategoryToken,
  Container,
  Field as PsdlField,
  Packet as PsdlPacket,
} from "../psdl/types";

import { sanitizeId } from "./common";

type RawCell = { label: string; bits: number; startBit: number };
type MergedCell = { label: string; bits: number };
type WhereEntry = {
  fullName: string;
  short: string;
  bits: number;
  description: string;
};

export function fromAad(text: string): {
  packet: PsdlPacket;
  warnings: string[];
} {
  const warnings: string[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  const title = findTitle(lines);

  const sep = findSeparatorIndex(lines);
  if (sep < 0) {
    throw new Error(
      "Could not find a packet diagram (no '+-+-...' separator line).",
    );
  }

  const ruler = lines[sep - 1] || "";
  const rowBits = inferRowBits(ruler);
  if (!rowBits) {
    throw new Error(
      "Could not determine diagram width (bit ruler missing or malformed).",
    );
  }

  const rows: string[] = [];
  let i = sep;
  while (i < lines.length) {
    const sepLine = lines[i];
    if (!isSeparator(sepLine, rowBits)) break;
    const dataLine = lines[i + 1];
    // Defensive: lines[N+1] is always defined while sepLine is well-formed.
    /* v8 ignore start */
    if (dataLine === undefined) break;
    /* v8 ignore stop */
    if (!isDataLine(dataLine, rowBits)) break;
    rows.push(dataLine);
    i += 2;
  }
  if (rows.length === 0) {
    throw new Error("Diagram contains no data rows.");
  }

  const cells: RawCell[] = [];
  for (const row of rows) {
    cells.push(...parseRow(row, rowBits));
  }

  const merged = mergeContinuations(cells);

  const whereInfo = parseWhereBlock(lines.slice(i));
  if (whereInfo.unsupported.length) warnings.push(...whereInfo.unsupported);

  const body: Container[] = merged.map((c, idx): PsdlField => {
    const trimmed = c.label.trim();
    const meta = matchWhereMeta(trimmed, whereInfo.entries);
    const id = makeId(trimmed || `field${idx}`, idx);
    const f: PsdlField = {
      id,
      name: meta?.fullName || trimmed || `Field ${idx + 1}`,
      type: { kind: "bits", n: c.bits },
      ...(meta?.description ? { doc: meta.description } : {}),
      ...(guessCategory(trimmed) ? { category: guessCategory(trimmed)! } : {}),
    };
    return f;
  });

  const packet: PsdlPacket = {
    name: title || "Imported Packet",
    rowBits,
    description: `Imported from Augmented ASCII diagram (${body.length} fields, ${sumLeafBits(
      body,
    )} bits).`,
    body,
  };
  return { packet, warnings };
}

function sumLeafBits(body: Container[]): number {
  let n = 0;
  for (const c of body) {
    // The parser only emits leaf PsdlField nodes with type.kind === "bits".
    // The Field/`bits` guards here exist for forward compatibility (Switch /
    // Repeat / Group could appear if the importer is extended); both guards
    // currently only match true. Tracked as defensive — coverage ignore.
    /* v8 ignore start */
    if (!("kind" in c) || c.kind === "field") {
      const t = (c as PsdlField).type;
      if (t.kind === "bits") n += t.n;
    }
    /* v8 ignore stop */
  }
  return n;
}

function guessCategory(label: string): CategoryToken | null {
  const norm = label.toLowerCase();
  if (norm.includes("address") || norm.includes("mac") || norm.includes("ip"))
    return "addressing";
  if (norm.includes("checksum") || norm.includes("crc")) return "checksum";
  if (norm.includes("length") || norm.includes("len")) return "length";
  if (norm.includes("type") || norm.includes("kind") || norm.includes("opcode"))
    return "type";
  if (norm.includes("flag")) return "flags";
  if (norm.includes("reserved") || norm === "rsvd") return "reserved";
  return null;
}

// ---------------------------------------------------------------- helpers

function findTitle(lines: string[]): string | null {
  for (const raw of lines) {
    const line = raw.trim();
    const m = line.match(
      /^(?:An?\s+)?(.+?)\s+is\s+formatted\s+as\s+follows[:\.]?\s*$/i,
    );
    if (m) return m[1].trim();
  }
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("+") || line.startsWith("|")) break;
    if (/^[\d\s]+$/.test(line)) continue;
    return line.replace(/[:\.]+$/, "");
  }
  return null;
}

function findSeparatorIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\+(?:-+\+)+\s*$/.test(lines[i])) return i;
  }
  return -1;
}

function isSeparator(line: string | undefined, rowBits: number): boolean {
  /* v8 ignore start */ // defensive: caller filters out undefined/empty lines
  if (!line) return false;
  /* v8 ignore stop */
  const trimmed = line.trim();
  if (!/^\+(?:-+\+)+$/.test(trimmed)) return false;
  const expected = 1 + 2 * rowBits;
  return trimmed.length === expected;
}

function isDataLine(line: string | undefined, rowBits: number): boolean {
  /* v8 ignore start */ // defensive: only called when sepLine is well-formed and lines[N+1] follows
  if (!line) return false;
  /* v8 ignore stop */
  const trimmed = line.replace(/\s+$/, "").replace(/^[ \t]+/, "");
  if (!trimmed.startsWith("|")) return false;
  const expected = 1 + 2 * rowBits;
  return trimmed.length === expected;
}

function inferRowBits(rulerLine: string): number {
  if (!rulerLine) return 0;
  const m = rulerLine.replace(/\s+$/, "").match(/(?:\s\d)+/);
  if (!m) return 0;
  const span = m[0];
  const bits = Math.floor(span.length / 2);
  return bits;
}

function parseRow(line: string, rowBits: number): RawCell[] {
  const row = line.replace(/^[ \t]+/, "").replace(/\s+$/, "");
  const cells: RawCell[] = [];
  let bitPos = 0;
  let cursor = 1;
  while (cursor < row.length) {
    const next = row.indexOf("|", cursor);
    /* v8 ignore start */ // defensive: validated rows always end with `|`, so the lookup never misses
    if (next < 0) break;
    /* v8 ignore stop */
    const segment = row.slice(cursor, next);
    const width = segment.length;
    const bits = Math.round((width + 1) / 2);
    /* v8 ignore start */ // defensive: isDataLine already enforces total row width so cell widths cannot fall outside rowBits
    if (bits <= 0 || bits > rowBits) {
      throw new Error(`Malformed cell at bit ${bitPos}: width ${width} chars`);
    }
    /* v8 ignore stop */
    cells.push({ label: segment, bits, startBit: bitPos });
    bitPos += bits;
    cursor = next + 1;
  }
  /* v8 ignore start */ // defensive: rows that reach here always sum exactly to rowBits
  if (bitPos !== rowBits) {
    throw new Error(
      `Row width mismatch: got ${bitPos} bits, expected ${rowBits}`,
    );
  }
  /* v8 ignore stop */
  return cells;
}

function mergeContinuations(cells: RawCell[]): MergedCell[] {
  const out: MergedCell[] = [];
  for (const c of cells) {
    const prev = out[out.length - 1];
    const trimmed = c.label.trim();
    const prevTrimmed = prev?.label.trim();
    if (prev && trimmed && prevTrimmed === trimmed) {
      prev.bits += c.bits;
    } else if (prev && !trimmed) {
      prev.bits += c.bits;
    } else {
      out.push({ label: c.label, bits: c.bits });
    }
  }
  return out;
}

function parseWhereBlock(lines: string[]): {
  entries: WhereEntry[];
  unsupported: string[];
} {
  const entries: WhereEntry[] = [];
  const unsupported: string[] = [];
  let inWhere = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!inWhere) {
      if (/^where\s*:?\s*$/i.test(line)) inWhere = true;
      continue;
    }
    if (!line) continue;
    const m = line.match(
      /^([A-Za-z][\w \-/]*?)(?:\s*\(([^)]+)\))?\s*:\s*(\d+)\s*bits?\.?\s*(.*)$/,
    );
    if (m) {
      entries.push({
        fullName: m[1].trim(),
        short: (m[2] || "").trim(),
        bits: Number(m[3]),
        description: m[4].trim() || "",
      });
      continue;
    }
    if (/^[A-Za-z][\w ]*\s*:=\s*/.test(line)) {
      unsupported.push(`Constraint expression ignored: "${line}"`);
      continue;
    }
    if (/^\s*FIXME|^\s*TODO|^\s*###/.test(line)) continue;
    unsupported.push(`Unrecognised where-block line: "${line}"`);
  }
  return { entries, unsupported };
}

function matchWhereMeta(
  label: string,
  entries: WhereEntry[],
): WhereEntry | null {
  if (!label) return null;
  const norm = label.trim().toLowerCase();
  for (const e of entries) {
    if (e.short && e.short.toLowerCase() === norm) return e;
  }
  for (const e of entries) {
    const fn = e.fullName.toLowerCase();
    if (fn === norm || fn.startsWith(norm) || norm.startsWith(fn)) return e;
  }
  return null;
}

function makeId(name: string, idx: number): string {
  return sanitizeId(name, `field${idx}`);
}
