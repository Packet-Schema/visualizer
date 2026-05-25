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
import { createExportTheme } from "./colors";
import type { Cell, Field, ResolvedLayout } from "./psml/renderer";
import {
  LAYOUT,
  LAYOUT_DERIVED,
  LIGHT_DIAGRAM_THEME,
  DARK_DIAGRAM_THEME,
} from "./theme";

// Re-export LAYOUT and LAYOUT_DERIVED for backward compatibility
export { LAYOUT, LAYOUT_DERIVED } from "./theme";

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
  markerAccent: string;
  markerAccentSoft: string;
  subfieldBackground: string;
  fieldFillOpacity: number;
  rulerMinorOpacity: number;
  subfieldBackgroundOpacity: number;
  fieldPalette: Record<string, string>;
};

export type DiagramThemeMode = "follow-ui" | "light" | "dark";

export type CellVisual = {
  fill: string;
  fillOpacity: number;
  stroke: string;
  isDashed: boolean;
  titleColor: string;
  title: string;
  subtitle: string;
};

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

export function isFieldOverridable(field: Field): boolean {
  return !!(
    field.controlsLength ||
    field.tlv ||
    field.chainCatalog ||
    field.switchCases ||
    field.varintEncoding ||
    field.isBerLength ||
    field.optionalGateFor ||
    field.enumVariants
  );
}

export function cellVisual(
  cell: Cell,
  field: Field,
  theme: DiagramExportTheme,
): CellVisual {
  const { title, subtitle } = textForCell(cell);
  return {
    fill: fieldFill(field, theme),
    fillOpacity: theme.fieldFillOpacity,
    stroke: cell.encryptedParentId ? theme.accent : theme.fieldStroke,
    isDashed: cell.encrypted === true,
    titleColor: cell.isFirst ? theme.fieldLabel : theme.fieldContinuation,
    title,
    subtitle,
  };
}

export function naturalDiagramHeight(rowCount: number): number {
  return (
    LAYOUT.padding * 2 +
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

/**
 * Resolve a {@link DiagramExportTheme} for the requested mode.
 *
 * - `"follow-ui"`: returns the theme matching the current `data-theme` attribute
 * - `"light"`: returns the light theme
 * - `"dark"`: returns the dark theme
 */
export function readDiagramTheme(mode: DiagramThemeMode): DiagramExportTheme {
  if (mode === "dark") {
    return createExportTheme(DARK_DIAGRAM_THEME);
  }
  if (mode === "light") {
    return createExportTheme(LIGHT_DIAGRAM_THEME);
  }
  // "follow-ui": read current theme from data-theme attribute
  if (typeof document !== "undefined") {
    const theme = document.documentElement.getAttribute("data-theme");
    return createExportTheme(
      theme === "dark" ? DARK_DIAGRAM_THEME : LIGHT_DIAGRAM_THEME,
    );
  }
  return createExportTheme(LIGHT_DIAGRAM_THEME);
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

const CSS_PROPERTY_MAP: Partial<Record<keyof typeof LAYOUT, string>> = {
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
  rulerMajorInterval: "--ruler-major-interval",
  rulerLabelInterval: "--ruler-label-interval",
  gridLineWidth: "--grid-line-width",
  cellTitleFontWeight: "--cell-title-font-weight",
  textAnchor: "--text-anchor",
  imageExportHeight: "--image-export-height",
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
