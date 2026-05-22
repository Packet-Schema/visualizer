import type { Cell, Packet, ResolvedLayout } from "@/lib/psml/renderer";
import { fieldFill, rowsFor, textForCell } from "@/lib/diagram-export";
import type { DiagramExportTheme } from "@/lib/diagram-export";

const RULER_HEIGHT = 22;
const RULER_GAP = 6;
const ROW_HEIGHT = 56;
const ROW_GAP = 4;

type Props = {
  packet: Packet;
  layout: ResolvedLayout;
  theme: DiagramExportTheme;
  fontFamily?: string;
};

/**
 * Satori-compatible static diagram renderer. Uses flexbox + inline styles
 * (no CSS Grid, no CSS classes) so it can be used inside next/og ImageResponse
 * as well as rendered in the browser as a static thumbnail.
 *
 * Visually mirrors HybridDiagram: alternating row bands, colored cells with
 * field name + bit label, and a bit-position ruler.
 */
export function StaticDiagram({
  packet,
  layout,
  theme,
  fontFamily = "Noto Sans, system-ui, sans-serif",
}: Props) {
  const rows = rowsFor(layout);
  const { rowBits } = packet;
  const packetFieldsById = new Map(packet.fields.map((f) => [f.id, f]));

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        fontFamily,
      }}
    >
      {/* Ruler — one flex cell per bit, tick + label aligned to left edge */}
      <div
        style={{
          display: "flex",
          height: RULER_HEIGHT,
          marginBottom: RULER_GAP,
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
                    fontSize: 10,
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
                  height: major ? 10 : 6,
                  background: theme.rulerTick,
                  opacity: major ? 1 : 0.6,
                }}
              />
            </div>
          );
        })}
      </div>

      {/* Rows */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: ROW_GAP,
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
              minHeight: ROW_HEIGHT,
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
                      fontSize: 12,
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
                      fontSize: 10,
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
