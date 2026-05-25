// Image-export pipeline for the live diagram. Three primitives at a glance:
//
// - `buildDiagramSvg(packet, layout, opts)` — emits a standalone SVG string
//   (no <style>, no external assets, all colors resolved to attributes) so
//   it round-trips through `dangerouslySetInnerHTML` previews, file
//   downloads, and the rasterizer below without picking up app CSS.
// - `readDiagramTheme(mode)` — derives the palette from the running
//   stylesheets (`:root` / `[data-theme="dark"]`) without mutating
//   `document.documentElement`, so exporting "Light" while the UI is in
//   Dark mode doesn't flash the page.
// - `svgToPngBlob(svg, scale)` — rasterizes via `<img src=blob:>` → canvas
//   → `toBlob`. Inputs are restricted to the self-contained SVGs above,
//   which keeps the canvas un-tainted; if you add `<image href>`, `<use
//   href>`, or `<foreignObject>` to the SVG, audit cross-origin handling
//   here before extending the contract.

import { CATEGORY_TO_TOKEN } from "./constants";
import type {
  Cell,
  Field,
  Packet,
  ResolvedLayout,
  SubCell,
} from "./psml/renderer";
import { LIGHT_DIAGRAM_THEME, DARK_DIAGRAM_THEME } from "./colors";

export type DiagramExportTheme = {
  background: string;
  rowEven: string;
  rowOdd: string;
  rulerTick: string;
  rulerLabel: string;
  accent: string;
  fieldStroke: string;
  fieldLabel: string;
  fieldSublabel: string;
  fieldContinuation: string;
  fieldFillOpacity: number;
  rulerMinorOpacity: number;
  subfieldBackgroundOpacity: number;
  fieldPalette: Record<string, string>;
};

export type DiagramThemeMode = "follow-ui" | "light" | "dark";

export type DiagramSvgOptions = {
  theme?: DiagramExportTheme;
  bitWidth?: number;
  transparentBackground?: boolean;
};

export type CellVisual = {
  fill: string;
  stroke: string;
  isDashed: boolean;
  titleColor: string;
  title: string;
  subtitle: string;
};

export const LAYOUT = {
  padding: 16,
  rulerHeight: 22,
  rulerGap: 6,
  rowHeight: 56,
  rowPaddingVertical: 4,
  rowGap: 4,
  cellPaddingVertical: 6,
  cellPaddingHorizontal: 8,
  cellInset: 2,
  subfieldHeight: 18,
  subfieldTextXOffset: 6,
  subfieldTextYOffset: 12,
  subfieldXPadding: 4,
  subfieldWidthPadding: 8,
  cellTitleTextYOffset: 23,
  cellSubtitleTextYOffset: 36,
  cellSubtitleMarginTop: 2,
  diagramGap: 4,
  rowGap2: 3,
  cellGap: 2,
  rowBorderRadius: 8,
  cellBorderRadius: 10,
  subfieldBorderRadius: 6,
  titleFontSize: 12,
  subtitleFontSize: 10,
  subfieldFontSize: 9,
  majorTickHeight: 10,
  minorTickHeight: 6,
  strokeWidthSubfield: 0.8,
  strokeWidthCell: 1,
  strokeWidthBadge: 1.6,
  // Lock badge (encryption icon) dimensions
  badgeSizeLarge: 14,
  badgeSizeSmall: 10,
  badgeOffsetX: 20,
  badgeOffsetY: 6,
  badgeOffsetXSmall: 14,
  badgeOffsetYSmall: 14,
  // Badge SVG constants (16x16 viewBox)
  badgeSvgViewBox: 16,
  badgeSvgRectX: 3,
  badgeSvgRectY: 7,
  badgeSvgRectWidth: 10,
  badgeSvgRectHeight: 7,
  badgeSvgRectRadius: 1.5,
  // Loading dots
  loadingDotSize: 6,
  // Scaling limits
  maxScaleUI: 2.0,
} as const;

// Derived dimensions (calculated from base LAYOUT values)
export const LAYOUT_DERIVED = {
  rowBandHeight: LAYOUT.rowHeight + LAYOUT.rowPaddingVertical * 2,
} as const;

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function xmlAttribute(value: string): string {
  return xmlEscape(value);
}

export function resolveToken(field: Field): string {
  if (field.category && CATEGORY_TO_TOKEN[field.category]) {
    return CATEGORY_TO_TOKEN[field.category];
  }
  return field.color ?? "slate";
}

export function fieldFill(field: Field, theme: DiagramExportTheme): string {
  const token = resolveToken(field);
  return theme.fieldPalette[token] ?? "black";
}

export function rowsFor(layout: ResolvedLayout): Cell[][] {
  // ResolvedLayout contract: row indices are non-negative integers.
  const rowsTotal = layout.cells.length
    ? Math.max(...layout.cells.map((cell) => cell.row)) + 1
    : 0;
  const rows: Cell[][] = Array.from({ length: rowsTotal }, () => []);
  for (const cell of layout.cells) {
    if (!Number.isInteger(cell.row) || cell.row < 0 || cell.row >= rowsTotal) {
      throw new Error(`Invalid diagram row index: ${cell.row}`);
    }
    rows[cell.row].push(cell);
  }
  return rows;
}

export function rowY(row: number): number {
  return (
    LAYOUT.padding +
    LAYOUT.rulerHeight +
    LAYOUT.rulerGap +
    row * (LAYOUT_DERIVED.rowBandHeight + LAYOUT.rowGap)
  );
}

export function cellGeometry(cell: Cell, bitWidth: number) {
  const x = LAYOUT.padding + cell.startBit * bitWidth + LAYOUT.cellInset;
  const y = rowY(cell.row) + LAYOUT.rowPaddingVertical + LAYOUT.cellInset;
  const width =
    (cell.endBit - cell.startBit + 1) * bitWidth - LAYOUT.cellInset * 2;
  const height = LAYOUT.rowHeight - LAYOUT.cellInset * 2;
  return { x, y, width, height };
}

function clipPathIdForCell(cell: Cell): string {
  const encodedFieldId = Array.from(
    cell.field.id,
    (char) => char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "fffd",
  ).join("-");
  return `cell-${cell.row}-${cell.segmentIndex}-${encodedFieldId}`;
}

export function textForCell(cell: Cell): { title: string; subtitle: string } {
  if (!cell.isFirst) {
    return {
      title: `… ${cell.field.variable ? `~${cell.field.name}` : cell.field.name}`,
      subtitle: "cont.",
    };
  }
  const title = cell.field.variable ? `~${cell.field.name}` : cell.field.name;
  // The first segment shows the whole field size so split fields retain one
  // authoritative label across rows; continuation segments stay lightweight.
  const bytes = cell.bitsTotal / 8;
  const suffix = cell.field.variable ? " (var)" : "";
  const subtitle = Number.isInteger(bytes)
    ? `${cell.bitsTotal} bits / ${bytes}B${suffix}`
    : `${cell.bitsTotal} bits${suffix}`;
  return { title, subtitle };
}

export function cellVisual(
  cell: Cell,
  field: Field,
  theme: DiagramExportTheme,
): CellVisual {
  const { title, subtitle } = textForCell(cell);
  return {
    fill: fieldFill(field, theme),
    stroke: cell.encryptedParentId ? theme.accent : theme.fieldStroke,
    isDashed: cell.encrypted === true,
    titleColor: cell.isFirst ? theme.fieldLabel : theme.fieldContinuation,
    title,
    subtitle,
  };
}

export function naturalDiagramHeight(rowCount: number): number {
  return (
    LAYOUT.rulerHeight +
    LAYOUT.rulerGap +
    rowCount * LAYOUT_DERIVED.rowBandHeight +
    Math.max(rowCount - 1, 0) * LAYOUT.rowGap
  );
}

export function rowBandColor(
  rowIndex: number,
  theme: DiagramExportTheme,
): string {
  return rowIndex % 2 === 0 ? theme.rowEven : theme.rowOdd;
}

function renderSubfields(
  subCells: SubCell[] | undefined,
  cell: Cell,
  bitWidth: number,
  theme: DiagramExportTheme,
  subfieldFontSize: number,
): string {
  if (!subCells?.length) return "";
  const parent = cellGeometry(cell, bitWidth);
  const y = parent.y + parent.height - LAYOUT.subfieldHeight - 5;
  return subCells
    .map((sub) => {
      const x =
        LAYOUT.padding +
        sub.startBit * bitWidth +
        LAYOUT.cellInset +
        LAYOUT.subfieldXPadding;
      const width =
        (sub.endBit - sub.startBit + 1) * bitWidth -
        LAYOUT.cellInset * 2 -
        LAYOUT.subfieldWidthPadding;
      const label = sub.isFirst ? xmlEscape(sub.subfield.name) : "";
      return [
        `<rect x="${x}" y="${y}" width="${Math.max(width, 1)}" height="${LAYOUT.subfieldHeight}" rx="${LAYOUT.subfieldBorderRadius}" fill="${xmlAttribute(theme.background)}" fill-opacity="${theme.subfieldBackgroundOpacity}" stroke="${xmlAttribute(theme.fieldStroke)}" stroke-width="${LAYOUT.strokeWidthSubfield}" />`,
        label
          ? `<text x="${x + LAYOUT.subfieldTextXOffset}" y="${y + LAYOUT.subfieldTextYOffset}" font-size="${subfieldFontSize}" font-family="ui-sans-serif, system-ui, sans-serif" fill="${xmlAttribute(theme.fieldLabel)}" overflow="hidden">${label}</text>`
          : "",
      ].join("");
    })
    .join("");
}

function renderLockBadge(
  x: number,
  y: number,
  size: number,
  color: string,
): string {
  const scale = size / LAYOUT.badgeSvgViewBox;
  return [
    `<g transform="translate(${x} ${y}) scale(${scale})" fill="none" stroke="${xmlAttribute(color)}" stroke-width="${LAYOUT.strokeWidthBadge}" stroke-linecap="round" stroke-linejoin="round">`,
    `<rect x="${LAYOUT.badgeSvgRectX}" y="${LAYOUT.badgeSvgRectY}" width="${LAYOUT.badgeSvgRectWidth}" height="${LAYOUT.badgeSvgRectHeight}" rx="${LAYOUT.badgeSvgRectRadius}" />`,
    '<path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />',
    "</g>",
  ].join("");
}

function renderCellBadges(
  cell: Cell,
  x: number,
  y: number,
  width: number,
  height: number,
  theme: DiagramExportTheme,
): string {
  if (!cell.isFirst) return "";
  const badges: string[] = [];
  if (cell.encrypted === true) {
    badges.push(
      renderLockBadge(
        x + width - LAYOUT.badgeOffsetX,
        y + LAYOUT.badgeOffsetY,
        LAYOUT.badgeSizeLarge,
        theme.accent,
      ),
    );
  }
  if (cell.encryptedParentId) {
    badges.push(
      renderLockBadge(
        x + width - LAYOUT.badgeOffsetXSmall,
        y + height - LAYOUT.badgeOffsetYSmall,
        LAYOUT.badgeSizeSmall,
        theme.accent,
      ),
    );
  }
  if (cell.headerProtected === true) {
    badges.push(
      `<text x="${x + width - 28}" y="${y + height - 6}" font-size="9" font-weight="700" font-family="ui-monospace, SFMono-Regular, monospace" fill="${xmlAttribute(theme.accent)}">HP</text>`,
    );
  }
  return badges.join("");
}

/**
 * Render the current packet diagram as a standalone, self-contained SVG
 * string. Every color is resolved to an attribute (no external CSS),
 * making the output safe to drop into `dangerouslySetInnerHTML`, save
 * as a file, or rasterize via {@link svgToPngBlob}.
 *
 * @param packet  Runtime packet (typically the rendered preset or the
 *                live studio packet for edit-mode exports).
 * @param layout  Pre-computed cell layout from `resolveLayout`.
 * @param options Theme override, per-bit pixel width, transparency.
 */
export function buildDiagramSvg(
  packet: Packet,
  layout: ResolvedLayout,
  options: DiagramSvgOptions = {},
): string {
  const theme = options.theme ?? LIGHT_DIAGRAM_THEME;
  const bitWidth = options.bitWidth ?? 24;
  const transparentBackground = options.transparentBackground === true;
  const rows = rowsFor(layout);
  const packetFieldsById = new Map(
    packet.fields.map((field) => [field.id, field]),
  );
  const width = LAYOUT.padding * 2 + packet.rowBits * bitWidth;
  const height = LAYOUT.padding * 2 + naturalDiagramHeight(rows.length);
  const titleFontSize = LAYOUT.titleFontSize;
  const subtitleFontSize = LAYOUT.subtitleFontSize;
  const majorTickH = LAYOUT.majorTickHeight;
  const minorTickH = LAYOUT.minorTickHeight;

  const ruler = Array.from({ length: packet.rowBits }, (_, bit) => {
    const x = LAYOUT.padding + bit * bitWidth;
    const major = bit % 8 === 0;
    const tickHeight = major ? majorTickH : minorTickH;
    const label =
      bit % 4 === 0
        ? `<text x="${x}" y="${LAYOUT.padding + 10}" text-anchor="middle" font-size="${subtitleFontSize}" font-family="ui-monospace, SFMono-Regular, monospace" fill="${xmlAttribute(theme.rulerLabel)}">${bit}</text>`
        : "";
    return `${label}<line x1="${x}" y1="${LAYOUT.padding + LAYOUT.rulerHeight - tickHeight}" x2="${x}" y2="${LAYOUT.padding + LAYOUT.rulerHeight}" stroke="${xmlAttribute(theme.rulerTick)}" stroke-width="${LAYOUT.strokeWidthCell}" opacity="${major ? 1 : theme.rulerMinorOpacity}" />`;
  }).join("");

  const body = rows
    .map((cells, rowIndex) => {
      const y = rowY(rowIndex);
      const bandColor = rowBandColor(rowIndex, theme);
      const band = transparentBackground
        ? ""
        : `<rect x="${LAYOUT.padding}" y="${y}" width="${packet.rowBits * bitWidth}" height="${LAYOUT_DERIVED.rowBandHeight}" rx="${LAYOUT.rowBorderRadius}" fill="${xmlAttribute(bandColor)}" />`;
      const renderedCells = cells
        .map((cell) => {
          const {
            x,
            y: cy,
            width: cw,
            height: ch,
          } = cellGeometry(cell, bitWidth);
          const exportField = packetFieldsById.get(cell.field.id) ?? cell.field;
          const { fill, stroke, isDashed, titleColor, title, subtitle } =
            cellVisual(cell, exportField, theme);
          const escapedTitle = xmlEscape(title);
          const escapedSubtitle = xmlEscape(subtitle);
          const dash = isDashed ? ' stroke-dasharray="5 3"' : "";
          // Note: SVG text attributes include overflow="hidden" and clip-path for text truncation.
          // Attribute order does not affect rendering; kept for consistency with StaticDiagram.
          return [
            `<rect x="${x}" y="${cy}" width="${Math.max(cw, 1)}" height="${ch}" rx="${LAYOUT.cellBorderRadius}" fill="${xmlAttribute(fill)}" fill-opacity="${theme.fieldFillOpacity}" stroke="${xmlAttribute(stroke)}" stroke-width="${LAYOUT.strokeWidthCell}"${dash} />`,
            `<text x="${x + cw / 2}" y="${cy + LAYOUT.cellTitleTextYOffset}" text-anchor="middle" font-size="${titleFontSize}" font-weight="600" font-family="ui-sans-serif, system-ui, sans-serif" fill="${xmlAttribute(titleColor)}" overflow="hidden" clip-path="url(#${clipPathIdForCell(cell)})">${escapedTitle}</text>`,
            `<text x="${x + cw / 2}" y="${cy + LAYOUT.cellSubtitleTextYOffset}" text-anchor="middle" font-size="${subtitleFontSize}" font-family="ui-sans-serif, system-ui, sans-serif" fill="${xmlAttribute(theme.fieldSublabel)}" overflow="hidden" clip-path="url(#${clipPathIdForCell(cell)})">${escapedSubtitle}</text>`,
            renderCellBadges(cell, x, cy, cw, ch, theme),
            renderSubfields(
              cell.subCells,
              cell,
              bitWidth,
              theme,
              LAYOUT.subfieldFontSize,
            ),
          ].join("");
        })
        .join("");
      return `${band}${renderedCells}`;
    })
    .join("");

  const clipPaths = layout.cells
    .map((cell) => {
      const { x, y, width, height } = cellGeometry(cell, bitWidth);
      return `<clipPath id="${clipPathIdForCell(cell)}"><rect x="${x + 4}" y="${y}" width="${Math.max(width - 8, 1)}" height="${height}" /></clipPath>`;
    })
    .join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xmlEscape(packet.name)} diagram">`,
    `<defs>${clipPaths}</defs>`,
    transparentBackground
      ? ""
      : `<rect width="${width}" height="${height}" fill="${xmlAttribute(theme.background)}" />`,
    ruler,
    body,
    "</svg>",
  ].join("");
}

/**
 * Resolve a {@link DiagramExportTheme} for the requested mode.
 *
 * - `"follow-ui"`: returns the theme matching the current `data-theme` attribute
 * - `"light"`: returns the light theme
 * - `"dark"`: returns the dark theme
 */
export function readDiagramTheme(mode: DiagramThemeMode): DiagramExportTheme {
  if (mode === "dark") {
    return DARK_DIAGRAM_THEME;
  }
  if (mode === "light") {
    return LIGHT_DIAGRAM_THEME;
  }
  // "follow-ui": read current theme from data-theme attribute
  if (typeof document !== "undefined") {
    const theme = document.documentElement.getAttribute("data-theme");
    return theme === "dark" ? DARK_DIAGRAM_THEME : LIGHT_DIAGRAM_THEME;
  }
  return LIGHT_DIAGRAM_THEME;
}

export function downloadTextFile(
  filename: string,
  mime: string,
  content: string,
): void {
  if (typeof document === "undefined" || typeof URL === "undefined") return;
  const blob = new Blob([content], { type: mime });
  downloadBlobFile(filename, blob);
}

export function downloadBlobFile(filename: string, blob: Blob): void {
  if (typeof document === "undefined" || typeof URL === "undefined") return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Rasterize a self-contained SVG string into a PNG Blob at the given
 * scale factor. The SVG must not reference external resources (no
 * `<image href>`, `<use href>`, or web fonts) or the resulting canvas
 * becomes tainted and `toBlob` will silently fail with `SecurityError`.
 *
 * @throws Error when `scale <= 0` or non-finite.
 * @throws Error when the SVG cannot be loaded as an image, the canvas
 *         2D context is unavailable, or `canvas.toBlob` yields null
 *         (typically a canvas dimension overflow).
 */
export async function svgToPngBlob(svg: string, scale: number): Promise<Blob> {
  // External callers (and corrupted localStorage) can pass anything; guard
  // before the silent-bad-output path kicks in (scale=0 → 1×1 transparent
  // PNG, scale<0 → mirrored offscreen, NaN → toBlob(null)).
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`Invalid PNG scale: ${scale}`);
  }
  const svgBlob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(svgBlob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("SVG image could not be loaded."));
      img.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context is unavailable.");
    ctx.scale(scale, scale);
    ctx.drawImage(image, 0, 0);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("PNG encoding failed."));
      }, "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

const CSS_PROPERTY_MAP: Record<keyof typeof LAYOUT, string> = {
  padding: "--diagram-padding",
  rulerHeight: "--diagram-ruler-height",
  rulerGap: "--diagram-ruler-gap",
  rowHeight: "--diagram-row-height",
  rowPaddingVertical: "--diagram-row-padding-vertical",
  rowGap: "--diagram-row-gap",
  cellPaddingVertical: "--diagram-cell-padding-vertical",
  cellPaddingHorizontal: "--diagram-cell-padding-horizontal",
  cellInset: "--diagram-cell-inset",
  subfieldHeight: "--subfield-height",
  subfieldTextXOffset: "--subfield-text-x-offset",
  subfieldTextYOffset: "--subfield-text-y-offset",
  subfieldXPadding: "--subfield-x-padding",
  subfieldWidthPadding: "--subfield-width-padding",
  cellTitleTextYOffset: "--cell-title-text-y-offset",
  cellSubtitleTextYOffset: "--cell-subtitle-text-y-offset",
  cellSubtitleMarginTop: "--cell-subtitle-margin-top",
  diagramGap: "--diagram-gap",
  rowGap2: "--row-gap-2",
  cellGap: "--cell-gap",
  rowBorderRadius: "--row-border-radius",
  cellBorderRadius: "--cell-border-radius",
  subfieldBorderRadius: "--subfield-border-radius",
  titleFontSize: "--title-font-size",
  subtitleFontSize: "--subtitle-font-size",
  subfieldFontSize: "--subfield-font-size",
  majorTickHeight: "--major-tick-height",
  minorTickHeight: "--minor-tick-height",
  strokeWidthSubfield: "--stroke-width-subfield",
  strokeWidthCell: "--stroke-width-cell",
  strokeWidthBadge: "--stroke-width-badge",
  badgeSizeLarge: "--badge-size-large",
  badgeSizeSmall: "--badge-size-small",
  badgeOffsetX: "--badge-offset-x",
  badgeOffsetY: "--badge-offset-y",
  badgeOffsetXSmall: "--badge-offset-x-small",
  badgeOffsetYSmall: "--badge-offset-y-small",
  badgeSvgViewBox: "--badge-svg-viewbox",
  badgeSvgRectX: "--badge-svg-rect-x",
  badgeSvgRectY: "--badge-svg-rect-y",
  badgeSvgRectWidth: "--badge-svg-rect-width",
  badgeSvgRectHeight: "--badge-svg-rect-height",
  badgeSvgRectRadius: "--badge-svg-rect-radius",
  loadingDotSize: "--loading-dot-size",
  maxScaleUI: "--max-scale-ui",
};

export function generateLayoutCssVariables(): string {
  const rules = Array.from(Object.entries(CSS_PROPERTY_MAP))
    .map(([key, cssVar]) => {
      const value = LAYOUT[key as keyof typeof LAYOUT];
      return `${cssVar}: ${value}px;`;
    })
    .join("");
  return `:root { ${rules} }`;
}
