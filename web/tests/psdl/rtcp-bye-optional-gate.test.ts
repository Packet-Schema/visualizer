// override-audit (rtcpBye): the BYE packet has two `optional` containers.
//   * body/4 wraps `rtcpByeHasReason` (an 8-bit count) with a COMPLEX
//     when-expr `((length+1)*4-4-4) > rtcpByeSrcCount*4`.
//   * body/5 wraps `rtcpByeReason` (`bytes(ref rtcpByeHasReason)`) with the
//     SIMPLE gate `when: ref(rtcpByeHasReason)`.
//
// The old `attachOverrideMetadata` fell back to the complex when-expr's first
// ref (`length`, the RTCP 32-bit word count) and stamped a Present/Absent
// toggle on it whose onChange wrote `env['length']=0|1` — corrupting the whole
// packet, with no intuitive mapping to the reason field's presence. Meanwhile
// `rtcpByeHasReason` lives inside an Optional (so it is not a top-level mirror
// cell) and never surfaced any control even though it BOTH gates AND sizes the
// reason string — a see-but-cannot-edit cell.
//
// After the fix:
//   * `length` carries NO `optionalGateFor` (no destructive toggle).
//   * `rtcpByeHasReason` surfaces as a packet-level length controller whose
//     slider both reveals and sizes the reason string through core normalize.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

function reasonCells(
  psdl: PsdlPacket,
  overrides: Record<string, number>,
): { id: string; bits: number }[] {
  const env = new Map<string, number>(Object.entries(overrides));
  for (const [k, v] of initialEnv(psdl)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  return resolveLayout(psdl, { env })
    .cells.filter((c) => /reason/i.test(c.field.id))
    .map((c) => ({ id: c.field.id, bits: c.bitsTotal }));
}

describe("rtcpBye optional-gate surfacing", () => {
  const psdl = PRESETS["rtcpBye"];
  const mirror = psdlToRenderer(psdl);

  it("does NOT stamp optionalGateFor from a complex when-expr (length stays clean)", () => {
    const length = mirror.fields.find((f) => f.id === "length");
    expect(length).toBeDefined();
    expect(length?.optionalGateFor).toBeUndefined();
    // No top-level OR subfield cell should carry a gate for the reason — the
    // complex gate must not surface a Present/Absent toggle anywhere.
    const everyGate = [
      ...mirror.fields.flatMap((f) => f.optionalGateFor ?? []),
      ...mirror.fields.flatMap((f) =>
        (f.subfields ?? []).flatMap((s) => s.optionalGateFor ?? []),
      ),
    ];
    expect(everyGate).toHaveLength(0);
  });

  it("surfaces rtcpByeHasReason as an editable length controller", () => {
    const lc = (mirror.lengthControllers ?? []).find(
      (c) => c.id === "rtcpByeHasReason",
    );
    expect(lc).toBeDefined();
    expect(lc?.controlsLength).toBe("rtcpByeHasReason");
    // 8-bit count → slider max 255.
    expect(lc?.max).toBe(255);
    // rtcpByeHasReason is not (and must not be promoted to) a top-level cell.
    expect(mirror.fields.some((f) => f.id === "rtcpByeHasReason")).toBe(false);
  });

  it("the length controller both gates and sizes the reason string", () => {
    // At 0 the reason is gated off — only the count octet shows.
    const at0 = reasonCells(psdl, {
      rtcpByeSrcCount: 0,
      length: 1,
      rtcpByeHasReason: 0,
    });
    expect(at0.map((c) => c.id)).toEqual(["rtcpByeHasReason"]);

    // Raising the slider reveals the reason AND sizes it to N bytes.
    const at4 = reasonCells(psdl, {
      rtcpByeSrcCount: 0,
      length: 1,
      rtcpByeHasReason: 4,
    });
    const reason = at4.find((c) => c.id === "rtcpByeReason");
    expect(reason).toBeDefined();
    expect(reason?.bits).toBe(32);
  });
});
