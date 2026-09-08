// Regression: AMT Membership Query (`amt`, amtType=4) gates the trailing
// Gateway Endpoint block (`optional{group: amtMqGateway}`) on the 1-bit `amtMqG`
// flag. `amtMqG` is a plain `int` field declared DIRECTLY inside the amtType
// case-4 Switch struct — not wrapped in a Group — so `findOrSurfaceGateTarget`'s
// `findTarget` (top-level field / Group subfield) and `groupOwning` fallback
// BOTH returned null and stamped no `optionalGateFor`. The user could SEE the
// `G` cell and watch 5 Gateway cells (Port + IPv6 address) appear/disappear, but
// had no control to toggle it — a see-but-cannot-edit dead end.
//
// amt is the ONLY preset with an Optional gated by a plain ref directly inside a
// Switch case (no group). The fix lazily promotes such a switch-case leaf gate
// to a top-level mirror field carrying `optionalGateFor`, so OverridePanel can
// render an OptionalToggle keyed on env['amtMqG'].

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import type { Packet } from "@/lib/psdl/types";

const amt = (): Packet => PRESETS.amt as Packet;

describe("amt: Membership Query G flag (amtMqG) gate is controllable", () => {
  it("surfaces amtMqG as a top-level mirror field carrying optionalGateFor", () => {
    const mirror = psdlToRenderer(amt());

    const g = mirror.fields.find((f) => f.id === "amtMqG");
    expect(g).toBeDefined();
    // It must carry a Present/Absent toggle (optionalGateFor names the gated
    // container, the Gateway Endpoint group).
    expect(g?.optionalGateFor ?? []).not.toHaveLength(0);
    // It is NOT also a discriminator (no switchCases collision) and not a
    // dynamic-width picker — just the gate.
    expect(g?.switchCases).toBeUndefined();
    expect(g?.varintEncoding).toBeUndefined();
    expect(g?.isBerLength).toBeUndefined();
  });

  it("toggling env['amtMqG'] materializes the amtMqGateway* cells", () => {
    const ids = (g: number): string[] =>
      resolveLayout(amt(), {
        env: new Map(Object.entries<number>({ amtType: 4, amtMqG: g })),
      }).cells.map((c) => c.field.id);

    const off = ids(0);
    const on = ids(1);

    // G=0: no Gateway Endpoint cells.
    expect(off.some((id) => id.startsWith("amtMqGateway"))).toBe(false);
    // G=1: the Gateway Endpoint group cells appear.
    expect(on.some((id) => id.startsWith("amtMqGateway"))).toBe(true);
    // Raising G shrinks the Encapsulated Query (more total cells overall).
    expect(on.length).toBeGreaterThan(off.length);
  });
});
