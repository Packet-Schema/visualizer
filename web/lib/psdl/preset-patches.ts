// Visualizer-owned preset adaptations applied at the @packet-schema/presets
// ingestion boundary. These are SMALL, surgical rewrites the visualizer needs
// but cannot push upstream into the (read-only) `@packet-schema/presets`
// package. Applied by BOTH ingestion paths so server-computed and
// client-fetched packets stay byte-identical:
//   * `scripts/build-presets.ts`  — bakes `public/presets/<key>.json`
//   * `lib/psdl/presets.server.ts` — eager server registry
// Each patch must be idempotent and a no-op for every preset it does not name.
//
// The patches operate on the loosely-typed preset record (a plain JSON object)
// so the same code serves the build script (which has no PSDL types) and the
// typed server (which casts afterwards).

type JsonObj = Record<string, unknown>;

/**
 * kerberosAsReq: make the PA-DATA list's record count user-drivable.
 *
 * The `padataList` repeat's count is `ref(padataCount)`, and upstream
 * `padataCount` is a `virtual` with `expr: { kind: "lit", value: 1 }`. A
 * literal-valued virtual is recomputed to its fixed value by core's
 * `normalize` on every render (`walkVirtual` does `env.set(id, eval(expr))`),
 * so any override the OverridePanel writes to `env[padataCount]` is clobbered —
 * the user can SEE the rendered PA-DATA record but cannot add or remove records
 * (a see-but-cannot-edit gap; the only such preset of 184).
 *
 * Rewrite that expr to a SELF-ref (`ref(padataCount)`). walkVirtual then
 * evaluates `eval(ref(padataCount))` = `env[padataCount]` and writes it back
 * unchanged, so a stepper write SURVIVES the recompute and drives the diagram.
 * `psdlToRenderer` recognises self-ref virtuals (`collectSelfRefVirtualIds`)
 * and surfaces a count stepper keyed on `padataCount`, seeded to 1 so the
 * illustrative single PA-DATA record still shows on load. A bare self-ref also
 * stays valid: `evalExprOr` returns its fallback 0 (not a throw) when the env
 * key is unset, so an un-seeded render simply yields zero records.
 *
 * Only mutates a `padataCount` virtual that still carries the upstream literal
 * expr, so the patch is idempotent and inert against any future upstream shape.
 */
function patchKerberosAsReqPadataCount(preset: JsonObj): JsonObj {
  const body = preset.body;
  if (!Array.isArray(body)) return preset;
  let mutated = false;
  const newBody = body.map((container) => {
    if (!container || typeof container !== "object") return container;
    const c = container as JsonObj;
    if (c.kind !== "virtual" || c.id !== "padataCount") return container;
    const expr = c.expr as JsonObj | undefined;
    if (!expr || expr.kind !== "lit") return container;
    mutated = true;
    return { ...c, expr: { kind: "ref", field: "padataCount" } };
  });
  if (!mutated) return preset;
  return { ...preset, body: newBody };
}

/**
 * Apply every visualizer-owned preset patch in turn. Returns the input
 * unchanged for any preset no patch names. Pure and idempotent.
 */
export function applyPresetPatches(key: string, preset: JsonObj): JsonObj {
  if (key === "kerberosAsReq") {
    return patchKerberosAsReqPadataCount(preset);
  }
  return preset;
}
