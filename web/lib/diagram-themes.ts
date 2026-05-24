// Color definitions live in lib/colors.ts. This module handles CSS generation.
import {
  LIGHT_UI_THEME,
  DARK_UI_THEME,
  LIGHT_DIAGRAM_THEME,
  DARK_DIAGRAM_THEME,
  THEME_MOTION,
} from "./colors";

// Re-export color constants for backward compatibility
export {
  LIGHT_DIAGRAM_THEME,
  DARK_DIAGRAM_THEME,
  type DiagramTheme,
} from "./colors";

/**
 * Generate CSS variable declarations for both UI and diagram themes.
 *
 * Returns a string like:
 * `:root { --bg: oklch(...); ... } [data-theme="dark"] { --bg: oklch(...); ... }`
 *
 * This is injected into a <style> tag at SSR time in app/layout.tsx, so CSS
 * and JavaScript can both reference the same colors via CSS variables.
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
    `--pv-ease: ${THEME_MOTION.ease}`,
    `--pv-fast: ${THEME_MOTION.fast}`,
    `--pv-med: ${THEME_MOTION.med}`,
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
    `--pv-ease: ${THEME_MOTION.ease}`,
    `--pv-fast: ${THEME_MOTION.fast}`,
    `--pv-med: ${THEME_MOTION.med}`,
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
