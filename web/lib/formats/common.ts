// Shared helpers across format adapters.
//
// Each format (KSY, AAD, JSON, RFC ASCII) needs a few of the same small
// utilities: turn a human field name into an identifier, prettify an
// identifier back into a label, and merge a free-text doc with one or
// more reference URLs. Centralizing them keeps the rewrites in lock-step
// and avoids three implementations slowly drifting apart.

/**
 * Lower-case, ASCII-only, underscore-separated identifier. Used by both
 * KSY (`toKsyId`) and AAD (`makeId`) exporters. Empty input falls back to
 * `fallback`.
 */
export function sanitizeId(name: string, fallback = "field"): string {
  const out = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return out.length > 0 ? out : fallback;
}

/**
 * Title-case a snake_case / kebab-case identifier for display. Used by the
 * KSY importer when a field has no explicit name. Trims and collapses
 * whitespace as a side effect.
 */
export function humanize(id: string): string {
  return id
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Combine a free-text `doc` string with one or more `docRef` URLs into the
 * paragraph form used by the renderer's description field.
 *
 * Mirrors KSY's `composeDescription` so importers from other formats can
 * produce the same shape without re-implementing the loop.
 */
export function composeDescription(
  doc: unknown,
  docRef: unknown,
): string | undefined {
  const parts: string[] = [];
  if (typeof doc === "string" && doc.trim().length > 0) parts.push(doc.trim());
  if (Array.isArray(docRef)) {
    for (const r of docRef) {
      if (typeof r === "string" && r.trim().length > 0) {
        parts.push(`See: ${r.trim()}`);
      }
    }
  } else if (typeof docRef === "string" && docRef.trim().length > 0) {
    parts.push(`See: ${docRef.trim()}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
