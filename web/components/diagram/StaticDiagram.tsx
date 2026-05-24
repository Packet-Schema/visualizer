import type { Cell, Packet, ResolvedLayout } from "@/lib/psml/renderer";
import { fieldFill, rowsFor, textForCell } from "@/lib/diagram-export";
import type { DiagramExportTheme } from "@/lib/diagram-export";

const BASE_RULER_HEIGHT = 22;
const BASE_RULER_GAP = 6;
const BASE_ROW_HEIGHT = 56;
const BASE_ROW_GAP = 4;

type Props = {
  packet: Packet;
  layout: ResolvedLayout;
  theme: DiagramExportTheme;
  fontFamily?: string;
  /** When set, all dimension and font-size values are scaled so the diagram
   *  fills exactly this height. Omit to render at natural size. */
  targetHeight?: number;
};

/** Satori-compatible renderer; uses flexbox + inline styles only (no CSS classes) for next/og compatibility. */
export function StaticDiagram({
  packet,
  layout,
  theme,
  fontFamily = "Noto Sans, system-ui, sans-serif",
  targetHeight,
}: Props) {
  const rows = rowsFor(layout);
  const { rowBits } = packet;
  const packetFieldsById = new Map(packet.fields.map((f) => [f.id, f]));

  const rowCount = rows.length;
  let scale = 1;
  if (targetHeight != null && rowCount > 0) {
    const naturalH =
      BASE_RULER_HEIGHT +
      BASE_RULER_GAP +
      rowCount * BASE_ROW_HEIGHT +
      Math.max(rowCount - 1, 0) * BASE_ROW_GAP;
    scale = targetHeight / naturalH;
  }

  const rulerHeight = BASE_RULER_HEIGHT * scale;
  const rulerGap = BASE_RULER_GAP * scale;
  const rowHeight = BASE_ROW_HEIGHT * scale;
  const rowGap = BASE_ROW_GAP * scale;
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
              padding: "4px 0",
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
                    padding: "6px 4px",
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
      </div>
    </div>
  );
}
