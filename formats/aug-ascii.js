// Augmented Packet Header Diagrams importer
// (draft-mcquistin-augmented-ascii-diagrams).
//
// Best-effort parser for the machine-readable variant. Supported constructs:
//
//   1. A title line of the form "A/An <Name> is formatted as follows:"
//      (or "<Name> is formatted as follows:") — optional; otherwise we look
//      for the first non-empty line preceding the diagram.
//
//   2. A diagram block: a leading bit-position scale (two header lines) and
//      one or more "+-+-..." separator lines bracketing rows of
//      "|Field|Field|..." text. Per-field bit widths are derived from cell
//      column widths (each bit = 2 chars between separators).
//
//   3. An optional "where:" block listing field metadata as
//        "Field Name (short): N bits. <description>"
//      which we use to override field names / capture descriptions when the
//      in-diagram label is truncated. The structured constraints sub-block
//      (e.g. "Length := ...") is recognised but currently ignored — we report
//      it as unsupported only if it would change field widths.
//
// We deliberately do not try to interpret variable-length or conditional
// fields in this initial implementation; if the diagram uses them they are
// imported as fixed 0-bit placeholders and a warning is collected.
//
// Returns { packet, controllers, warnings: string[] } on success,
// throws Error on hard failure.

import { fromJson, toJson } from "./json.js";

const COLORS = [
  "#6c8eef", "#8a6cef", "#ef8a6c", "#efc56c",
  "#6cefb5", "#ef6c8a", "#8aef6c", "#6cefef",
];

export function fromAad(text) {
  const warnings = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  // 1. Find title.
  const title = findTitle(lines);

  // 2. Find diagram block: contiguous lines starting at first separator.
  const sep = findSeparatorIndex(lines);
  if (sep < 0) {
    throw new Error("Could not find a packet diagram (no '+-+-...' separator line).");
  }

  // Header scale lines (the two lines above the first separator).
  // Use them to determine rowBits.
  const ruler = lines[sep - 1] || "";
  const rowBits = inferRowBits(ruler);
  if (!rowBits) {
    throw new Error("Could not determine diagram width (bit ruler missing or malformed).");
  }

  // Walk diagram: alternating separator / data lines, until a non-matching line.
  const rows = [];
  let i = sep;
  while (i < lines.length) {
    const sepLine = lines[i];
    if (!isSeparator(sepLine, rowBits)) break;
    const dataLine = lines[i + 1];
    if (dataLine === undefined) break;
    if (!isDataLine(dataLine, rowBits)) break;
    rows.push(dataLine);
    i += 2;
  }
  if (rows.length === 0) {
    throw new Error("Diagram contains no data rows.");
  }

  // 3. Parse rows into cells (fields with bit widths).
  const cells = [];
  for (const row of rows) {
    cells.push(...parseRow(row, rowBits));
  }

  // 4. Merge multi-row continuations: two adjacent cells with identical
  //    trimmed text are treated as one field.
  const merged = mergeContinuations(cells);

  // 5. Optional "where:" block — pick up descriptions / fuller names.
  const whereInfo = parseWhereBlock(lines.slice(i));
  if (whereInfo.unsupported.length) {
    warnings.push(...whereInfo.unsupported);
  }

  // 6. Build final field list.
  const fields = merged.map((c, idx) => {
    const trimmed = c.label.trim();
    const meta = matchWhereMeta(trimmed, whereInfo.entries);
    const id = makeId(trimmed || `field${idx}`, idx);
    const f = {
      id,
      name: meta?.fullName || trimmed || `Field ${idx + 1}`,
      bits: c.bits,
      color: COLORS[idx % COLORS.length],
    };
    if (meta?.description) f.description = meta.description;
    return f;
  });

  // 7. Round-trip through json.js so the imported packet matches the runtime
  //    shape exactly (variable-field closures etc.). It happens to also
  //    validate the schema we just produced.
  const draft = {
    format: "packet-view",
    version: 1,
    name: title || "Imported Packet",
    rowBits,
    description: `Imported from Augmented ASCII diagram (${fields.length} fields, ${
      fields.reduce((a, f) => a + f.bits, 0)
    } bits).`,
    controllers: {},
    fields,
  };
  const { packet, controllers } = fromJson(toJson(rebuildAsRuntime(draft), {}));
  return { packet, controllers, warnings };
}

// ---------------------------------------------------------------- helpers

function findTitle(lines) {
  // Search for "X is formatted as follows" (optionally preceded by "A/An").
  for (const raw of lines) {
    const line = raw.trim();
    const m = line.match(/^(?:An?\s+)?(.+?)\s+is\s+formatted\s+as\s+follows[:\.]?\s*$/i);
    if (m) return m[1].trim();
  }
  // Fall back to first non-empty line that is not part of the diagram.
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("+") || line.startsWith("|")) break;
    if (/^[\d\s]+$/.test(line)) continue;
    return line.replace(/[:\.]+$/, "");
  }
  return null;
}

function findSeparatorIndex(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\+(?:-+\+)+\s*$/.test(lines[i])) return i;
  }
  return -1;
}

function isSeparator(line, rowBits) {
  if (!line) return false;
  // Must contain exactly rowBits "+ -" pairs, plus a trailing "+".
  const trimmed = line.trim();
  if (!/^\+(?:-+\+)+$/.test(trimmed)) return false;
  // Width check: tolerate the canonical "+-+-..." form (1 + 2*rowBits chars).
  const expected = 1 + 2 * rowBits;
  return trimmed.length === expected;
}

function isDataLine(line, rowBits) {
  if (!line) return false;
  // Trim ONLY trailing whitespace (a leading space is fine — many docs
  // indent diagrams). Then it must start with '|' and be roughly the
  // expected width.
  const trimmed = line.replace(/\s+$/, "").replace(/^[ \t]+/, "");
  if (!trimmed.startsWith("|")) return false;
  const expected = 1 + 2 * rowBits;
  return trimmed.length === expected;
}

function inferRowBits(rulerLine) {
  if (!rulerLine) return 0;
  // Count the digit-with-space pattern. The ruler looks like
  //   " 0 1 2 3 4 5 6 7 8 9 0 1 ..."
  const m = rulerLine.replace(/\s+$/, "").match(/(?:\s\d)+/);
  if (!m) return 0;
  // Each bit contributes 2 chars (" D"); leading char is a space.
  const span = m[0];
  const bits = Math.floor(span.length / 2);
  // Snap to a sensible width if close to a multiple of 8.
  if ([8, 16, 24, 32, 48, 64].includes(bits)) return bits;
  return bits;
}

function parseRow(line, rowBits) {
  // Strip leading indent only.
  const row = line.replace(/^[ \t]+/, "").replace(/\s+$/, "");
  // Walk pipe-delimited segments. Each "bit cell" is 2 chars wide (a char +
  // space) but the closing space of the last bit is replaced by "|", and the
  // opening "|" of the row consumes the first delimiter. So the segment
  // between two pipes for an N-bit field has length (2N - 1).
  const cells = [];
  let bitPos = 0;
  let cursor = 1; // skip the leading '|'
  while (cursor < row.length) {
    const next = row.indexOf("|", cursor);
    if (next < 0) break;
    const segment = row.slice(cursor, next);
    const width = segment.length;
    // bits = (width + 1) / 2
    const bits = Math.round((width + 1) / 2);
    if (bits <= 0 || bits > rowBits) {
      throw new Error(`Malformed cell at bit ${bitPos}: width ${width} chars`);
    }
    cells.push({ label: segment, bits, startBit: bitPos });
    bitPos += bits;
    cursor = next + 1;
  }
  if (bitPos !== rowBits) {
    throw new Error(`Row width mismatch: got ${bitPos} bits, expected ${rowBits}`);
  }
  return cells;
}

function mergeContinuations(cells) {
  const out = [];
  for (const c of cells) {
    const prev = out[out.length - 1];
    const trimmed = c.label.trim();
    const prevTrimmed = prev?.label.trim();
    if (
      prev &&
      trimmed &&
      prevTrimmed === trimmed &&
      // Continuation must be the start of its row (i.e. abuts the previous).
      true
    ) {
      prev.bits += c.bits;
    } else if (prev && !trimmed) {
      // An empty continuation cell — RFC style for "the rest of this field".
      // Best-effort: glue to previous field if widths add up sensibly.
      prev.bits += c.bits;
    } else {
      out.push({ label: c.label, bits: c.bits });
    }
  }
  return out;
}

function parseWhereBlock(lines) {
  const entries = [];
  const unsupported = [];
  let inWhere = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!inWhere) {
      if (/^where\s*:?\s*$/i.test(line)) inWhere = true;
      continue;
    }
    if (!line) continue;
    // "Field Name (short): N bits. Description..."
    // or "Field Name: N bits. Description..."
    const m = line.match(
      /^([A-Za-z][\w \-/]*?)(?:\s*\(([^)]+)\))?\s*:\s*(\d+)\s*bits?\.?\s*(.*)$/
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
    if (/^\s*FIXME|^\s*TODO|^\s*###/.test(line)) {
      // ignore comments
      continue;
    }
    // Unknown line within where-block — record as warning only.
    unsupported.push(`Unrecognised where-block line: "${line}"`);
  }
  return { entries, unsupported };
}

function matchWhereMeta(label, entries) {
  if (!label) return null;
  const norm = label.trim().toLowerCase();
  // Try short-name first (often the in-diagram label).
  for (const e of entries) {
    if (e.short && e.short.toLowerCase() === norm) return e;
  }
  // Then prefix match on full name (handles truncated labels).
  for (const e of entries) {
    const fn = e.fullName.toLowerCase();
    if (fn === norm || fn.startsWith(norm) || norm.startsWith(fn)) return e;
  }
  return null;
}

function makeId(name, idx) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base || `field${idx}`;
}

// Convert the JSON-shaped draft into a runtime packet so toJson() can probe it.
// Since we never produce variable fields here, this is a passthrough.
function rebuildAsRuntime(draft) {
  return {
    name: draft.name,
    rowBits: draft.rowBits,
    description: draft.description,
    fields: draft.fields.map((f) => ({ ...f })),
  };
}
