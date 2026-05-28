// PSDL 0.2 — renderer tokens.
//
// PSDL carries semantic intent only (`category`); the renderer decides how
// to paint each category. This module owns that mapping plus the legacy
// `ColorToken` palette the v1 → PSDL migrator preserves so older imports
// still hit a familiar swatch when no category is set.

import type { CategoryToken } from "./psdl/renderer";

/** Palette token kept around for legacy v1 imports without a category. */
export type ColorToken =
  | "blue"
  | "indigo"
  | "violet"
  | "teal"
  | "green"
  | "amber"
  | "orange"
  | "rose"
  | "slate";

const KNOWN_TOKENS = new Set<ColorToken>([
  "blue",
  "indigo",
  "violet",
  "teal",
  "green",
  "amber",
  "orange",
  "rose",
  "slate",
]);

export const FIELD_PALETTE_TOKENS: ReadonlyArray<ColorToken> = [
  "blue",
  "indigo",
  "violet",
  "teal",
  "green",
  "amber",
  "orange",
  "rose",
  "slate",
] as const;

/** Semantic category → CSS variable token. The CSS variables themselves
 *  (e.g. `--field-blue`) are declared in `web/app/globals.css`. */
export const CATEGORY_TO_TOKEN: Record<CategoryToken, ColorToken> = {
  addressing: "blue",
  identifier: "indigo",
  length: "teal",
  type: "green",
  flags: "rose",
  reserved: "slate",
  checksum: "orange",
  variable: "amber",
  "payload-marker": "violet",
};

function tokenForCellClass(
  field: { category?: CategoryToken; color?: string | null } | null | undefined,
): ColorToken {
  if (!field) return "slate";
  if (field.category && CATEGORY_TO_TOKEN[field.category]) {
    return CATEGORY_TO_TOKEN[field.category];
  }
  if (field.color && KNOWN_TOKENS.has(field.color as ColorToken)) {
    return field.color as ColorToken;
  }
  return "slate";
}

/** Resolve a token (or any CSS-color string) to a `var(--field-XXX)` value;
 *  unknown strings pass through so callers can pass arbitrary CSS values.
 *  `null`/`undefined` falls back to the slate swatch. */
export function tokenToCssVar(token: string | null | undefined): string {
  if (!token) return "var(--field-slate)";
  if (KNOWN_TOKENS.has(token as ColorToken)) return `var(--field-${token})`;
  return token;
}

/** Resolve the CSS color for a renderer field, preferring `category` over the
 *  legacy per-field `color` fallback that v1 imports may carry. */
export function categoryColor(
  field: { category?: CategoryToken; color?: string | null } | null | undefined,
): string {
  if (!field) return tokenToCssVar(null);
  if (field.category && CATEGORY_TO_TOKEN[field.category]) {
    return tokenToCssVar(CATEGORY_TO_TOKEN[field.category]);
  }
  return tokenToCssVar(field.color ?? null);
}

// Static maps required — Tailwind scans source for literal class strings.
// Template literals like `bg-field-${token}/80` are invisible to the scanner
// and would be dropped from the generated CSS.
//
// Opacity modifier with CSS variables (/[var(...)]) doesn't work because Tailwind
// generates color-mix() which requires a literal <percentage>, not a variable.
// Light (80%) and dark (85%) opacities are expressed as static dark: variants.
const FIELD_CELL_COLOR_CLASSES: Record<ColorToken, string> = {
  blue: "bg-field-blue/80 hover:bg-field-blue/95 dark:bg-field-blue/85 dark:hover:bg-field-blue",
  indigo:
    "bg-field-indigo/80 hover:bg-field-indigo/95 dark:bg-field-indigo/85 dark:hover:bg-field-indigo",
  violet:
    "bg-field-violet/80 hover:bg-field-violet/95 dark:bg-field-violet/85 dark:hover:bg-field-violet",
  teal: "bg-field-teal/80 hover:bg-field-teal/95 dark:bg-field-teal/85 dark:hover:bg-field-teal",
  green:
    "bg-field-green/80 hover:bg-field-green/95 dark:bg-field-green/85 dark:hover:bg-field-green",
  amber:
    "bg-field-amber/80 hover:bg-field-amber/95 dark:bg-field-amber/85 dark:hover:bg-field-amber",
  orange:
    "bg-field-orange/80 hover:bg-field-orange/95 dark:bg-field-orange/85 dark:hover:bg-field-orange",
  rose: "bg-field-rose/80 hover:bg-field-rose/95 dark:bg-field-rose/85 dark:hover:bg-field-rose",
  slate:
    "bg-field-slate/80 hover:bg-field-slate/95 dark:bg-field-slate/85 dark:hover:bg-field-slate",
};

const FIELD_CELL_SELECTED_COLOR_CLASSES: Record<ColorToken, string> = {
  blue: "bg-field-blue/95 hover:bg-field-blue",
  indigo: "bg-field-indigo/95 hover:bg-field-indigo",
  violet: "bg-field-violet/95 hover:bg-field-violet",
  teal: "bg-field-teal/95 hover:bg-field-teal",
  green: "bg-field-green/95 hover:bg-field-green",
  amber: "bg-field-amber/95 hover:bg-field-amber",
  orange: "bg-field-orange/95 hover:bg-field-orange",
  rose: "bg-field-rose/95 hover:bg-field-rose",
  slate: "bg-field-slate/95 hover:bg-field-slate",
};

// Gradient values are used in style={} as CSS strings, not as Tailwind classes,
// so template literals are safe here.
const FIELD_GRADIENT_COLORS: Record<ColorToken, string> = {
  blue: "color-mix(in oklab, var(--field-blue) 85%, transparent)",
  indigo: "color-mix(in oklab, var(--field-indigo) 85%, transparent)",
  violet: "color-mix(in oklab, var(--field-violet) 85%, transparent)",
  teal: "color-mix(in oklab, var(--field-teal) 85%, transparent)",
  green: "color-mix(in oklab, var(--field-green) 85%, transparent)",
  amber: "color-mix(in oklab, var(--field-amber) 85%, transparent)",
  orange: "color-mix(in oklab, var(--field-orange) 85%, transparent)",
  rose: "color-mix(in oklab, var(--field-rose) 85%, transparent)",
  slate: "color-mix(in oklab, var(--field-slate) 85%, transparent)",
};

export function categoryCellColorClasses(
  field: { category?: CategoryToken; color?: string | null } | null | undefined,
  selected = false,
): string {
  const token = tokenForCellClass(field);
  return selected
    ? FIELD_CELL_SELECTED_COLOR_CLASSES[token]
    : FIELD_CELL_COLOR_CLASSES[token];
}

export function categoryGradientColor(
  field: { category?: CategoryToken; color?: string | null } | null | undefined,
): string {
  return FIELD_GRADIENT_COLORS[tokenForCellClass(field)];
}
