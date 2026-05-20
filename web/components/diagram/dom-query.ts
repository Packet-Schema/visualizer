// Shared DOM query helpers for the diagram surface.
//
// The hybrid renderer tags every cell, sub-cell and hex byte with
// `data-field-id`. Multiple components (DependencyOverlay, FieldPopover,
// useFieldHighlight, PacketViewer navigation) need to query that surface in
// closely related but slightly different shapes. Putting the selectors here
// keeps the escaping rules and `#repeatIndex` handling in one place.

/**
 * `CSS.escape` polyfill — jsdom doesn't ship one, so we mirror the MDN
 * implementation closely enough that our selectors stay valid against any
 * id `validatePsmlPacket` accepts. The earlier replace-list missed
 * whitespace / control characters (PSML ids are validated as non-empty
 * strings, so a newline is technically legal), which made
 * `querySelector(All)` throw a `DOMException: invalid selector` whenever
 * such an id reached the diagram (Copilot review).
 *
 * The browser path is preferred when present.
 */
function escapeSelectorValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  // Polyfill modelled on the MDN `CSS.escape` algorithm. We don't need
  // the full numeric-prefix / first-character special cases because our
  // ids are prefixed by `data-field-id="…"` (attribute selector form),
  // but we do need to handle every code unit that would otherwise be
  // parsed as a delimiter — including whitespace, control chars, and
  // every ASCII punctuation glyph.
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0) {
      // U+0000 must escape to U+FFFD per the spec.
      out += "�";
      continue;
    }
    if (
      // C0 controls and DEL.
      (code >= 0x01 && code <= 0x1f) ||
      code === 0x7f
    ) {
      out += `\\${code.toString(16)} `;
      continue;
    }
    if (
      // ASCII alphanumerics + underscore + hyphen pass through.
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      code === 0x5f ||
      code === 0x2d ||
      code >= 0x80
    ) {
      out += ch;
      continue;
    }
    if (ch === "\\") {
      // Explicit backslash branch: emit the literal two-character
      // escape `\\` so the rendered attribute selector matches a
      // single backslash without leaving the closing quote stranded
      // (Copilot review flagged the template-literal form below as
      // ambiguous when `ch` is itself a backslash).
      out += "\\\\";
      continue;
    }
    // Any other ASCII (space, punctuation, control) gets a single
    // backslash prefix per the spec's character-escape branch.
    out += `\\${ch}`;
  }
  return out;
}

/**
 * Selector for cells whose own id matches `fieldId` exactly. Use when you
 * have a specific field/sub-field instance and need its visible cells.
 */
export function fieldIdSelector(fieldId: string): string {
  return `[data-field-id="${escapeSelectorValue(fieldId)}"]`;
}

/**
 * Selector for synthesised Repeat copies (`type#0`, `type#1`, …) that the
 * normalize step emits when a Field is wrapped in a Repeat. Walks the
 * `${fieldId}#…` namespace.
 */
export function repeatedFieldIdSelector(fieldId: string): string {
  return `[data-field-id^="${escapeSelectorValue(fieldId)}#"]`;
}

/**
 * Selector that matches both the field cell and any repeated copies.
 * Equivalent to `fieldIdSelector(fieldId), repeatedFieldIdSelector(fieldId)`.
 */
export function fieldIdAndRepeatsSelector(fieldId: string): string {
  return `${fieldIdSelector(fieldId)}, ${repeatedFieldIdSelector(fieldId)}`;
}

/**
 * Selector that also lights up the parent field cell when `fieldId` is a
 * sub-field (`parent:sub`). The hex strip and the hover highlighter both
 * use this so a sub-field hover lights the containing field too.
 */
export function highlightSelector(fieldId: string): string {
  const parentId = fieldId.includes(":") ? fieldId.split(":")[0] : null;
  if (!parentId) return fieldIdSelector(fieldId);
  return `${fieldIdSelector(fieldId)}, .field-cell${fieldIdSelector(parentId)}`;
}
