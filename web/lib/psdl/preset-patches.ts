// The @packet-schema/presets ingestion boundary: `adaptPreset` (below) is the
// ONE way a upstream preset becomes a visualizer `Packet`, and the patches it
// applies are SMALL, surgical rewrites the visualizer needs but cannot push
// upstream into the (read-only) `@packet-schema/presets` package.
//
// Every ingestion path goes through `adaptPreset` so server-computed and
// client-fetched packets stay byte-identical:
//   * `scripts/build-presets.ts`  — bakes `public/presets/<key>.json`
//   * `lib/psdl/presets.server.ts` — eager server registry
//
// This module deliberately does NOT import `server-only`: the build script runs
// outside Next, so anything both paths share has to live somewhere the script
// can import.
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

/**
 * Adapt one upstream preset into a visualizer packet: fill the `rowBits`
 * invariant from `rendererHints.rowBits` (or a 32-bit default), then apply the
 * patches above.
 *
 * This existed as three byte-identical copies — `presets.server.ts`,
 * `scripts/build-presets.ts` and one test — each carrying a "MUST stay in sync
 * with" comment. They were in sync, but nothing enforced it, and a drift would
 * have desynchronised the server registry from the JSON the client fetches:
 * the same preset rendering differently depending on which path loaded it.
 *
 * Kept on the loosely-typed record (a plain JSON object) so the build script,
 * which has no PSDL types, can call it too; typed callers cast the result.
 */
export function adaptPreset(key: string, preset: JsonObj): JsonObj {
  const rendererHints = preset.rendererHints as
    | { rowBits?: number }
    | undefined;
  const rowBits =
    (preset.rowBits as number | undefined) ?? rendererHints?.rowBits ?? 32;
  return applyPresetPatches(key, { ...preset, rowBits });
}
