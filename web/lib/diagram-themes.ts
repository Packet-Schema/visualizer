import type { DiagramExportTheme } from "./diagram-export";

export const LIGHT_DIAGRAM_THEME: DiagramExportTheme = {
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

export const DARK_DIAGRAM_THEME: DiagramExportTheme = {
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

export function generateThemeCssVariables(): string {
  // Note: --accent is intentionally excluded here as it's a UI-wide color
  // defined in globals.css, not a diagram-specific theme variable.
  const lightVars = [
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
  ].join(";");

  const darkVars = [
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
  ].join(";");

  return `:root { ${lightVars}; } [data-theme="dark"] { ${darkVars}; }`;
}
