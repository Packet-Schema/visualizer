// Shared DOM query helpers for the diagram surface.
//
// The hybrid renderer tags every cell, sub-cell and hex byte with
// `data-field-id`. Multiple components (DependencyOverlay, FieldPopover,
// useFieldHighlight, PacketViewer navigation) need to query that surface in
// closely related but slightly different shapes. Putting the selectors here
// keeps the escaping rules and `#repeatIndex` handling in one place.

/**
 * Selector for cells whose own id matches `fieldId` exactly. Use when you
 * have a specific field/sub-field instance and need its visible cells.
 */
export function fieldIdSelector(fieldId: string): string {
  return `[data-field-id="${CSS.escape(fieldId)}"]`;
}

/**
 * Selector for synthesised Repeat copies (`type#0`, `type#1`, …) that the
 * normalize step emits when a Field is wrapped in a Repeat. Walks the
 * `${fieldId}#…` namespace.
 */
export function repeatedFieldIdSelector(fieldId: string): string {
  return `[data-field-id^="${CSS.escape(fieldId)}#"]`;
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
