/**
 * Consolidated color definitions for Packet View.
 *
 * This is the single source of truth for all application colors, including:
 * - UI colors (backgrounds, text, borders, accents)
 * - Diagram-specific colors (fields, rulers, row bands)
 *
 * CSS variables are generated via generateThemeCssVariables() and injected
 * into the DOM at build time, so both DOM-based code and export pipelines
 * can reference the same color palette.
 */

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
};

/**
 * Diagram-specific colors: used when exporting SVG/PNG or rendering the static diagram.
 */
export type DiagramTheme = {
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
  fieldPalette: Record<string, string>;
};

/**
 * Light theme UI colors.
 */
export const LIGHT_UI_THEME: UITheme = {
  bg: "oklch(97% 0.012 260)",
  bgElevated: "oklch(99.5% 0.005 260)",
  bgSubtle: "oklch(95% 0.014 260)",
  bgHeader: "linear-gradient(135deg, oklch(32% 0.07 270) 0%, oklch(24% 0.08 268) 100%)",
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
};

/**
 * Dark theme UI colors.
 */
export const DARK_UI_THEME: UITheme = {
  bg: "oklch(18% 0.025 270)",
  bgElevated: "oklch(22% 0.028 270)",
  bgSubtle: "oklch(26% 0.03 270)",
  bgHeader: "linear-gradient(135deg, oklch(22% 0.06 270) 0%, oklch(14% 0.06 270) 100%)",
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
  fieldPalette: {
    blue: "oklch(70% 0.14 255)",
    indigo: "oklch(68% 0.16 280)",
    violet: "oklch(70% 0.16 310)",
    teal: "oklch(74% 0.11 195)",
    green: "oklch(78% 0.13 145)",
    amber: "oklch(82% 0.13 85)",
    orange: "oklch(74% 0.14 50)",
    rose: "oklch(72% 0.14 18)",
    slate: "oklch(72% 0.02 270)",
  },
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
  fieldPalette: {
    blue: "oklch(74% 0.14 255)",
    indigo: "oklch(72% 0.17 280)",
    violet: "oklch(74% 0.17 310)",
    teal: "oklch(78% 0.11 195)",
    green: "oklch(80% 0.14 145)",
    amber: "oklch(85% 0.14 85)",
    orange: "oklch(78% 0.15 50)",
    rose: "oklch(76% 0.15 18)",
    slate: "oklch(78% 0.02 270)",
  },
};

/**
 * Generate CSS variable declarations for both UI and diagram themes.
 *
 * Returns a string like:
 * `:root { --bg: oklch(...); ... } [data-theme="dark"] { --bg: oklch(...); ... }`
 *
 * This is injected into a <style> tag at SSR time, so CSS and JavaScript
 * can both reference the same colors via CSS variables.
 */
export function generateThemeCssVariables(): string {
  const lightUIVars = [
    `--bg: ${LIGHT_UI_THEME.bg}`,
    `--bg-elevated: ${LIGHT_UI_THEME.bgElevated}`,
    `--bg-subtle: ${LIGHT_UI_THEME.bgSubtle}`,
    `--bg-header: ${LIGHT_UI_THEME.bgHeader}`,
    `--header-fg: ${LIGHT_UI_THEME.headerFg}`,
    `--header-fg-muted: ${LIGHT_UI_THEME.headerFgMuted}`,
    `--fg: ${LIGHT_UI_THEME.fg}`,
    `--fg-muted: ${LIGHT_UI_THEME.fgMuted}`,
    `--fg-faint: ${LIGHT_UI_THEME.fgFaint}`,
    `--border: ${LIGHT_UI_THEME.border}`,
    `--border-strong: ${LIGHT_UI_THEME.borderStrong}`,
    `--focus-ring: ${LIGHT_UI_THEME.focusRing}`,
    `--accent: ${LIGHT_UI_THEME.accent}`,
    `--accent-fg: ${LIGHT_UI_THEME.accentFg}`,
    `--accent-glow: ${LIGHT_UI_THEME.accentGlow}`,
    `--grid-major: ${LIGHT_UI_THEME.gridMajor}`,
    `--grid-minor: ${LIGHT_UI_THEME.gridMinor}`,
    `--field-stroke-selected: ${LIGHT_UI_THEME.fieldStrokeSelected}`,
    `--field-fill-opacity: ${LIGHT_UI_THEME.fieldFillOpacity}`,
    `--field-fill-opacity-hover: ${LIGHT_UI_THEME.fieldFillOpacityHover}`,
    `--variable-stripe: ${LIGHT_UI_THEME.variableStripe}`,
    `--field-rose-strong: ${LIGHT_UI_THEME.fieldRoseStrong}`,
    `--legend-dim-chroma: ${LIGHT_UI_THEME.legendDimChroma}`,
    `--pv-ease: cubic-bezier(0.32, 0.72, 0, 1)`,
    `--pv-fast: 180ms`,
    `--pv-med: 220ms`,
  ];

  const lightDiagramVars = [
    `--bg-elevated: ${LIGHT_DIAGRAM_THEME.background}`,
    `--row-band-even: ${LIGHT_DIAGRAM_THEME.rowEven}`,
    `--row-band-odd: ${LIGHT_DIAGRAM_THEME.rowOdd}`,
    `--ruler-tick: ${LIGHT_DIAGRAM_THEME.rulerTick}`,
    `--ruler-label: ${LIGHT_DIAGRAM_THEME.rulerLabel}`,
    `--field-stroke: ${LIGHT_DIAGRAM_THEME.fieldStroke}`,
    `--field-label: ${LIGHT_DIAGRAM_THEME.fieldLabel}`,
    `--field-sublabel: ${LIGHT_DIAGRAM_THEME.fieldSublabel}`,
    `--field-continuation: ${LIGHT_DIAGRAM_THEME.fieldContinuation}`,
    ...Object.entries(LIGHT_DIAGRAM_THEME.fieldPalette).map(
      ([token, color]) => `--field-${token}: ${color}`,
    ),
  ];

  const darkUIVars = [
    `--bg: ${DARK_UI_THEME.bg}`,
    `--bg-elevated: ${DARK_UI_THEME.bgElevated}`,
    `--bg-subtle: ${DARK_UI_THEME.bgSubtle}`,
    `--bg-header: ${DARK_UI_THEME.bgHeader}`,
    `--header-fg: ${DARK_UI_THEME.headerFg}`,
    `--header-fg-muted: ${DARK_UI_THEME.headerFgMuted}`,
    `--fg: ${DARK_UI_THEME.fg}`,
    `--fg-muted: ${DARK_UI_THEME.fgMuted}`,
    `--fg-faint: ${DARK_UI_THEME.fgFaint}`,
    `--border: ${DARK_UI_THEME.border}`,
    `--border-strong: ${DARK_UI_THEME.borderStrong}`,
    `--focus-ring: ${DARK_UI_THEME.focusRing}`,
    `--accent: ${DARK_UI_THEME.accent}`,
    `--accent-fg: ${DARK_UI_THEME.accentFg}`,
    `--accent-glow: ${DARK_UI_THEME.accentGlow}`,
    `--grid-major: ${DARK_UI_THEME.gridMajor}`,
    `--grid-minor: ${DARK_UI_THEME.gridMinor}`,
    `--field-stroke-selected: ${DARK_UI_THEME.fieldStrokeSelected}`,
    `--field-fill-opacity: ${DARK_UI_THEME.fieldFillOpacity}`,
    `--field-fill-opacity-hover: ${DARK_UI_THEME.fieldFillOpacityHover}`,
    `--variable-stripe: ${DARK_UI_THEME.variableStripe}`,
    `--field-rose-strong: ${DARK_UI_THEME.fieldRoseStrong}`,
    `--legend-dim-chroma: ${DARK_UI_THEME.legendDimChroma}`,
    `--pv-ease: cubic-bezier(0.32, 0.72, 0, 1)`,
    `--pv-fast: 180ms`,
    `--pv-med: 220ms`,
  ];

  const darkDiagramVars = [
    `--bg-elevated: ${DARK_DIAGRAM_THEME.background}`,
    `--row-band-even: ${DARK_DIAGRAM_THEME.rowEven}`,
    `--row-band-odd: ${DARK_DIAGRAM_THEME.rowOdd}`,
    `--ruler-tick: ${DARK_DIAGRAM_THEME.rulerTick}`,
    `--ruler-label: ${DARK_DIAGRAM_THEME.rulerLabel}`,
    `--field-stroke: ${DARK_DIAGRAM_THEME.fieldStroke}`,
    `--field-label: ${DARK_DIAGRAM_THEME.fieldLabel}`,
    `--field-sublabel: ${DARK_DIAGRAM_THEME.fieldSublabel}`,
    `--field-continuation: ${DARK_DIAGRAM_THEME.fieldContinuation}`,
    ...Object.entries(DARK_DIAGRAM_THEME.fieldPalette).map(
      ([token, color]) => `--field-${token}: ${color}`,
    ),
  ];

  const lightVars = [...lightUIVars, ...lightDiagramVars].join(";");
  const darkVars = [...darkUIVars, ...darkDiagramVars].join(";");

  return `:root { ${lightVars}; } [data-theme="dark"] { ${darkVars}; }`;
}
