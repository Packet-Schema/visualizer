// coap: each `options` record (the top-level until-peek repeat, surfaced as a
// freeRepeat) contains a group `optHeaderByte` whose 4-bit `optLength` field
// sizes the record's `optValue = bytes(ref optValueBytes)` — where
// `optValueBytes` is a VIRTUAL derived from `optLength` (and its 13/14
// extensions). The mirror's top-level `fields` are only the fixed-header cells
// (coapHeader/codeByte/messageId/token); `optHeaderByte` is collapsed and
// `optLength` was neither a top-level cell, a subfield slider, nor a length
// controller. The peek picker that IS surfaced (`__peek__0__8`) only selects the
// option-delta/length extension arm, not the value byte count — so the user saw
// the `optHeaderByte#0`/`optValue#0` cells but had NO way to grow/shrink the
// option value (see-but-cannot-edit).
//
// The fix follows the virtual `optValueBytes` back to its real driver
// (`optLength`) in collectPlainRepeatLengthControllers, surfacing `optLength` as
// a packet-level length controller keyed on `env[optLength]`.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

function cellIds(
  psdl: PsdlPacket,
  overrides: Record<string, number>,
): string[] {
  const env = new Map<string, number>(Object.entries(overrides));
  for (const [k, v] of initialEnv(psdl)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  return resolveLayout(psdl, { env }).cells.map((c) => c.field.id);
}

describe("coap: option value length (optLength) is editable", () => {
  it("surfaces optLength as a length controller keyed on env[optLength]", () => {
    const mirror = psdlToRenderer(PRESETS.coap!);

    const optLen = (mirror.lengthControllers ?? []).find(
      (lc) => lc.id === "optLength",
    );
    expect(optLen).toBeTruthy();
    // The controller drives the env key the diagram actually reads.
    expect(optLen!.controlsLength).toBe("optLength");
    // A 4-bit nibble — the literal Option Length range 0..15.
    expect(optLen!.bits).toBe(4);
    expect(optLen!.max).toBe(15);

    // The option record IS instantiable (the `options` until-peek repeat is a
    // freeRepeat with a count stepper), which is what makes the per-record
    // length controller meaningful rather than moot.
    expect(
      (mirror.freeRepeats ?? []).some((r) => r.countKey === "options"),
    ).toBe(true);
  });

  it("raising optLength grows the optValue#0 cell count", () => {
    const src = PRESETS.coap!;

    // optLength=0 → no Option Value cell (a zero-byte option value).
    const at0 = cellIds(src, { options: 1, optLength: 0 });
    expect(at0).toContain("optHeaderByte#0");
    expect(at0.filter((id) => id === "optValue#0")).toHaveLength(0);

    // optLength=3 → the Option Value appears (3 bytes → one 32-bit cell).
    const at3 = cellIds(src, { options: 1, optLength: 3 });
    expect(at3.filter((id) => id === "optValue#0").length).toBeGreaterThan(0);

    // optLength=7 → strictly more Option Value cells than optLength=3, proving
    // the surfaced controller genuinely sizes the visible region.
    const at7 = cellIds(src, { options: 1, optLength: 7 });
    expect(at7.filter((id) => id === "optValue#0").length).toBeGreaterThan(
      at3.filter((id) => id === "optValue#0").length,
    );
  });
});
