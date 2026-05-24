import type { Cell, Packet, ResolvedLayout } from "@/lib/psml/renderer";
import { fieldFill, rowsFor, textForCell } from "@/lib/diagram-export";
import type { DiagramExportTheme } from "@/lib/diagram-export";

// Note: This component renders the same diagram as buildDiagramSvg (used for live exports),
// but as JSX instead of SVG strings for Satori/next/og compatibility. When modifying
// diagram layout, dimensions, or rendering logic, update both implementations to stay in sync.

const BASE_RULER_HEIGHT = 22;
const BASE_RULER_GAP = 6;
const BASE_ROW_HEIGHT = 56;
const BASE_ROW_GAP = 4;
const BASE_ROW_PADDING_VERTICAL = 4; // 4px top + 4px bottom
const BASE_CELL_PADDING_VERTICAL = 6;
const BASE_CELL_PADDING_HORIZONTAL = 4;

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
    const naturalH =
      BASE_RULER_HEIGHT +
      BASE_RULER_GAP +
      totalRows * (BASE_ROW_HEIGHT + BASE_ROW_PADDING_VERTICAL * 2) +
      Math.max(totalRows - 1, 0) * BASE_ROW_GAP;
    scale = targetHeight / naturalH;
  }

  const rulerHeight = BASE_RULER_HEIGHT * scale;
  const rulerGap = BASE_RULER_GAP * scale;
  const rowHeight = BASE_ROW_HEIGHT * scale;
  const rowGap = BASE_ROW_GAP * scale;
  // Round discrete dimensions to prevent rendering artifacts and maintain clarity across scale factors
  const rowPaddingVertical = Math.round(BASE_ROW_PADDING_VERTICAL * scale);
  const cellPaddingVertical = Math.round(BASE_CELL_PADDING_VERTICAL * scale);
  const cellPaddingHorizontal = Math.round(
    BASE_CELL_PADDING_HORIZONTAL * scale,
  );
  const titleFontSize = Math.round(12 * scale);
  const smallFontSize = Math.round(10 * scale);
  const majorTickH = Math.round(10 * scale);
  const minorTickH = Math.round(6 * scale);

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
        {rows.map((cells: Cell[], rowIdx: number) => (
          <div
            key={rowIdx}
            style={{
              display: "flex",
              gap: 3,
              padding: `${rowPaddingVertical}px 0`,
              borderRadius: 8,
              background: rowIdx % 2 === 0 ? theme.rowEven : theme.rowOdd,
              minHeight: rowHeight,
            }}
          >
            {cells.map((cell: Cell) => {
              const span = cell.endBit - cell.startBit + 1;
              const { title, subtitle } = textForCell(cell);
              const exportField =
                packetFieldsById.get(cell.field.id) ?? cell.field;
              const fill = fieldFill(exportField, theme);
              const stroke = cell.encryptedParentId
                ? theme.accent
                : theme.fieldStroke;

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
                    border: `1px ${cell.encrypted ? "dashed" : "solid"} ${stroke}`,
                    borderRadius: 10,
                    padding: `${cellPaddingVertical}px ${cellPaddingHorizontal}px`,
                    overflow: "hidden",
                    minWidth: 0,
                  }}
                >
                  <span
                    style={{
                      fontSize: titleFontSize,
                      fontWeight: 600,
                      color: cell.isFirst
                        ? theme.fieldLabel
                        : theme.fieldContinuation,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      maxWidth: "100%",
                      textAlign: "center",
                      display: "block",
                    }}
                  >
                    {title}
                  </span>
                  <span
                    style={{
                      fontSize: smallFontSize,
                      color: theme.fieldSublabel,
                      marginTop: 2,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      maxWidth: "100%",
                      textAlign: "center",
                      display: "block",
                    }}
                  >
                    {subtitle}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
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
