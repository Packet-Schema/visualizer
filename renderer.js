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

// Semantic category -> color token. When a field has a `category`, the
// renderer prefers the category's token over the legacy per-field `color`,
// which keeps the visual language consistent across packets.
export const CATEGORY_TO_TOKEN = {
  addressing: "blue",
  identifier: "indigo",
  length: "teal",
  type: "green",
  flags: "rose",
  reserved: "slate",
  checksum: "orange",
  variable: "amber",
  "payload-marker": "violet",
};

// Resolve a token string to its CSS variable; unknown values pass through
// (so a legacy hex like "#abc" still works).
export function tokenToCssVar(token) {
  if (!token) return "var(--field-slate)";
  if (KNOWN_TOKENS.has(token)) return `var(--field-${token})`;
  return token;
}

// Pick a field's fill color. Prefer the semantic category token; fall back to
// the legacy per-field color; finally default to slate.
function resolveFieldColor(fieldOrColor) {
  // Backwards compatibility: callers used to pass `field.color` directly.
  if (typeof fieldOrColor === "string" || fieldOrColor == null) {
    return tokenToCssVar(fieldOrColor);
  }
  const field = fieldOrColor;
  if (field.category && CATEGORY_TO_TOKEN[field.category]) {
    return tokenToCssVar(CATEGORY_TO_TOKEN[field.category]);
  }
  return tokenToCssVar(field.color);
}

export function renderPacket(packet, layout, { selectedFieldId, onFieldClick, onSubfieldClick }) {
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

  // Field cells. We use roving tabindex: only the first cell (or the selected
  // cell when present) is in the tab order; arrow keys move focus between
  // siblings. See app.js#initDiagramKeyboardNav.
  let rovingTopAssigned = false;
  const selectedTopCellIndex = layout.cells.findIndex(c => c.field.id === selectedFieldId);
  // Track per-field segment counter so each cell gets a stable id like
  // "cell-<fieldId>-<segmentIndex>" suitable for interactive diffing.
  const segCounters = new Map();
  for (let i = 0; i < layout.cells.length; i++) {
    const cell = layout.cells[i];
    const x = PADDING_X + cell.startBit * BIT_WIDTH;
    const y = gridY0 + cell.row * ROW_HEIGHT;
    const w = (cell.endBit - cell.startBit + 1) * BIT_WIDTH;
    const h = ROW_HEIGHT;

    const isSelected = cell.field.id === selectedFieldId;
    const group = createGroup();
    group.classList.add("field-cell");
    if (isSelected) group.classList.add("selected");
    const segIdx = segCounters.get(cell.field.id) || 0;
    segCounters.set(cell.field.id, segIdx + 1);
    const cellId = `cell-${cell.field.id}-${segIdx}`;
    group.dataset.cellId = cellId;
    group.dataset.fieldId = cell.field.id;
    group.dataset.row = String(cell.row);
    group.dataset.startBit = String(cell.startBit);
    group.dataset.endBit = String(cell.endBit);

    // Roving tabindex: pick the selected cell when one exists, otherwise the
    // first cell. All others become tabindex=-1 (programmatically focusable).
    const shouldBeRoving = selectedTopCellIndex >= 0
      ? i === selectedTopCellIndex
      : !rovingTopAssigned;
    if (shouldBeRoving) {
      group.setAttribute("tabindex", "0");
      rovingTopAssigned = true;
    } else {
      group.setAttribute("tabindex", "-1");
    }
    group.setAttribute("role", "button");
    const variableNote = cell.field.variable ? ", variable-length" : "";
    group.setAttribute("aria-label",
      `${cell.field.name}, ${cell.bitsTotal} bits${variableNote}${isSelected ? ", selected" : ""}`);

    const fillColor = resolveFieldColor(cell.field);

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

    // Field name (only on first segment). Variable-length fields receive a
    // `~` prefix as a non-color signal (WCAG 1.4.1) — color alone (the stripe
    // pattern) is not enough on its own.
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
      const displayName = cell.field.variable
        ? `~${cell.field.name}`
        : cell.field.name;
      label.textContent = truncateToFit(displayName, w - 10);
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
      const contName = cell.field.variable ? `~${cell.field.name}` : cell.field.name;
      cont.textContent = `… ${contName} (cont.)`;
      cont.textContent = truncateToFit(cont.textContent, w - 10);
      group.appendChild(cont);
    }

    if (onFieldClick) {
      group.style.cursor = "pointer";
      group.addEventListener("click", (e) => onFieldClick(cell.field, e));
      group.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onFieldClick(cell.field, e);
        }
      });
    }

    svg.appendChild(group);

    // Subfield sub-cells rendered on top of the parent.
    if (cell.subCells && cell.subCells.length > 0) {
      // Determine which sub-cell holds the roving tabindex for this parent.
      // If one is selected, that one; else the first sub-cell of this parent.
      const selectedSubIdx = cell.subCells.findIndex(s => s.id === selectedFieldId);
      let subRovingAssigned = false;
      for (let si = 0; si < cell.subCells.length; si++) {
        const sub = cell.subCells[si];
        const sx = PADDING_X + sub.startBit * BIT_WIDTH;
        const sw = (sub.endBit - sub.startBit + 1) * BIT_WIDTH;
        // Lay subfield rect in the lower portion of the parent so the parent
        // label remains visible at the top.
        const subTop = y + h * 0.55;
        const subH = h * 0.32;

        const isSubSelected = selectedFieldId === sub.id;

        const subGroup = createGroup();
        subGroup.classList.add("subfield-cell");
        if (isSubSelected) subGroup.classList.add("selected");
        subGroup.dataset.fieldId = sub.id;
        subGroup.dataset.parentFieldId = cell.field.id;
        subGroup.dataset.subfieldId = sub.subfield.id;
        subGroup.setAttribute("role", "button");
        subGroup.setAttribute(
          "aria-label",
          `${sub.subfield.name} (subfield of ${cell.field.name}), ${sub.bitsTotal} bit${sub.bitsTotal === 1 ? "" : "s"}${isSubSelected ? ", selected" : ""}`,
        );
        const shouldBeSubRoving = selectedSubIdx >= 0
          ? si === selectedSubIdx
          : !subRovingAssigned;
        if (shouldBeSubRoving) {
          subGroup.setAttribute("tabindex", "0");
          subRovingAssigned = true;
        } else {
          subGroup.setAttribute("tabindex", "-1");
        }

        const subRect = createSvg("rect", {
          x: sx + 1,
          y: subTop,
          width: sw - 2,
          height: subH,
          rx: 3,
          ry: 3,
          fill: "var(--bg-elevated)",
          "fill-opacity": isSubSelected ? 0.95 : 0.78,
          stroke: isSubSelected ? "var(--field-stroke-selected)" : "var(--field-stroke)",
          "stroke-width": isSubSelected ? 1.6 : 0.8,
        });
        subGroup.appendChild(subRect);

        if (sub.isFirst) {
          const labelY = subTop + subH / 2 + 3;
          const subLabel = createSvg("text", {
            x: sx + sw / 2,
            y: labelY,
            "text-anchor": "middle",
            "font-size": 9,
            "font-weight": 600,
            fill: "var(--field-label)",
            "pointer-events": "none",
          });
          subLabel.textContent = truncateToFit(sub.subfield.name, sw - 4, 5);
          subGroup.appendChild(subLabel);
        }

        if (onSubfieldClick) {
          subGroup.style.cursor = "pointer";
          subGroup.addEventListener("click", (e) => {
            e.stopPropagation();
            onSubfieldClick(cell.field, sub.subfield, e);
          });
          subGroup.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              onSubfieldClick(cell.field, sub.subfield, e);
            }
          });
        }

        svg.appendChild(subGroup);
      }

      // Move parent label upward so subfield labels do not collide.
      // The parent label was already placed; nudge with a translate on the
      // existing text nodes via CSS class would be heavier — instead, we
      // adjust label positions by tweaking when isFirst (above) used cell.h/2.
      // Simpler: reposition the parent's name/sub texts by replacing them.
      // We do that by walking the group's children added in the parent block.
      const labels = group.querySelectorAll("text");
      labels.forEach((t, i) => {
        // Push each text upward into the upper half of the parent.
        const cy = parseFloat(t.getAttribute("y"));
        t.setAttribute("y", String(cy - h * 0.18));
      });
    }
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

function truncateToFit(text, maxPx, pxPerChar = 6.5) {
  // Rough: ~6.5 px per char at font-size 12; smaller for smaller fonts.
  const max = Math.max(2, Math.floor(maxPx / pxPerChar));
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  return text.slice(0, max - 1) + "…";
}

// Interactive slider update path: mutates x/width on existing top-level
// `.field-cell` rectangles whose cellId matches the new layout's cellId.
// When the structural shape stays the same (same set of cellIds, same row
// count) we can avoid a full rebuild and let CSS transition the width change.
// Returns true if the update could be applied in-place; false if the caller
// should fall back to a full re-render.
export function interactiveUpdate(svg, packet, layout) {
  if (!svg) return false;
  const rowBits = packet.rowBits;

  const expectedRows = layout.cells.length
    ? Math.max(...layout.cells.map(c => c.row)) + 1
    : 0;
  // Bail if the SVG was rendered for a different packet (very rough check).
  const existingCells = Array.from(svg.querySelectorAll("g.field-cell"));
  const existingIds = new Set(existingCells.map(g => g.dataset.cellId));
  // Build map of new cells by id.
  const segCounters = new Map();
  const newCells = layout.cells.map(cell => {
    const segIdx = segCounters.get(cell.field.id) || 0;
    segCounters.set(cell.field.id, segIdx + 1);
    return { ...cell, cellId: `cell-${cell.field.id}-${segIdx}` };
  });
  const newIds = new Set(newCells.map(c => c.cellId));

  // If the set of ids is identical, we can perform an in-place width/x update
  // for every cell with CSS-driven animation. If subfields are present, fall
  // back to full rebuild (their layout is more complex).
  const hasSubfields = layout.cells.some(c => c.subCells && c.subCells.length);
  if (hasSubfields) return false;

  let identical = existingIds.size === newIds.size;
  if (identical) {
    for (const id of newIds) {
      if (!existingIds.has(id)) { identical = false; break; }
    }
  }
  if (!identical) return false;

  // Need to update the SVG height in case row count changed (rare but
  // possible with very large IHL values).
  const gridY0 = PADDING_TOP + RULER_HEIGHT;
  const height = gridY0 + expectedRows * ROW_HEIGHT + PADDING_BOTTOM;
  svg.setAttribute("height", height);
  const innerWidth = rowBits * BIT_WIDTH;
  const width = innerWidth + PADDING_X * 2;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const cellById = new Map(existingCells.map(g => [g.dataset.cellId, g]));
  for (const cell of newCells) {
    const g = cellById.get(cell.cellId);
    if (!g) continue;
    const x = PADDING_X + cell.startBit * BIT_WIDTH;
    const y = gridY0 + cell.row * ROW_HEIGHT;
    const w = (cell.endBit - cell.startBit + 1) * BIT_WIDTH;
    const h = ROW_HEIGHT;
    g.dataset.row = String(cell.row);
    g.dataset.startBit = String(cell.startBit);
    g.dataset.endBit = String(cell.endBit);
    // Update each child element's geometry.
    for (const child of g.children) {
      const tag = child.tagName.toLowerCase();
      if (tag === "rect") {
        child.setAttribute("x", x + 1);
        child.setAttribute("y", y + 4);
        child.setAttribute("width", w - 2);
        child.setAttribute("height", h - 8);
      } else if (tag === "text") {
        // Recompute center based on label/sublabel hint via class.
        const isCont = child.classList.contains("field-continuation");
        const isSub = child.classList.contains("field-sublabel");
        child.setAttribute("x", x + w / 2);
        if (isCont) {
          child.setAttribute("y", y + h / 2 + 3);
          const contName = cell.field.variable ? `~${cell.field.name}` : cell.field.name;
          child.textContent = truncateToFit(`… ${contName} (cont.)`, w - 10);
        } else if (isSub) {
          child.setAttribute("y", y + h / 2 + 12);
          child.textContent = formatBitsLabel(cell.bitsTotal, cell.field);
        } else {
          child.setAttribute("y", y + h / 2 - 2);
          const displayName = cell.field.variable
            ? `~${cell.field.name}`
            : cell.field.name;
          child.textContent = truncateToFit(displayName, w - 10);
        }
      }
    }
  }
  return true;
}
