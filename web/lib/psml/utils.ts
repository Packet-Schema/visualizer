// PSML — shared structural utilities.
//
// Type guards and tiny helpers reused across normalize / validate /
// psml-to-renderer. Keeping them here avoids three copies of `isField`
// drifting apart.

import type { Container, Field } from "./types";

/**
 * True if a Container node is a plain Field. The Container union uses a
 * discriminated tag (`kind`) on every compound variant; a Field omits the
 * tag entirely (or carries `kind === "field"` from PSML 0.4+).
 */
export function isField(c: Container): c is Field {
  return !("kind" in c) || c.kind === "field";
}
