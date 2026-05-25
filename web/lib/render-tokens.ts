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
