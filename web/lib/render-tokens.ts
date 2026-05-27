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

export const FIELD_CELL_COLOR_CLASSES: Record<ColorToken, string> = {
  blue: "bg-sky-400/80 hover:bg-sky-400/95 dark:bg-sky-400/85 dark:hover:bg-sky-400",
  indigo:
    "bg-indigo-400/80 hover:bg-indigo-400/95 dark:bg-indigo-400/85 dark:hover:bg-indigo-400",
  violet:
    "bg-violet-400/80 hover:bg-violet-400/95 dark:bg-violet-400/85 dark:hover:bg-violet-400",
  teal: "bg-cyan-400/80 hover:bg-cyan-400/95 dark:bg-cyan-400/85 dark:hover:bg-cyan-400",
  green:
    "bg-emerald-400/80 hover:bg-emerald-400/95 dark:bg-emerald-400/85 dark:hover:bg-emerald-400",
  amber:
    "bg-amber-400/80 hover:bg-amber-400/95 dark:bg-amber-400/85 dark:hover:bg-amber-400",
  orange:
    "bg-orange-400/80 hover:bg-orange-400/95 dark:bg-orange-400/85 dark:hover:bg-orange-400",
  rose: "bg-rose-400/80 hover:bg-rose-400/95 dark:bg-rose-400/85 dark:hover:bg-rose-400",
  slate:
    "bg-slate-400/80 hover:bg-slate-400/95 dark:bg-slate-400/85 dark:hover:bg-slate-400",
};

export const FIELD_CELL_SELECTED_COLOR_CLASSES: Record<ColorToken, string> = {
  blue: "bg-sky-300/95 hover:bg-sky-300/95 dark:bg-sky-300 dark:hover:bg-sky-300",
  indigo:
    "bg-indigo-300/95 hover:bg-indigo-300/95 dark:bg-indigo-300 dark:hover:bg-indigo-300",
  violet:
    "bg-violet-300/95 hover:bg-violet-300/95 dark:bg-violet-300 dark:hover:bg-violet-300",
  teal: "bg-cyan-300/95 hover:bg-cyan-300/95 dark:bg-cyan-300 dark:hover:bg-cyan-300",
  green:
    "bg-emerald-300/95 hover:bg-emerald-300/95 dark:bg-emerald-300 dark:hover:bg-emerald-300",
  amber:
    "bg-amber-300/95 hover:bg-amber-300/95 dark:bg-amber-300 dark:hover:bg-amber-300",
  orange:
    "bg-orange-300/95 hover:bg-orange-300/95 dark:bg-orange-300 dark:hover:bg-orange-300",
  rose: "bg-rose-300/95 hover:bg-rose-300/95 dark:bg-rose-300 dark:hover:bg-rose-300",
  slate:
    "bg-slate-300/95 hover:bg-slate-300/95 dark:bg-slate-300 dark:hover:bg-slate-300",
};

const TAILWIND_GRADIENT_COLORS: Record<ColorToken, string> = {
  blue: "color-mix(in oklab, var(--color-sky-400) 85%, transparent)",
  indigo: "color-mix(in oklab, var(--color-indigo-400) 85%, transparent)",
  violet: "color-mix(in oklab, var(--color-violet-400) 85%, transparent)",
  teal: "color-mix(in oklab, var(--color-cyan-400) 85%, transparent)",
  green: "color-mix(in oklab, var(--color-emerald-400) 85%, transparent)",
  amber: "color-mix(in oklab, var(--color-amber-400) 85%, transparent)",
  orange: "color-mix(in oklab, var(--color-orange-400) 85%, transparent)",
  rose: "color-mix(in oklab, var(--color-rose-400) 85%, transparent)",
  slate: "color-mix(in oklab, var(--color-slate-400) 85%, transparent)",
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

export function categoryCellColorClasses(
  field: { category?: CategoryToken; color?: string | null } | null | undefined,
  selected = false,
): string {
  const token = tokenForCellClass(field);
  return selected
    ? FIELD_CELL_SELECTED_COLOR_CLASSES[token]
    : FIELD_CELL_COLOR_CLASSES[token];
}

export function categoryTailwindGradientColor(
  field: { category?: CategoryToken; color?: string | null } | null | undefined,
): string {
  const token = tokenForCellClass(field);
  return TAILWIND_GRADIENT_COLORS[token];
}
