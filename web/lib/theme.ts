/**
 * Complete design system theme definitions.
 *
 * Single source of truth for all design values:
 * - Motion and easing (THEME_MOTION)
 * - Diagram layout constants (LAYOUT)
 * - Color and opacity values (DIAGRAM_OPACITY, theme definitions)
 * - UI theme definitions (light and dark)
 * - Diagram theme definitions (light and dark)
 */

import type { DiagramTheme } from "./colors";

// Re-export DiagramTheme for convenience (single import point for theme types)
export type { DiagramTheme };

/**
 * Motion and easing constants used throughout the app.
 */
export const THEME_MOTION = {
  ease: "cubic-bezier(0.32, 0.72, 0, 1)",
  fast: "180ms",
  med: "220ms",
} as const;

/**
 * Diagram layout dimensions and spacing.
 * Used across three diagram rendering paths: SVG export, PNG export, and UI rendering.
 */
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
  // Offset values match .field-lock-icon--block / --child in encryption.css
  badgeSizeLarge: 14,
  badgeSizeSmall: 10,
  badgeOffsetX: 6,
  badgeOffsetY: 6,
  badgeOffsetXSmall: 4,
  badgeOffsetYSmall: 4,
  badgeOpacityBlock: 0.85,
  badgeOpacityChild: 0.7,
  // Badge SVG constants (16x16 viewBox)
  badgeSvgViewBox: 16,
  badgeSvgRectX: 3,
  badgeSvgRectY: 7,
  badgeSvgRectWidth: 10,
  badgeSvgRectHeight: 7,
  badgeSvgRectRadius: 1.5,
  // Loading dots
  loadingDotSize: 6,
  // Ruler grid intervals (in bits)
  rulerMajorInterval: 8,
  rulerLabelInterval: 4,
  // Grid line dimensions
  gridLineWidth: 1,
  // Text styling
  cellTitleFontWeight: 600,
  textAnchor: "middle",
  // Export/render dimensions
  imageExportHeight: 400,
  maxScaleFactor: 2.0,
  // Subfield marker (override indicator shown in subfield cells)
  subfieldMarkerMarginX: 4,
  subfieldMarkerHeight: 1.5,
  subfieldMarkerRadius: 1.5,
  subfieldMarkerMarginBottom: 1,
  // Cell marker (override indicator shown in main field cells)
  cellMarkerMarginX: 7,
  cellMarkerHeight: 2.5,
  cellMarkerRadius: 2,
  cellMarkerMarginBottom: 3,
  // Header protected badge dimensions
  headerProtectedMarginBottom: 4,
  headerProtectedMarginRight: 18,
  headerProtectedFontSize: 9,
  // Subfield padding
  subfieldPaddingHorizontal: 2,
} as const;

// Derived dimensions (calculated from base LAYOUT values)
export const LAYOUT_DERIVED = {
  rowBandHeight: LAYOUT.rowHeight + LAYOUT.rowPaddingVertical * 2,
} as const;

/**
 * Diagram opacity values that are consistent across all themes.
 */
export const DIAGRAM_OPACITY = {
  rulerMinor: 0.55,
  subfieldBackground: 0.52,
} as const;

/**
 * Encrypted-field diagonal stripe pattern parameters.
 * Structural values (angle, size) live here; the stripe color lives in
 * LIGHT_DIAGRAM_THEME / DARK_DIAGRAM_THEME as `encryptedStripe` so that
 * oklchToRgb can derive the hex value used by the Satori renderer, while
 * generateThemeCssVariables() injects --encrypted-stripe for the CSS renderer.
 */
export const ENCRYPTED_STRIPE = {
  /** Angle of the repeating stripe (deg). CSS cannot interpolate this via var(). */
  angleDeg: 135,
  /** Width of the transparent gap between stripes (px). */
  gapPx: 5,
  /** Width of the colored stripe line (px). */
  linePx: 1,
  /** Cell opacity for encrypted blocks — matches `opacity` in encryption.css. */
  cellOpacity: 0.65,
  /** Cell opacity on hover/focus — slightly lifted for readability. */
  cellOpacityHover: 0.85,
} as const;

/**
 * UI theme colors: used by buttons, text, backgrounds, borders, etc.
 * These colors are exposed to CSS and Tailwind via the @theme block.
 */
export type UITheme = {
  bg: string;
  bgElevated: string;
  bgSubtle: string;
  bgHeader: string;
  headerFg: string;
  headerFgMuted: string;
  fg: string;
  fgMuted: string;
  fgFaint: string;
  border: string;
  borderStrong: string;
  focusRing: string;
  accent: string;
  accentFg: string;
  accentGlow: string;
  gridMajor: string;
  gridMinor: string;
  fieldStrokeSelected: string;
  fieldFillOpacity: number;
  fieldFillOpacityHover: number;
  variableStripe: string;
  fieldRoseStrong: string;
  legendDimChroma: number;
  markerAccent: string;
  markerAccentSoft: string;
};

/**
 * Light theme UI colors.
 */
export const LIGHT_UI_THEME: UITheme = {
  bg: "oklch(97% 0.012 260)",
  bgElevated: "oklch(99.5% 0.005 260)",
  bgSubtle: "oklch(95% 0.014 260)",
  bgHeader:
    "linear-gradient(135deg, oklch(32% 0.07 270) 0%, oklch(24% 0.08 268) 100%)",
  headerFg: "oklch(99% 0 0)",
  headerFgMuted: "oklch(99% 0 0 / 0.78)",
  fg: "oklch(22% 0.02 270)",
  fgMuted: "oklch(46% 0.02 270)",
  fgFaint: "oklch(60% 0.02 270)",
  border: "oklch(88% 0.012 260)",
  borderStrong: "oklch(80% 0.018 260)",
  focusRing: "oklch(62% 0.18 265)",
  accent: "oklch(62% 0.18 265)",
  accentFg: "oklch(99% 0 0)",
  accentGlow: "oklch(65% 0.2 265 / 0.45)",
  gridMajor: "oklch(85% 0.014 260)",
  gridMinor: "oklch(93% 0.01 260)",
  fieldStrokeSelected: "oklch(22% 0.04 270)",
  fieldFillOpacity: 0.78,
  fieldFillOpacityHover: 0.95,
  variableStripe: "oklch(22% 0.02 270 / 0.18)",
  fieldRoseStrong: "oklch(50% 0.18 18)",
  legendDimChroma: 0.04,
  markerAccent: "oklch(68% 0.24 330)",
  markerAccentSoft: "oklch(78% 0.18 330 / 0.55)",
};

/**
 * Dark theme UI colors.
 */
export const DARK_UI_THEME: UITheme = {
  bg: "oklch(18% 0.025 270)",
  bgElevated: "oklch(22% 0.028 270)",
  bgSubtle: "oklch(26% 0.03 270)",
  bgHeader:
    "linear-gradient(135deg, oklch(22% 0.06 270) 0%, oklch(14% 0.06 270) 100%)",
  headerFg: "oklch(96% 0.012 270)",
  headerFgMuted: "oklch(96% 0.012 270 / 0.7)",
  fg: "oklch(94% 0.015 270)",
  fgMuted: "oklch(72% 0.02 270)",
  fgFaint: "oklch(58% 0.02 270)",
  border: "oklch(32% 0.03 270)",
  borderStrong: "oklch(40% 0.035 270)",
  focusRing: "oklch(78% 0.16 265)",
  accent: "oklch(72% 0.16 265)",
  accentFg: "oklch(18% 0.025 270)",
  accentGlow: "oklch(72% 0.16 265 / 0.55)",
  gridMajor: "oklch(40% 0.034 270)",
  gridMinor: "oklch(30% 0.028 270)",
  fieldStrokeSelected: "oklch(96% 0.012 270)",
  fieldFillOpacity: 0.85,
  fieldFillOpacityHover: 1,
  variableStripe: "oklch(99% 0 0 / 0.22)",
  fieldRoseStrong: "oklch(82% 0.17 18)",
  legendDimChroma: 0.04,
  markerAccent: "oklch(78% 0.24 330)",
  markerAccentSoft: "oklch(85% 0.18 330 / 0.55)",
};

/**
 * Tailwind palette values (400 shade) for each field token.
 * Single source of truth: UI (via --field-* CSS vars) and Satori both read from here.
 * To change a color, update the mapping here — UI and export stay in sync automatically.
 *
 * Token → Tailwind scale mapping:
 *   blue=sky  indigo=indigo  violet=violet  teal=cyan  green=emerald
 *   amber=amber  orange=orange  rose=rose  slate=slate
 */
const FIELD_PALETTE: DiagramTheme["fieldPalette"] = {
  blue: "oklch(74.6% 0.16 232.661)", // sky-400
  indigo: "oklch(67.3% 0.182 276.935)", // indigo-400
  violet: "oklch(70.2% 0.183 293.541)", // violet-400
  teal: "oklch(78.9% 0.154 211.53)", // cyan-400
  green: "oklch(76.5% 0.177 163.223)", // emerald-400
  amber: "oklch(82.8% 0.189 84.429)", // amber-400
  orange: "oklch(75% 0.183 55.934)", // orange-400
  rose: "oklch(71.2% 0.194 13.428)", // rose-400
  slate: "oklch(70.4% 0.04 256.788)", // slate-400
};

/**
 * Light theme diagram colors.
 */
export const LIGHT_DIAGRAM_THEME: DiagramTheme = {
  background: "oklch(99.5% 0.005 260)",
  rowEven: "oklch(98% 0.008 260)",
  rowOdd: "oklch(99.5% 0.005 260)",
  rulerTick: "oklch(58% 0.02 270)",
  rulerLabel: "oklch(42% 0.02 270)",
  accent: "oklch(62% 0.18 265)",
  fieldStroke: "oklch(38% 0.04 270)",
  fieldLabel: "oklch(22% 0.02 270)",
  fieldSublabel: "oklch(28% 0.03 270)",
  fieldContinuation: "oklch(48% 0.02 270)",
  markerAccent: "oklch(68% 0.24 330)",
  markerAccentSoft: "oklch(78% 0.18 330 / 0.55)",
  subfieldBackground: "oklch(99.5% 0.005 260)",
  subfieldLabel: "oklch(22% 0.02 270)",
  encryptedStripe: "oklch(46% 0.02 270 / 0.35)",
  fieldFillOpacity: 0.78,
  rulerMinorOpacity: DIAGRAM_OPACITY.rulerMinor,
  subfieldBackgroundOpacity: DIAGRAM_OPACITY.subfieldBackground,
  fieldPalette: FIELD_PALETTE,
};

/**
 * Dark theme diagram colors.
 */
export const DARK_DIAGRAM_THEME: DiagramTheme = {
  background: "oklch(22% 0.028 270)",
  rowEven: "oklch(24% 0.03 270)",
  rowOdd: "oklch(22% 0.028 270)",
  rulerTick: "oklch(60% 0.025 270)",
  rulerLabel: "oklch(78% 0.02 270)",
  accent: "oklch(72% 0.16 265)",
  fieldStroke: "oklch(28% 0.03 270)",
  fieldLabel: "oklch(18% 0.025 270)",
  fieldSublabel: "oklch(22% 0.03 270)",
  fieldContinuation: "oklch(85% 0.015 270)",
  markerAccent: "oklch(78% 0.24 330)",
  markerAccentSoft: "oklch(85% 0.18 330 / 0.55)",
  subfieldBackground: "oklch(22% 0.028 270)",
  subfieldLabel: "oklch(96% 0.012 270)",
  encryptedStripe: "oklch(72% 0.02 270 / 0.55)",
  fieldFillOpacity: 0.85,
  rulerMinorOpacity: DIAGRAM_OPACITY.rulerMinor,
  subfieldBackgroundOpacity: DIAGRAM_OPACITY.subfieldBackground,
  fieldPalette: FIELD_PALETTE,
};
