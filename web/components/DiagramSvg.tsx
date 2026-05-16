"use client";

import type { Field, Packet, ResolvedLayout, SubField } from "@/lib/types";
import { CATEGORY_TO_TOKEN, tokenToCssVar } from "@/lib/constants";

const BIT_WIDTH = 22;
const ROW_HEIGHT = 56;
const RULER_HEIGHT = 22;
const PADDING_X = 12;
const PADDING_TOP = 8;
const PADDING_BOTTOM = 12;

type Props = {
  packet: Packet;
  layout: ResolvedLayout;
  selectedFieldId: string | null;
  onFieldClick: (field: Field) => void;
  onSubfieldClick: (parentField: Field, subfield: SubField) => void;
};

function resolveFieldColor(field: Field): string {
  if (field.category && CATEGORY_TO_TOKEN[field.category]) {
    return tokenToCssVar(CATEGORY_TO_TOKEN[field.category]);
  }
  return tokenToCssVar(field.color);
}

function formatBitsLabel(bits: number, field: Field): string {
  if (field.variable) return `${bits} bits (var)`;
  const bytes = bits / 8;
  return Number.isInteger(bytes)
    ? `${bits} bits / ${bytes}B`
    : `${bits} bits`;
}

function truncateToFit(text: string, maxPx: number, pxPerChar = 6.5): string {
  const max = Math.max(2, Math.floor(maxPx / pxPerChar));
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  return text.slice(0, max - 1) + "…";
}

export default function DiagramSvg({
  packet,
  layout,
  selectedFieldId,
  onFieldClick,
  onSubfieldClick,
}: Props) {
  const rowBits = packet.rowBits;
  const rows = layout.cells.length
    ? Math.max(...layout.cells.map((c) => c.row)) + 1
    : 0;

  const innerWidth = rowBits * BIT_WIDTH;
  const width = innerWidth + PADDING_X * 2;
  const height = PADDING_TOP + RULER_HEIGHT + rows * ROW_HEIGHT + PADDING_BOTTOM;
  const gridY0 = PADDING_TOP + RULER_HEIGHT;

  // Bit ruler ticks + labels.
  const ticks: React.ReactNode[] = [];
  for (let b = 0; b <= rowBits; b++) {
    const x = b * BIT_WIDTH;
    const major = b % 8 === 0;
    ticks.push(
      <line
        key={`tick-${b}`}
        x1={x}
        x2={x}
        y1={RULER_HEIGHT - (major ? 10 : 6)}
        y2={RULER_HEIGHT}
        strokeWidth={major ? 1.2 : 0.6}
        className={major ? "ruler-tick-major" : "ruler-tick-minor"}
      />,
    );
    if (b < rowBits && b % 4 === 0) {
      ticks.push(
        <text
          key={`label-${b}`}
          x={x + BIT_WIDTH * 2}
          y={RULER_HEIGHT - 12}
          textAnchor="middle"
          fontSize={10}
          className="ruler-label"
        >
          {b}
        </text>,
      );
    }
  }
  ticks.push(
    <text
      key="label-last"
      x={rowBits * BIT_WIDTH}
      y={RULER_HEIGHT - 12}
      textAnchor="end"
      fontSize={10}
      className="ruler-label"
    >
      {rowBits - 1}
    </text>,
  );

  // Row bands + vertical guides.
  const grid: React.ReactNode[] = [];
  for (let r = 0; r < rows; r++) {
    const y = gridY0 + r * ROW_HEIGHT;
    grid.push(
      <rect
        key={`band-${r}`}
        x={PADDING_X}
        y={y}
        width={innerWidth}
        height={ROW_HEIGHT}
        className={`row-band ${r % 2 === 0 ? "row-band-even" : "row-band-odd"}`}
      />,
    );
    for (let b = 0; b <= rowBits; b++) {
      const x = PADDING_X + b * BIT_WIDTH;
      const major = b % 8 === 0;
      grid.push(
        <line
          key={`guide-${r}-${b}`}
          x1={x}
          x2={x}
          y1={y}
          y2={y + ROW_HEIGHT}
          strokeWidth={1}
          className={major ? "grid-guide-major" : "grid-guide-minor"}
        />,
      );
    }
  }

  // Field cells. We render subfield cells inside the lower half of each parent
  // segment, mirroring renderer.js.
  const cells: React.ReactNode[] = [];
  for (let i = 0; i < layout.cells.length; i++) {
    const cell = layout.cells[i];
    const isSelected = cell.field.id === selectedFieldId;
    const x = PADDING_X + cell.startBit * BIT_WIDTH;
    const y = gridY0 + cell.row * ROW_HEIGHT;
    const w = (cell.endBit - cell.startBit + 1) * BIT_WIDTH;
    const h = ROW_HEIGHT;

    const fill = resolveFieldColor(cell.field);
    const hasSubfields = !!cell.subCells && cell.subCells.length > 0;
    // Push parent label up when subfields are stacked underneath.
    const labelOffset = hasSubfields ? -h * 0.18 : 0;
    const variableNote = cell.field.variable ? ", variable-length" : "";

    const labelChildren: React.ReactNode[] = [];
    if (cell.isFirst) {
      const displayName = cell.field.variable
        ? `~${cell.field.name}`
        : cell.field.name;
      labelChildren.push(
        <text
          key="name"
          x={x + w / 2}
          y={y + h / 2 - 2 + labelOffset}
          textAnchor="middle"
          fontSize={12}
          fontWeight={600}
          pointerEvents="none"
          className="field-label"
        >
          {truncateToFit(displayName, w - 10)}
        </text>,
      );
      labelChildren.push(
        <text
          key="sub"
          x={x + w / 2}
          y={y + h / 2 + 12 + labelOffset}
          textAnchor="middle"
          fontSize={10}
          pointerEvents="none"
          className="field-sublabel"
        >
          {formatBitsLabel(cell.bitsTotal, cell.field)}
        </text>,
      );
    } else {
      const contName = cell.field.variable
        ? `~${cell.field.name}`
        : cell.field.name;
      labelChildren.push(
        <text
          key="cont"
          x={x + w / 2}
          y={y + h / 2 + 3 + labelOffset}
          textAnchor="middle"
          fontSize={10}
          fontStyle="italic"
          pointerEvents="none"
          className="field-continuation"
        >
          {truncateToFit(`… ${contName} (cont.)`, w - 10)}
        </text>,
      );
    }

    cells.push(
      <g
        key={`cell-${cell.field.id}-${cell.segmentIndex}`}
        className={`field-cell${isSelected ? " selected" : ""}`}
        role="button"
        // Roving tabindex: only the first field cell gets `tabindex=0` at
        // mount; PacketViewer's keydown handler updates these as focus moves.
        tabIndex={i === 0 ? 0 : -1}
        aria-label={`${cell.field.name}, ${cell.bitsTotal} bits${variableNote}${isSelected ? ", selected" : ""}`}
        data-field-id={cell.field.id}
        data-row={cell.row}
        data-start-bit={cell.startBit}
        data-end-bit={cell.endBit}
        data-segment-index={cell.segmentIndex}
        style={{ cursor: "pointer" }}
        onClick={() => onFieldClick(cell.field)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onFieldClick(cell.field);
          }
        }}
      >
        <rect
          x={x + 1}
          y={y + 4}
          width={w - 2}
          height={h - 8}
          rx={6}
          ry={6}
          fill={fill}
          className="field-rect"
        />
        {cell.field.variable ? (
          <rect
            x={x + 1}
            y={y + 4}
            width={w - 2}
            height={h - 8}
            rx={6}
            ry={6}
            fill="url(#variable-stripes)"
            pointerEvents="none"
          />
        ) : null}
        {labelChildren}
      </g>,
    );

    if (hasSubfields) {
      const subTop = y + h * 0.55;
      const subH = h * 0.32;
      for (const sub of cell.subCells!) {
        const sx = PADDING_X + sub.startBit * BIT_WIDTH;
        const sw = (sub.endBit - sub.startBit + 1) * BIT_WIDTH;
        const isSubSelected = selectedFieldId === sub.id;
        cells.push(
          <g
            key={`sub-${sub.id}-${cell.row}-${sub.startBit}`}
            className={`subfield-cell${isSubSelected ? " selected" : ""}`}
            role="button"
            tabIndex={-1}
            aria-label={`${sub.subfield.name} (subfield of ${cell.field.name}), ${sub.bitsTotal} bit${sub.bitsTotal === 1 ? "" : "s"}${isSubSelected ? ", selected" : ""}`}
            data-field-id={`${cell.field.id}:${sub.subfield.id}`}
            data-parent-field-id={cell.field.id}
            data-row={cell.row}
            data-start-bit={sub.startBit}
            data-end-bit={sub.endBit}
            style={{ cursor: "pointer" }}
            onClick={(e) => {
              e.stopPropagation();
              onSubfieldClick(cell.field, sub.subfield);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onSubfieldClick(cell.field, sub.subfield);
              }
            }}
          >
            <rect
              x={sx + 1}
              y={subTop}
              width={sw - 2}
              height={subH}
              rx={3}
              ry={3}
              fill="var(--bg-elevated)"
              fillOpacity={isSubSelected ? 0.95 : 0.78}
              stroke={
                isSubSelected
                  ? "var(--field-stroke-selected)"
                  : "var(--field-stroke)"
              }
              strokeWidth={isSubSelected ? 1.6 : 0.8}
            />
            {sub.isFirst ? (
              <text
                x={sx + sw / 2}
                y={subTop + subH / 2 + 3}
                textAnchor="middle"
                fontSize={9}
                fontWeight={600}
                fill="var(--field-label)"
                pointerEvents="none"
              >
                {truncateToFit(sub.subfield.name, sw - 4, 5)}
              </text>
            ) : null}
          </g>,
        );
      }
    }
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={`${packet.name} diagram`}
      className="packet-svg block select-none"
    >
      <defs>
        <pattern
          id="variable-stripes"
          patternUnits="userSpaceOnUse"
          width={8}
          height={8}
          patternTransform="rotate(45)"
        >
          <line
            x1={0}
            y1={0}
            x2={0}
            y2={8}
            className="variable-stripe-line"
            strokeWidth={1}
          />
        </pattern>
      </defs>
      <g transform={`translate(${PADDING_X}, ${PADDING_TOP})`} className="bit-ruler">
        {ticks}
      </g>
      {grid}
      {cells}
    </svg>
  );
}
