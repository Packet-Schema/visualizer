// SVG renderer for a resolved packet layout.

const SVG_NS = "http://www.w3.org/2000/svg";

const BIT_WIDTH = 22;        // px per bit
const ROW_HEIGHT = 56;       // px per row
const RULER_HEIGHT = 22;     // top bit ruler
const PADDING_X = 12;
const PADDING_TOP = 8;
const PADDING_BOTTOM = 12;

// Known color tokens map to CSS custom properties. Unknown values are passed
// through unchanged (so legacy hex still works).
const KNOWN_TOKENS = new Set([
  "blue", "indigo", "violet", "teal", "green", "amber", "orange", "rose", "slate",
]);

function resolveFieldColor(color) {
  if (!color) return "var(--field-slate)";
  if (KNOWN_TOKENS.has(color)) return `var(--field-${color})`;
  return color;
}

export function renderPacket(packet, layout, { selectedFieldId, onFieldClick }) {
  const rowBits = packet.rowBits;
  const rows = layout.cells.length
    ? Math.max(...layout.cells.map(c => c.row)) + 1
    : 0;

  const innerWidth = rowBits * BIT_WIDTH;
  const width = innerWidth + PADDING_X * 2;
  const height = PADDING_TOP + RULER_HEIGHT + rows * ROW_HEIGHT + PADDING_BOTTOM;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${packet.name} diagram`);
  svg.classList.add("packet-svg");

  // Bit ruler
  const ruler = createGroup(`translate(${PADDING_X}, ${PADDING_TOP})`);
  ruler.classList.add("bit-ruler");
  for (let b = 0; b <= rowBits; b++) {
    const x = b * BIT_WIDTH;
    const major = b % 8 === 0;
    const tick = createSvg("line", {
      x1: x, x2: x,
      y1: RULER_HEIGHT - (major ? 10 : 6),
      y2: RULER_HEIGHT,
      "stroke-width": major ? 1.2 : 0.6,
    });
    tick.classList.add(major ? "ruler-tick-major" : "ruler-tick-minor");
    ruler.appendChild(tick);
    if (b < rowBits && b % 4 === 0) {
      const label = createSvg("text", {
        x: x + BIT_WIDTH * 2,
        y: RULER_HEIGHT - 12,
        "text-anchor": "middle",
        "font-size": 10,
      });
      label.classList.add("ruler-label");
      label.textContent = b;
      ruler.appendChild(label);
    }
  }
  // Final bit label
  const lastLabel = createSvg("text", {
    x: rowBits * BIT_WIDTH,
    y: RULER_HEIGHT - 12,
    "text-anchor": "end",
    "font-size": 10,
  });
  lastLabel.classList.add("ruler-label");
  lastLabel.textContent = rowBits - 1;
  ruler.appendChild(lastLabel);
  svg.appendChild(ruler);

  // Grid background per row
  const gridY0 = PADDING_TOP + RULER_HEIGHT;
  for (let r = 0; r < rows; r++) {
    const y = gridY0 + r * ROW_HEIGHT;
    // row band
    const band = createSvg("rect", {
      x: PADDING_X,
      y,
      width: innerWidth,
      height: ROW_HEIGHT,
    });
    band.classList.add("row-band");
    band.classList.add(r % 2 === 0 ? "row-band-even" : "row-band-odd");
    svg.appendChild(band);

    // vertical bit guides
    for (let b = 0; b <= rowBits; b++) {
      const x = PADDING_X + b * BIT_WIDTH;
      const major = b % 8 === 0;
      const guide = createSvg("line", {
        x1: x, x2: x, y1: y, y2: y + ROW_HEIGHT,
        "stroke-width": 1,
      });
      guide.classList.add(major ? "grid-guide-major" : "grid-guide-minor");
      svg.appendChild(guide);
    }
  }

  // Field cells
  for (const cell of layout.cells) {
    const x = PADDING_X + cell.startBit * BIT_WIDTH;
    const y = gridY0 + cell.row * ROW_HEIGHT;
    const w = (cell.endBit - cell.startBit + 1) * BIT_WIDTH;
    const h = ROW_HEIGHT;

    const isSelected = cell.field.id === selectedFieldId;
    const group = createGroup();
    group.classList.add("field-cell");
    if (isSelected) group.classList.add("selected");
    group.dataset.fieldId = cell.field.id;
    group.setAttribute("tabindex", "0");
    group.setAttribute("role", "button");
    group.setAttribute("aria-label",
      `${cell.field.name}, ${cell.bitsTotal} bits${isSelected ? ", selected" : ""}`);

    const fillColor = resolveFieldColor(cell.field.color);

    const rect = createSvg("rect", {
      x: x + 1,
      y: y + 4,
      width: w - 2,
      height: h - 8,
      rx: 6,
      ry: 6,
      fill: fillColor,
    });
    rect.classList.add("field-rect");
    group.appendChild(rect);

    // Variable-length stripe indicator
    if (cell.field.variable) {
      const stripe = createSvg("rect", {
        x: x + 1,
        y: y + 4,
        width: w - 2,
        height: h - 8,
        rx: 6, ry: 6,
        fill: "url(#variable-stripes)",
        "pointer-events": "none",
      });
      group.appendChild(stripe);
    }

    // Field name (only on first segment)
    if (cell.isFirst) {
      const label = createSvg("text", {
        x: x + w / 2,
        y: y + h / 2 - 2,
        "text-anchor": "middle",
        "font-size": 12,
        "font-weight": 600,
        "pointer-events": "none",
      });
      label.classList.add("field-label");
      label.textContent = truncateToFit(cell.field.name, w - 10);
      group.appendChild(label);

      const sub = createSvg("text", {
        x: x + w / 2,
        y: y + h / 2 + 12,
        "text-anchor": "middle",
        "font-size": 10,
        "pointer-events": "none",
      });
      sub.classList.add("field-sublabel");
      sub.textContent = formatBitsLabel(cell.bitsTotal, cell.field);
      group.appendChild(sub);
    } else {
      // continuation marker
      const cont = createSvg("text", {
        x: x + w / 2,
        y: y + h / 2 + 3,
        "text-anchor": "middle",
        "font-size": 10,
        "font-style": "italic",
        "pointer-events": "none",
      });
      cont.classList.add("field-continuation");
      cont.textContent = `… ${cell.field.name} (cont.)`;
      cont.textContent = truncateToFit(cont.textContent, w - 10);
      group.appendChild(cont);
    }

    if (onFieldClick) {
      group.style.cursor = "pointer";
      group.addEventListener("click", () => onFieldClick(cell.field));
      group.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onFieldClick(cell.field);
        }
      });
    }

    svg.appendChild(group);
  }

  // Defs (stripes for variable-length)
  const defs = createSvg("defs", {});
  defs.innerHTML = `
    <pattern id="variable-stripes" patternUnits="userSpaceOnUse"
             width="8" height="8" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="8" class="variable-stripe-line" stroke-width="1"/>
    </pattern>
  `;
  svg.insertBefore(defs, svg.firstChild);

  return svg;
}

function createSvg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  return el;
}

function createGroup(transform) {
  const g = document.createElementNS(SVG_NS, "g");
  if (transform) g.setAttribute("transform", transform);
  return g;
}

function formatBitsLabel(bits, field) {
  const bytes = bits / 8;
  const byteStr = Number.isInteger(bytes) ? `${bytes}B` : `${bits}b`;
  return field.variable ? `${bits} bits (var)` : `${bits} bits${Number.isInteger(bytes) ? ` / ${byteStr}` : ""}`;
}

function truncateToFit(text, maxPx) {
  // Rough: ~6.5 px per char at font-size 12
  const max = Math.max(2, Math.floor(maxPx / 6.5));
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  return text.slice(0, max - 1) + "…";
}
