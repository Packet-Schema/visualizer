// Worksheet exporter.
//
// Produces a self-contained printable HTML document for classroom use:
//   - inline SVG packet diagram with field labels blanked out (or shown)
//   - header bar with packet name plus blank Name / Date lines
//   - numbered table below: # | bits / offset | answer (blank or filled)
//   - print-optimised CSS (@page { margin: 1cm }, .no-print to hide controls)
//   - in-page "Show answers" toggle that sets ?answers=1 on the URL and back
//
// Usage:
//   import { toWorksheet } from "./formats/worksheet.js";
//   const html = toWorksheet(packet, controllers, { withAnswers: false });
//   const blob = new Blob([html], { type: "text/html" });
//   window.open(URL.createObjectURL(blob), "_blank");
//
// The function is designed to work in a Node environment too: it uses no
// DOM APIs and produces strings only. Tests can call it directly.

import { resolvePacket } from "../packets.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// Layout constants (mirrors renderer.js but tuned for print).
const BIT_WIDTH = 22;
const ROW_HEIGHT = 56;
const RULER_HEIGHT = 22;
const PADDING_X = 12;
const PADDING_TOP = 8;
const PADDING_BOTTOM = 12;

const BLANK = "______";

export function toWorksheet(packet, controllers = {}, opts = {}) {
  const withAnswers = !!opts.withAnswers;
  const layout = resolvePacket(packet, controllers);

  const svg = renderSvgString(packet, layout, withAnswers);
  const rows = buildTableRows(packet, layout);
  const tableHtml = renderTable(rows, withAnswers);

  const safeName = escapeHtml(packet.name);
  const description = packet.description ? escapeHtml(packet.description) : "";

  const toggleLabel = withAnswers ? "Hide answers" : "Show answers";
  const toggleHref = withAnswers ? "?" : "?answers=1";
  const modeBadge = withAnswers
    ? `<span class="badge badge-answers">Answer key</span>`
    : `<span class="badge badge-blank">Worksheet</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeName} — Worksheet</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #111; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                 "Helvetica Neue", Arial, sans-serif;
    line-height: 1.45;
    padding: 24px;
    max-width: 960px;
    margin: 0 auto;
  }
  header.sheet-header {
    border-bottom: 2px solid #222;
    padding-bottom: 12px;
    margin-bottom: 16px;
    display: flex;
    flex-wrap: wrap;
    gap: 12px 24px;
    align-items: flex-end;
    justify-content: space-between;
  }
  .sheet-title { margin: 0; font-size: 22px; }
  .sheet-sub { font-size: 12px; color: #555; margin: 2px 0 0 0; }
  .name-date {
    display: flex;
    gap: 24px;
    font-size: 13px;
  }
  .name-date .field {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
  }
  .name-date .line {
    display: inline-block;
    width: 180px;
    border-bottom: 1px solid #333;
    height: 1em;
  }
  .name-date .line.short { width: 110px; }
  .badge {
    display: inline-block;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    padding: 2px 8px;
    border-radius: 4px;
    border: 1px solid #333;
  }
  .badge-blank { background: #fff; color: #222; }
  .badge-answers { background: #222; color: #fff; }
  .controls {
    margin: 0 0 16px 0;
    padding: 8px 12px;
    background: #f4f5f9;
    border: 1px solid #d6dae5;
    border-radius: 6px;
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .controls a {
    color: #1a3aa0;
    font-weight: 600;
  }
  .description {
    font-size: 12px;
    color: #444;
    margin: 0 0 12px 0;
  }
  .diagram-wrap {
    overflow-x: auto;
    margin: 0 0 18px 0;
  }
  svg.worksheet-svg {
    display: block;
    margin: 0 auto;
    max-width: 100%;
    height: auto;
  }
  table.fields {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    margin-top: 8px;
  }
  table.fields th, table.fields td {
    border: 1px solid #555;
    padding: 6px 8px;
    text-align: left;
    vertical-align: top;
  }
  table.fields th {
    background: #eef0f6;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  table.fields td.num {
    width: 36px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  table.fields td.size {
    width: 180px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    white-space: nowrap;
  }
  table.fields td.answer {
    min-height: 22px;
  }
  table.fields td.answer.blank {
    background: repeating-linear-gradient(
      to bottom,
      #fff 0,
      #fff 21px,
      #bbb 21px,
      #bbb 22px
    );
    height: 44px;
  }
  footer.sheet-footer {
    margin-top: 24px;
    padding-top: 8px;
    border-top: 1px solid #ddd;
    color: #777;
    font-size: 11px;
    display: flex;
    justify-content: space-between;
  }
  @page { margin: 1cm; }
  @media print {
    body { padding: 0; max-width: none; }
    .no-print { display: none !important; }
    .diagram-wrap { overflow: visible; }
    a { color: inherit; text-decoration: none; }
  }
</style>
</head>
<body>
<header class="sheet-header">
  <div>
    <h1 class="sheet-title">${safeName} ${modeBadge}</h1>
    <p class="sheet-sub">Packet View — printable worksheet</p>
  </div>
  <div class="name-date">
    <span class="field">Name <span class="line"></span></span>
    <span class="field">Date <span class="line short"></span></span>
  </div>
</header>

<div class="controls no-print">
  <a id="toggle-answers" href="${toggleHref}">${toggleLabel}</a>
  <a href="javascript:window.print()">Print</a>
  <span style="color:#666">Tip: append <code>?answers=1</code> for an answer key.</span>
</div>

${description ? `<p class="description">${description}</p>` : ""}

<div class="diagram-wrap">
${svg}
</div>

${tableHtml}

<footer class="sheet-footer">
  <span>Generated by Packet View</span>
  <span>${withAnswers ? "Answer key" : "Student copy"}</span>
</footer>

<script>
  // Honour ?answers=1 even if a fresh blob URL was opened: the URL parameter
  // can change which copy renders next time the user reloads.
  (function () {
    var params = new URLSearchParams(window.location.search);
    var hasAnswers = params.get("answers") === "1";
    // The static HTML was already rendered for the appropriate mode by the
    // generator. If the URL disagrees (e.g. the user toggled), the link below
    // navigates to ?answers=1 / ?, which causes the parent to regenerate via
    // a hashchange listener (no-op here for blob: URLs). For blob URLs the
    // toggle is informational; the toolbar regenerates the worksheet.
    var toggle = document.getElementById("toggle-answers");
    if (toggle) {
      toggle.addEventListener("click", function (e) {
        // For non-blob hosting, let the link navigate normally.
        // For blob: URLs (which can't change query params), open a new copy.
        if (window.location.protocol === "blob:") {
          e.preventDefault();
          window.opener && window.opener.postMessage(
            { type: "packet-view-worksheet-toggle", answers: !hasAnswers },
            "*"
          );
        }
      });
    }
  })();
</script>
</body>
</html>`;
}

// ---------- helpers ----------

function buildTableRows(packet, layout) {
  // One logical row per field, in the order they appear in packet.fields.
  // Skip variable-length fields whose resolved bit-count is zero, to match
  // what the diagram actually shows.
  const cellsByFieldId = new Map();
  for (const cell of layout.cells) {
    if (!cellsByFieldId.has(cell.field.id)) cellsByFieldId.set(cell.field.id, []);
    cellsByFieldId.get(cell.field.id).push(cell);
  }

  const rows = [];
  let bitOffset = 0;
  let n = 1;
  for (const field of packet.fields) {
    const cells = cellsByFieldId.get(field.id);
    if (!cells || cells.length === 0) continue;
    const bits = cells.reduce(
      (acc, c) => acc + (c.endBit - c.startBit + 1),
      0
    );
    const offset = bitOffset;
    const offsetBytes = offset / 8;
    const offsetStr = Number.isInteger(offsetBytes)
      ? `byte ${offsetBytes}`
      : `bit ${offset}`;
    const sizeStr = bits % 8 === 0
      ? `${bits} bits (${bits / 8} B)`
      : `${bits} bits`;
    rows.push({
      n: n++,
      name: field.name,
      bits,
      offset,
      sizeStr: `${sizeStr} @ ${offsetStr}`,
      description: field.description || "",
    });
    bitOffset += bits;
  }
  return rows;
}

function renderTable(rows, withAnswers) {
  const body = rows.map((r) => {
    const answer = withAnswers
      ? `<td class="answer">${escapeHtml(r.name)}</td>`
      : `<td class="answer blank"></td>`;
    return `  <tr>
    <td class="num">${r.n}</td>
    <td class="size">${escapeHtml(r.sizeStr)}</td>
    ${answer}
  </tr>`;
  }).join("\n");

  return `<table class="fields">
  <thead>
    <tr>
      <th>#</th>
      <th>Size &amp; offset</th>
      <th>${withAnswers ? "Field name (answer key)" : "Field name"}</th>
    </tr>
  </thead>
  <tbody>
${body}
  </tbody>
</table>`;
}

// Build the SVG as a string. Mirrors renderer.js but emits text instead of
// DOM nodes so this works in Node and in the browser without `document`.
function renderSvgString(packet, layout, withAnswers) {
  const rowBits = packet.rowBits;
  const rows = layout.cells.length
    ? Math.max(...layout.cells.map((c) => c.row)) + 1
    : 0;
  const innerWidth = rowBits * BIT_WIDTH;
  const width = innerWidth + PADDING_X * 2;
  const height = PADDING_TOP + RULER_HEIGHT + rows * ROW_HEIGHT + PADDING_BOTTOM;

  const parts = [];
  parts.push(`<svg xmlns="${SVG_NS}" class="worksheet-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeAttr(packet.name)} diagram">`);

  // Defs (variable-length stripes)
  parts.push(`<defs>
    <pattern id="ws-variable-stripes" patternUnits="userSpaceOnUse"
             width="8" height="8" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="8" stroke="#888" stroke-width="1"/>
    </pattern>
  </defs>`);

  // Bit ruler
  const rulerY = PADDING_TOP;
  parts.push(`<g transform="translate(${PADDING_X}, ${rulerY})">`);
  for (let b = 0; b <= rowBits; b++) {
    const x = b * BIT_WIDTH;
    const major = b % 8 === 0;
    parts.push(`<line x1="${x}" x2="${x}" y1="${RULER_HEIGHT - (major ? 10 : 6)}" y2="${RULER_HEIGHT}" stroke="#666" stroke-width="${major ? 1.2 : 0.6}" />`);
    if (b < rowBits && b % 4 === 0) {
      parts.push(`<text x="${x + BIT_WIDTH * 2}" y="${RULER_HEIGHT - 12}" text-anchor="middle" font-size="10" fill="#555" font-family="ui-monospace, monospace">${b}</text>`);
    }
  }
  parts.push(`<text x="${rowBits * BIT_WIDTH}" y="${RULER_HEIGHT - 12}" text-anchor="end" font-size="10" fill="#555" font-family="ui-monospace, monospace">${rowBits - 1}</text>`);
  parts.push(`</g>`);

  // Row bands and grid
  const gridY0 = PADDING_TOP + RULER_HEIGHT;
  for (let r = 0; r < rows; r++) {
    const y = gridY0 + r * ROW_HEIGHT;
    const bandFill = r % 2 === 0 ? "#fafbff" : "#ffffff";
    parts.push(`<rect x="${PADDING_X}" y="${y}" width="${innerWidth}" height="${ROW_HEIGHT}" fill="${bandFill}" />`);
    for (let b = 0; b <= rowBits; b++) {
      const x = PADDING_X + b * BIT_WIDTH;
      const major = b % 8 === 0;
      parts.push(`<line x1="${x}" x2="${x}" y1="${y}" y2="${y + ROW_HEIGHT}" stroke="${major ? "#999" : "#ddd"}" stroke-width="1" />`);
    }
  }

  // Field cells
  for (const cell of layout.cells) {
    const x = PADDING_X + cell.startBit * BIT_WIDTH;
    const y = gridY0 + cell.row * ROW_HEIGHT;
    const w = (cell.endBit - cell.startBit + 1) * BIT_WIDTH;
    const h = ROW_HEIGHT;

    // Print-friendly: use white fills with strokes so blanked labels are
    // legible after photocopying. (Color is unnecessary for a worksheet.)
    parts.push(`<rect x="${x + 1}" y="${y + 4}" width="${w - 2}" height="${h - 8}" rx="6" ry="6" fill="#fff" stroke="#333" stroke-width="1" />`);
    if (cell.field.variable) {
      parts.push(`<rect x="${x + 1}" y="${y + 4}" width="${w - 2}" height="${h - 8}" rx="6" ry="6" fill="url(#ws-variable-stripes)" />`);
    }

    const hasSubs = cell.subCells && cell.subCells.length > 0;

    if (cell.isFirst) {
      const labelText = withAnswers ? cell.field.name : BLANK;
      const labelY = hasSubs ? y + h * 0.32 : y + h / 2 - 2;
      const subY = hasSubs ? y + h * 0.32 + 12 : y + h / 2 + 12;
      parts.push(`<text x="${x + w / 2}" y="${labelY}" text-anchor="middle" font-size="12" font-weight="600" fill="#111">${escapeHtml(truncateToFit(labelText, w - 10))}</text>`);
      const sizeLabel = formatSizeLabel(cell.bitsTotal, cell.field);
      parts.push(`<text x="${x + w / 2}" y="${subY}" text-anchor="middle" font-size="10" fill="#555" font-family="ui-monospace, monospace">${escapeHtml(sizeLabel)}</text>`);
    } else {
      const cont = withAnswers
        ? `… ${cell.field.name} (cont.)`
        : `… ${BLANK} (cont.)`;
      parts.push(`<text x="${x + w / 2}" y="${y + h / 2 + 3}" text-anchor="middle" font-size="10" font-style="italic" fill="#555">${escapeHtml(truncateToFit(cont, w - 10))}</text>`);
    }

    if (hasSubs) {
      for (const sub of cell.subCells) {
        const sx = PADDING_X + sub.startBit * BIT_WIDTH;
        const sw = (sub.endBit - sub.startBit + 1) * BIT_WIDTH;
        const subTop = y + h * 0.55;
        const subH = h * 0.32;
        parts.push(`<rect x="${sx + 1}" y="${subTop}" width="${sw - 2}" height="${subH}" rx="3" ry="3" fill="#fff" stroke="#445" stroke-width="0.8" />`);
        if (sub.isFirst) {
          const subLabel = withAnswers ? sub.subfield.name : BLANK;
          parts.push(`<text x="${sx + sw / 2}" y="${subTop + subH / 2 + 3}" text-anchor="middle" font-size="9" font-weight="600" fill="#111">${escapeHtml(truncateToFit(subLabel, sw - 4, 5))}</text>`);
        }
      }
    }
  }

  parts.push(`</svg>`);
  return parts.join("\n");
}

function formatSizeLabel(bits, field) {
  const bytes = bits / 8;
  const byteStr = Number.isInteger(bytes) ? `${bytes}B` : `${bits}b`;
  return field.variable
    ? `${bits} bits (var)`
    : `${bits} bits${Number.isInteger(bytes) ? ` / ${byteStr}` : ""}`;
}

function truncateToFit(text, maxPx, pxPerChar = 6.5) {
  const max = Math.max(2, Math.floor(maxPx / pxPerChar));
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  return text.slice(0, max - 1) + "…";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function escapeAttr(s) {
  return escapeHtml(s);
}
