import type { Cell, Packet, ResolvedLayout } from "@/lib/psml/renderer";
import {
  rowsFor,
  cellVisual,
  naturalDiagramHeight,
  rowBandColor,
  LAYOUT,
} from "@/lib/diagram-export";
import type { DiagramExportTheme } from "@/lib/diagram-export";

type Props = {
  packet: Packet;
  layout: ResolvedLayout;
  theme: DiagramExportTheme;
  fontFamily?: string;
  /** When set, all dimension and font-size values are scaled so the diagram
   *  fills exactly this height. Omit to render at natural size. */
  targetHeight?: number;
  /** Maximum number of rows to display. If rows exceed this, show ellipsis. */
  maxRows?: number;
};

/** Satori-compatible renderer; uses flexbox + inline styles only (no CSS classes) for next/og compatibility. */
export function StaticDiagram({
  packet,
  layout,
  theme,
  fontFamily = "Noto Sans, system-ui, sans-serif",
  targetHeight,
  maxRows,
}: Props) {
  const allRows = rowsFor(layout);
  const { rowBits } = packet;
  const packetFieldsById = new Map(packet.fields.map((f) => [f.id, f]));

  const isTruncated = maxRows != null && allRows.length > maxRows;
  const rows = maxRows != null ? allRows.slice(0, maxRows) : allRows;
  const rowCount = rows.length;
  let scale = 1;
  if (targetHeight != null && rowCount > 0) {
    const totalRows = isTruncated ? rowCount + 1 : rowCount;
    const naturalH = naturalDiagramHeight(totalRows);
    // Scale up to fit targetHeight, but cap at 2x to avoid over-enlargement in SSR contexts
    // (OG images with small content should not be upscaled beyond readability limits)
    scale = Math.min(targetHeight / naturalH, 2.0);
  }

  const rulerHeight = LAYOUT.rulerHeight * scale;
  const rulerGap = LAYOUT.rulerGap * scale;
  const rowHeight = LAYOUT.rowHeight * scale;
  const rowGap = LAYOUT.rowGap * scale;
  // Round discrete dimensions to prevent rendering artifacts and maintain clarity across scale factors
  const rowPaddingVertical = Math.round(LAYOUT.rowPaddingVertical * scale);
  const cellPaddingVertical = Math.round(LAYOUT.cellPaddingVertical * scale);
  const cellPaddingHorizontal = Math.round(
    LAYOUT.cellPaddingHorizontal * scale,
  );
  const titleFontSize = Math.round(LAYOUT.titleFontSize * scale);
  const smallFontSize = Math.round(LAYOUT.subtitleFontSize * scale);
  const majorTickH = Math.round(LAYOUT.majorTickHeight * scale);
  const minorTickH = Math.round(LAYOUT.minorTickHeight * scale);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        fontFamily,
      }}
    >
      <div
        style={{
          display: "flex",
          height: rulerHeight,
          marginBottom: rulerGap,
        }}
      >
        {Array.from({ length: rowBits }, (_, bit) => {
          const major = bit % 8 === 0;
          const showLabel = bit % 4 === 0;
          return (
            <div
              key={bit}
              style={{
                flex: 1,
                position: "relative",
                display: "flex",
                alignItems: "flex-end",
              }}
            >
              {showLabel ? (
                <span
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    fontSize: smallFontSize,
                    lineHeight: "1",
                    color: theme.rulerLabel,
                  }}
                >
                  {bit}
                </span>
              ) : null}
              <div
                style={{
                  width: 1,
                  height: major ? majorTickH : minorTickH,
                  background: theme.rulerTick,
                  opacity: major ? 1 : 0.6,
                }}
              />
            </div>
          );
        })}
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: rowGap,
        }}
      >
        {rows.map((cells: Cell[], rowIdx: number) => {
          const bandColor = rowBandColor(rowIdx, theme);
          return (
            <div
              key={rowIdx}
              style={{
                display: "flex",
                gap: LAYOUT.rowGap2,
                padding: `${rowPaddingVertical}px 0`,
                borderRadius: LAYOUT.rowBorderRadius,
                background: bandColor,
                minHeight: rowHeight,
              }}
            >
              {cells.map((cell: Cell) => {
                const span = cell.endBit - cell.startBit + 1;
                const exportField =
                  packetFieldsById.get(cell.field.id) ?? cell.field;
                const { fill, stroke, isDashed, titleColor, title, subtitle } =
                  cellVisual(cell, exportField, theme);

                return (
                  <div
                    key={`${cell.field.id}-${cell.segmentIndex}`}
                    style={{
                      flex: span,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      background: fill,
                      border: `1px ${isDashed ? "dashed" : "solid"} ${stroke}`,
                      borderRadius: LAYOUT.cellBorderRadius,
                      padding: `${cellPaddingVertical}px ${cellPaddingHorizontal}px`,
                      overflow: "hidden",
                      minWidth: 0,
                    }}
                  >
                    <span
                      style={{
                        fontSize: titleFontSize,
                        fontWeight: 600,
                        color: titleColor,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        maxWidth: "100%",
                        display: "block",
                      }}
                    >
                      {title}
                    </span>
                    <span
                      style={{
                        fontSize: smallFontSize,
                        color: theme.fieldSublabel,
                        marginTop: LAYOUT.cellSubtitleMarginTop,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        maxWidth: "100%",
                        display: "block",
                      }}
                    >
                      {subtitle}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
        {isTruncated ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: `${rowPaddingVertical}px 0`,
              gap: Math.round(4 * scale),
              borderRadius: 8,
              background: "transparent",
              minHeight: rowHeight,
            }}
          >
            <div
              style={{
                width: Math.round(6 * scale),
                height: Math.round(6 * scale),
                borderRadius: "50%",
                background: theme.fieldLabel,
                opacity: 0.5,
              }}
            />
            <div
              style={{
                width: Math.round(6 * scale),
                height: Math.round(6 * scale),
                borderRadius: "50%",
                background: theme.fieldLabel,
                opacity: 0.5,
              }}
            />
            <div
              style={{
                width: Math.round(6 * scale),
                height: Math.round(6 * scale),
                borderRadius: "50%",
                background: theme.fieldLabel,
                opacity: 0.5,
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
