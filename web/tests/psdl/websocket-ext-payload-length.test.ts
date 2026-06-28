// override-audit: websocketFrame's top-level switch `byPayloadLength7` inserts
// an Extended Payload Length field — case 126 → 16-bit `extPayloadLength16`,
// case 127 → 64-bit `extPayloadLength64`, default → nothing — yet the mirror
// surfaced ZERO control. The discriminator `payloadLength7` is 7-bit AND nested
// inside the `wsByte2` group (no top-level cell to host a `switchCases` widget),
// and `collectRefSwitches`' encoder gate suppressed it twice over: `payloadLength7`
// is `lengthDriving` (the trailing `payload` width reads it) and it is sub-byte
// with `category:"length"` arms. So an imported 126/127 frame rendered an
// Extended-Length cell the user could SEE but never toggle off or reach — a
// see-but-cannot-edit gap (bar #1).
//
// Fix: a TOP-LEVEL (non-repeat) group/case-nested length-extension switch whose
// arms add fixed-width Extended-Length cells of STRUCTURALLY DISTINCT WIDTH
// (16 vs 64 vs empty) is exempt from the encoder suppression and surfaces a
// packet-level refSwitch keyed on `env[payloadLength7]` (cases 126/127 + a
// synthetic default that reaches the empty `_` arm). The repeat-nested CoAP /
// BGP length encoders keep their suppression untouched.

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
  return resolveLayout(psdl, { env }).cells.flatMap((c) => [
    c.field.id,
    ...(c.subCells ?? []).map((s) => s.subfield.id),
  ]);
}

describe("websocketFrame Extended Payload Length switch", () => {
  const psdl = PRESETS["websocketFrame"] as PsdlPacket;

  it("surfaces a packet-level refSwitch on payloadLength7", () => {
    const mirror = psdlToRenderer(psdl);
    const rs = mirror.refSwitches?.find((r) => r.refKey === "payloadLength7");
    expect(rs).toBeDefined();
    const values = new Set(rs!.cases.map((c) => c.value));
    // The two RFC-defined magic values…
    expect(values.has(126)).toBe(true);
    expect(values.has(127)).toBe(true);
    // …plus a synthetic option that reaches the empty `_` default arm (so the
    // extended cell can be toggled OFF), landing on neither 126 nor 127.
    expect(rs!.cases.length).toBe(3);
    const synthetic = rs!.cases.find((c) => c.value !== 126 && c.value !== 127);
    expect(synthetic).toBeDefined();
  });

  it("the discriminator is NOT classified as a length/format encoder", () => {
    const mirror = psdlToRenderer(psdl);
    // It must not silently collapse to a length-controller or be dropped: the
    // only surfaced control for it is the refSwitch picker above.
    expect(
      mirror.lengthControllers?.some((l) => l.id === "payloadLength7") ?? false,
    ).toBe(false);
  });

  it("selecting 126/127/default flips the Extended Length cell on the diagram", () => {
    const extCells = (overrides: Record<string, number>) =>
      cellIds(psdl, overrides).filter((id) =>
        id.startsWith("extPayloadLength"),
      );

    // Default (0..125): no Extended Length field.
    expect(extCells({})).toEqual([]);
    expect(extCells({ payloadLength7: 0 })).toEqual([]);

    // 126 → the 16-bit Extended Length.
    expect(extCells({ payloadLength7: 126 })).toContain("extPayloadLength16");
    expect(extCells({ payloadLength7: 126 })).not.toContain(
      "extPayloadLength64",
    );

    // 127 → the 64-bit Extended Length.
    expect(extCells({ payloadLength7: 127 })).toContain("extPayloadLength64");
    expect(extCells({ payloadLength7: 127 })).not.toContain(
      "extPayloadLength16",
    );
  });

  it("the refSwitch's synthetic default value selects the empty (no extended length) arm", () => {
    const mirror = psdlToRenderer(psdl);
    const rs = mirror.refSwitches!.find((r) => r.refKey === "payloadLength7")!;
    const synthetic = rs.cases.find((c) => c.value !== 126 && c.value !== 127)!;
    const ext = cellIds(psdl, { payloadLength7: synthetic.value }).filter(
      (id) => id.startsWith("extPayloadLength"),
    );
    expect(ext).toEqual([]);
  });
});
