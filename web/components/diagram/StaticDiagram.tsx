import type { Cell, Packet, ResolvedLayout } from "@/lib/psdl/renderer";
import {
  rowsFor,
  cellVisual,
  naturalDiagramHeight,
  rowBandColor,
  isFieldOverridable,
} from "@/lib/diagram-export";
import { LAYOUT } from "@/lib/theme";
import type { DiagramExportTheme } from "@/lib/diagram-export";
import { LockIcon } from "@/components/diagram/diagram-badges";

function hexToRgb(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? [
        parseInt(result[1], 16),
        parseInt(result[2], 16),
        parseInt(result[3], 16),
      ]
    : [255, 255, 255];
}

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
  /** When true, row backgrounds are transparent instead of banded. */
  transparentBackground?: boolean;
};

/** Satori-compatible renderer; uses flexbox + inline styles only (no CSS classes) for next/og compatibility. */
export function StaticDiagram({
  packet,
  layout,
  theme,
  fontFamily = "Noto Sans, system-ui, sans-serif",
  targetHeight,
  maxRows,
  transparentBackground,
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
    let naturalH = naturalDiagramHeight(totalRows);
    // Account for rows with subfields, which add height beyond the standard rowBandHeight.
    // A row with subfields has total height = rowBandHeight + (subfieldHeight + cellGap),
    // so we add the difference for each affected row.
    const rowsWithSubfields = rows.filter((r) =>
      r.some((c) => c.subCells && c.subCells.length > 0),
    ).length;
    naturalH += rowsWithSubfields * (LAYOUT.subfieldHeight + LAYOUT.cellGap);
    // Scale up to fit targetHeight, but cap at maxScaleFactor to avoid over-enlargement in SSR contexts
    // (OG images with small content should not be upscaled beyond readability limits)
    scale = Math.min(targetHeight / naturalH, LAYOUT.maxScaleFactor);
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
        padding: LAYOUT.padding,
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
          const major = bit % LAYOUT.rulerMajorInterval === 0;
          const showLabel = bit % LAYOUT.rulerLabelInterval === 0;
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
                  width: LAYOUT.gridLineWidth,
                  height: major ? majorTickH : minorTickH,
                  background: theme.rulerTick,
                  opacity: major ? 1 : theme.rulerMinorOpacity,
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
          const bandColor = transparentBackground
            ? "transparent"
            : rowBandColor(rowIdx, theme);
          const rowHasSubfields = cells.some(
            (c) => c.subCells && c.subCells.length > 0,
          );
          const effectiveRowHeight = rowHasSubfields
            ? (LAYOUT.rowHeight + LAYOUT.subfieldHeight + LAYOUT.cellGap) *
              scale
            : rowHeight;
          return (
            <div
              key={rowIdx}
              style={{
                display: "flex",
                gap: LAYOUT.rowGap2,
                padding: `${rowPaddingVertical}px 0`,
                borderRadius: LAYOUT.rowBorderRadius,
                background: bandColor,
                minHeight: effectiveRowHeight,
              }}
            >
              {cells.map((cell: Cell) => {
                const span = cell.endBit - cell.startBit + 1;
                const exportField =
                  packetFieldsById.get(cell.field.id) ?? cell.field;
                const {
                  fill,
                  fillOpacity,
                  stroke,
                  isDashed,
                  titleColor,
                  title,
                  subtitle,
                } = cellVisual(cell, exportField, theme);
                const hasSubfields =
                  !!cell.subCells && cell.subCells.length > 0;
                const isOverridable = isFieldOverridable(exportField);
                const isEncryptedBlock = cell.encrypted === true;
                const isEncryptedChild = !!cell.encryptedParentId;
                const isHeaderProtected = cell.headerProtected === true;

                return (
                  <div
                    key={`${cell.field.id}-${cell.segmentIndex}`}
                    style={{
                      flex: span,
                      position: "relative",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      border: `1px ${isDashed ? "dashed" : "solid"} ${stroke}`,
                      borderRadius: LAYOUT.cellBorderRadius,
                      padding: `${cellPaddingVertical}px ${cellPaddingHorizontal}px`,
                      overflow: "hidden",
                      minWidth: 0,
                      background: `rgba(${hexToRgb(fill).join(", ")}, ${fillOpacity})`,
                    }}
                  >
                    <div
                      style={{
                        position: "relative",
                        zIndex: 1,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "100%",
                        flex: hasSubfields ? "0 0 auto" : "1 1 auto",
                      }}
                    >
                      <span
                        style={{
                          fontSize: titleFontSize,
                          fontWeight: LAYOUT.cellTitleFontWeight,
                          color: titleColor,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          maxWidth: "100%",
                          display: "block",
                          textAlign: "center",
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
                          textAlign: "center",
                        }}
                      >
                        {subtitle}
                      </span>
                    </div>

                    {hasSubfields ? (
                      <div
                        style={{
                          position: "relative",
                          zIndex: 1,
                          display: "flex",
                          flexWrap: "nowrap",
                          gap: LAYOUT.cellGap,
                          width: "100%",
                          marginTop: "auto",
                        }}
                      >
                        {cell.subCells!.map((sub) => {
                          const subSpan = sub.endBit - sub.startBit + 1;
                          const isSubOverridable = exportField.subfields?.some(
                            (sf) =>
                              sf.id === sub.subfield.id &&
                              isFieldOverridable(sf),
                          );
                          return (
                            <div
                              key={`sub-${sub.id}`}
                              style={{
                                flex: subSpan,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                minHeight: Math.round(
                                  LAYOUT.subfieldHeight * scale,
                                ),
                                minWidth: 0,
                                background: theme.subfieldBackground,
                                border: `1px solid ${theme.fieldStroke}`,
                                borderRadius: Math.round(
                                  LAYOUT.subfieldBorderRadius * scale,
                                ),
                                fontSize: Math.round(
                                  LAYOUT.subfieldFontSize * scale,
                                ),
                                fontWeight: 600,
                                color: theme.subfieldLabel,
                                padding: `0 ${LAYOUT.subfieldPaddingHorizontal}px`,
                                position: "relative",
                              }}
                            >
                              {sub.isFirst ? (
                                <span
                                  style={{
                                    whiteSpace: "nowrap",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    maxWidth: "100%",
                                  }}
                                >
                                  {sub.subfield.name}
                                </span>
                              ) : null}
                              {isSubOverridable ? (
                                <div
                                  style={{
                                    content: '""',
                                    position: "absolute",
                                    left: Math.round(
                                      LAYOUT.subfieldMarkerMarginX * scale,
                                    ),
                                    right: Math.round(
                                      LAYOUT.subfieldMarkerMarginX * scale,
                                    ),
                                    bottom: Math.round(
                                      LAYOUT.subfieldMarkerMarginBottom * scale,
                                    ),
                                    height: Math.round(
                                      LAYOUT.subfieldMarkerHeight * scale,
                                    ),
                                    borderRadius: Math.round(
                                      LAYOUT.subfieldMarkerRadius * scale,
                                    ),
                                    background: `linear-gradient(90deg, ${theme.markerAccentSoft} 0%, ${theme.markerAccent} 50%, ${theme.markerAccentSoft} 100%)`,
                                    pointerEvents: "none",
                                  }}
                                />
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}

                    {isEncryptedBlock && cell.isFirst ? (
                      <div
                        style={{
                          display: "flex",
                          position: "absolute",
                          top: Math.round(LAYOUT.badgeOffsetY * scale),
                          right: Math.round(LAYOUT.badgeOffsetX * scale),
                          zIndex: 2,
                        }}
                      >
                        <LockIcon
                          size={Math.round(LAYOUT.badgeSizeLarge * scale)}
                          color={theme.accent}
                        />
                      </div>
                    ) : null}

                    {isEncryptedChild && cell.isFirst ? (
                      <div
                        style={{
                          display: "flex",
                          position: "absolute",
                          bottom: Math.round(LAYOUT.badgeOffsetYSmall * scale),
                          right: Math.round(LAYOUT.badgeOffsetXSmall * scale),
                          zIndex: 2,
                        }}
                      >
                        <LockIcon
                          size={Math.round(LAYOUT.badgeSizeSmall * scale)}
                          color={theme.accent}
                        />
                      </div>
                    ) : null}

                    {isHeaderProtected && cell.isFirst ? (
                      <span
                        style={{
                          position: "absolute",
                          bottom: Math.round(
                            LAYOUT.headerProtectedMarginBottom * scale,
                          ),
                          right: Math.round(
                            LAYOUT.headerProtectedMarginRight * scale,
                          ),
                          fontSize: Math.round(
                            LAYOUT.headerProtectedFontSize * scale,
                          ),
                          fontWeight: 700,
                          color: theme.accent,
                          zIndex: 2,
                        }}
                      >
                        HP
                      </span>
                    ) : null}

                    {isOverridable ? (
                      <div
                        style={{
                          content: '""',
                          position: "absolute",
                          left: Math.round(LAYOUT.cellMarkerMarginX * scale),
                          right: Math.round(LAYOUT.cellMarkerMarginX * scale),
                          bottom: Math.round(
                            LAYOUT.cellMarkerMarginBottom * scale,
                          ),
                          height: Math.round(LAYOUT.cellMarkerHeight * scale),
                          borderRadius: Math.round(
                            LAYOUT.cellMarkerRadius * scale,
                          ),
                          background: `linear-gradient(90deg, ${theme.markerAccentSoft} 0%, ${theme.markerAccent} 50%, ${theme.markerAccentSoft} 100%)`,
                          pointerEvents: "none",
                          zIndex: 2,
                        }}
                      />
                    ) : null}
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
              gap: Math.round(LAYOUT.diagramGap * scale),
              borderRadius: LAYOUT.rowBorderRadius,
              background: "transparent",
              minHeight: Math.round(LAYOUT.rowHeight * scale),
            }}
          >
            <div
              style={{
                width: Math.round(LAYOUT.loadingDotSize * scale),
                height: Math.round(LAYOUT.loadingDotSize * scale),
                borderRadius: "50%",
                background: theme.fieldLabel,
                opacity: 0.5,
              }}
            />
            <div
              style={{
                width: Math.round(LAYOUT.loadingDotSize * scale),
                height: Math.round(LAYOUT.loadingDotSize * scale),
                borderRadius: "50%",
                background: theme.fieldLabel,
                opacity: 0.5,
              }}
            />
            <div
              style={{
                width: Math.round(LAYOUT.loadingDotSize * scale),
                height: Math.round(LAYOUT.loadingDotSize * scale),
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
