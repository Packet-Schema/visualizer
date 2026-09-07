// Extracted from `index.ts` (PSDL → renderer adapter) — no logic changes.

import { isField } from "../utils";
import type { Container, NamedStruct } from "../types";

/**
 * Flatten PSDL 0.5 transparent scope containers (`bounded`, resolved `ref`)
 * into an inline container list for the renderer mirror. The mirror cares
 * about override targets and TLV/chain catalogs, not wire scoping, so a
 * `bounded` region (e.g. IPv4's `optionsArea` wrapping the options Repeat) is
 * spliced inline just like a `group`'s children. `align` / `virtual` carry no
 * override surface and are dropped. Nested transparent scopes flatten
 * recursively; an unresolvable `ref` is skipped.
 */
export function flattenForMirror(
  containers: Container[],
  defs?: Record<string, NamedStruct>,
  seen: Set<string> = new Set(),
): Container[] {
  const out: Container[] = [];
  for (const c of containers) {
    if (!isField(c) && c.kind === "bounded") {
      out.push(...flattenForMirror(c.fields, defs, seen));
    } else if (!isField(c) && c.kind === "ref") {
      if (seen.has(c.ref)) continue;
      const def = defs?.[c.ref];
      if (def) {
        seen.add(c.ref);
        out.push(...flattenForMirror(def.fields, defs, seen));
        seen.delete(c.ref);
      }
    } else if (!isField(c) && (c.kind === "align" || c.kind === "virtual")) {
      // no renderer-mirror representation
    } else {
      out.push(c);
    }
  }
  return out;
}

/**
 * Top-level {@link flattenForMirror} variant that QUALIFIES the ids of fields it
 * inlines from a `ref`'s def, matching the `<refId>.<fieldId>` cell-id scheme
 * core's normalize emits for ref-expanded content (normalize.js `emitId`). Two
 * sibling `ref`s to the SAME def (`body: [ref addr as src, ref addr as dst]`)
 * would otherwise produce duplicate mirror field ids (`a1, a2, a1, a2`) while the
 * diagram cells are distinct (`src.a1, dst.a1`), so every `mirror.fields.find`
 * editor lookup (TLV routing, byteOrder, merge) resolves the SECOND ref instance
 * onto the FIRST — the second ref becomes see-but-cannot-edit and its edits
 * collide onto the shared def. Prefixing each inlined container's id with the
 * ref's id gives each ref instance a unique mirror field; merge/export
 * ({@link mergeInstancesIntoPsdl}, {@link applyTlvInstances}) map the qualified id
 * back to the correct ref instance's def copy.
 *
 * Only `ref`-resolved content is prefixed; body-level fields and transparent
 * `bounded`/`group` scopes at the top level keep their bare ids (no behaviour
 * change for the single-ref / no-ref presets). `prefix` accumulates across nested
 * refs (`outer.inner.field`), mirroring normalize's idPrefix threading.
 */
export function flattenForMirrorQualified(
  containers: Container[],
  defs: Record<string, NamedStruct> | undefined,
  prefix: string,
  seen: Set<string> = new Set(),
): Container[] {
  const out: Container[] = [];
  const qualify = (c: Container): Container =>
    prefix && "id" in c && c.id != null
      ? ({ ...c, id: `${prefix}${c.id}` } as Container)
      : c;
  for (const c of containers) {
    if (!isField(c) && c.kind === "bounded") {
      out.push(...flattenForMirrorQualified(c.fields, defs, prefix, seen));
    } else if (!isField(c) && c.kind === "ref") {
      if (seen.has(c.ref)) continue;
      const def = defs?.[c.ref];
      if (def) {
        seen.add(c.ref);
        // Qualify the inlined def fields with `<refId>.` (appended to any
        // outer prefix), matching the cell-id scheme. The ref's OWN id — not
        // the def's id — is the qualifier, so two refs to one def stay
        // distinct even though they share the def.
        out.push(
          ...flattenForMirrorQualified(
            def.fields,
            defs,
            `${prefix}${c.id}.`,
            seen,
          ),
        );
        seen.delete(c.ref);
      }
    } else if (!isField(c) && (c.kind === "align" || c.kind === "virtual")) {
      // no renderer-mirror representation
    } else {
      out.push(qualify(c));
    }
  }
  return out;
}

/**
 * Path-guarded {@link flattenForMirror} for the recursive `visit`/`walk`
 * collectors that flatten a scope and then descend INTO the flattened output
 * (into an `optional` container, switch case, repeat element, …). Those
 * descents re-flatten — and thus re-resolve — a `ref` on every recursion, so a
 * self/mutually recursive `defs` reference (DNS name-compression, ASN.1
 * nesting, LISP — the standard `optional{ref self}` idiom) recurses forever
 * (RangeError). `refPath` records the ref-def names resolved on the CURRENT
 * descent path; a `ref` already on it is dropped before flattening, and the
 * names this call newly resolved are returned so the caller releases them once
 * its recursion unwinds. Mirrors `mergeRefDef`'s `outDefs` cycle guard. A def
 * referenced twice as SIBLINGS (a legitimate diamond) is unaffected — it is
 * released between the two visits, never simultaneously on the path.
 */
export function flattenForMirrorGuarded(
  containers: Container[],
  defs: Record<string, NamedStruct> | undefined,
  refPath: Set<string>,
): { items: Container[]; release: () => void } {
  const added: string[] = [];
  const filtered = containers.filter((c) => {
    if (isField(c) || c.kind !== "ref") return true;
    if (refPath.has(c.ref)) return false;
    if (defs?.[c.ref]) {
      refPath.add(c.ref);
      added.push(c.ref);
    }
    return true;
  });
  return {
    items: flattenForMirror(filtered, defs),
    release: () => {
      for (const r of added) refPath.delete(r);
    },
  };
}
