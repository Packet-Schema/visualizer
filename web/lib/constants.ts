import type { CategoryToken, ColorToken } from "./types";

// Semantic category -> color token. When a field has a `category`, the
// renderer prefers the category's token over the legacy per-field `color`.
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

// Human-readable labels for the semantic categories used in the legend.
export const CATEGORY_LABELS: Record<CategoryToken, string> = {
  addressing: "Addressing",
  identifier: "Identifier / sequencing",
  length: "Length / size",
  type: "Type / protocol selector",
  flags: "Flags / control bits",
  reserved: "Reserved / padding",
  checksum: "Checksum / integrity",
  variable: "Variable-length options",
  "payload-marker": "Payload marker",
};

export const DEFAULT_BYTE_ORDER =
  "Network byte order (big-endian, MSB-first).";

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

/** Resolve a color token to its CSS variable; unknown strings pass through. */
export function tokenToCssVar(token: string | null | undefined): string {
  if (!token) return "var(--field-slate)";
  if (KNOWN_TOKENS.has(token as ColorToken)) return `var(--field-${token})`;
  return token;
}

// Curriculum-ordered grouping of presets by OSI layer. Wave 1 ships three.
export const PRESET_GROUPS: ReadonlyArray<{ label: string; keys: string[] }> = [
  { label: "Layer 2 — Link", keys: ["ethernet"] },
  { label: "Layer 3 — Network", keys: ["ipv4"] },
  { label: "Layer 4 — Transport", keys: ["tcp"] },
];

export const THEME_STORAGE_KEY = "packet-view-theme";
