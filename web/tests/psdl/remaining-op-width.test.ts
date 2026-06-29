// override-design-audit (high): a `bytes(remaining - k)` payload (an OP-wrapped
// remaining, not the bare `bytes(remaining)`) was see-but-cannot-edit. The
// renderer / layout / seed all detected ONLY a bare `n.kind === "remaining"`, so
// an op/cond-wrapped remaining (ppp `information` = `remaining-2`, quicLong
// `retryToken` = `remaining-16`, ipsecEsp `payloadData` = `remaining-2`, amt
// `amtMqData` = `cond(... remaining-18 ... remaining)`) got NO `isRemaining`
// flag, NO `__remainingBytes__<id>` seed and was ignored by the budget reader:
// the field rendered (core sized it from the real packet budget) but the user
// had ZERO control to grow / shrink it — a bar-#1 see-but-cannot-edit violation
// that also broke edit/round-trip for any PSDL using `remaining - k` (bar #2).
//
// Fix: a shared `isRemainingSizedBytes` detector recognizes any `bytes` whose
// `n` is an Expr CONTAINING a `remaining` node (bare or op/cond-wrapped) and is
// wired through every detection site (mirror `isRemaining` flag / nested
// dynamic-width leaves, layout `collectDynamicWidthFlags`, the seed's
// `collectRemainingFieldIds`). `resolveLayout` then CALIBRATES the variable
// region so the user's chosen byte count lands on the FIELD (a `remaining - k`
// or fixed-trailing-sibling payload renders a constant offset from the raw
// region; the region→field map has slope 1, so one corrective pass is exact).
//
// This test pins: (1) ppp `information` / quicLong `retryToken` are tagged
// isRemaining and surfaced for seeding; (2) their `__remainingBytes__<id>`
// override is MOVABLE — a chosen byte count drives the rendered cell width; (3)
// ppp's width lands exactly on the field; (4) the seed default still renders a
// representative cell.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { initialState } from "@/lib/psdl/renderer-helpers";
import {
  REMAINING_DEFAULT_BYTES,
  remainingBytesEnvKey,
  collectRemainingFieldIds,
  isRemainingSizedBytes,
} from "@/lib/psdl/dynamic-width-defaults";
import type { Packet as PsdlPacket, Type } from "@/lib/psdl/types";

/** Load-time env exactly as PacketViewer builds it (mirror seeds, then preset
 *  defaults, then a 0 fallback for every ref), plus test overrides. */
function loadEnv(
  src: PsdlPacket,
  overrides: Record<string, number> = {},
): Map<string, number> {
  const mirror = psdlToRenderer(src);
  const env = new Map<string, number>(
    Object.entries(initialState(mirror)).map(([k, v]) => [k, Number(v)]),
  );
  for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
  for (const [k, v] of Object.entries(overrides)) env.set(k, v);
  return env;
}

/** Resolved wire bits of a leaf (read from the first matching segment cell). */
function leafBits(
  src: PsdlPacket,
  leafId: string,
  overrides: Record<string, number> = {},
): number {
  const { cells } = resolveLayout(src, { env: loadEnv(src, overrides) });
  for (const c of cells) {
    if (c.field.id.replace(/#.*$/, "") === leafId) return c.field.bits ?? -1;
    for (const s of c.subCells ?? []) {
      if (s.subfield.id.replace(/#.*$/, "") === leafId)
        return s.subfield.bits ?? -1;
    }
  }
  return -1;
}

describe("bytes(remaining - k) payload width is editable", () => {
  it("detects an op/cond-wrapped remaining as remaining-sized", () => {
    const bare: Type = { kind: "bytes", n: { kind: "remaining" } };
    const minusK: Type = {
      kind: "bytes",
      n: {
        kind: "op",
        op: "-",
        a: { kind: "remaining" },
        b: { kind: "lit", value: 2 },
      },
    } as unknown as Type;
    const condArm: Type = {
      kind: "bytes",
      n: {
        kind: "cond",
        test: { kind: "ref", field: "g" },
        t: {
          kind: "op",
          op: "-",
          a: { kind: "remaining" },
          b: { kind: "lit", value: 18 },
        },
        f: { kind: "remaining" },
      },
    } as unknown as Type;
    const fixedBytes: Type = { kind: "bytes", n: { kind: "lit", value: 16 } };
    const delimited: Type = {
      kind: "bytes",
      n: { delimiter: [0] },
    } as unknown as Type;

    expect(isRemainingSizedBytes(bare)).toBe(true);
    expect(isRemainingSizedBytes(minusK)).toBe(true);
    expect(isRemainingSizedBytes(condArm)).toBe(true);
    // A fixed-count / delimited `bytes` is NOT remaining-sized — and the
    // delimited descriptor (no `kind`) must not crash the expr walk.
    expect(isRemainingSizedBytes(fixedBytes)).toBe(false);
    expect(isRemainingSizedBytes(delimited)).toBe(false);
  });

  it("tags ppp.information (remaining-2) and surfaces a movable width control", () => {
    const src = PRESETS.ppp!;
    const key = remainingBytesEnvKey("information");

    // Collected as a rendered remaining payload (drives the budget) + tagged on
    // the mirror field so OverridePanel renders the byte-count WidthPicker.
    expect(collectRemainingFieldIds(src).has("information")).toBe(true);
    const mirror = psdlToRenderer(src);
    expect(mirror.fields.find((f) => f.id === "information")?.isRemaining).toBe(
      true,
    );
    // initialState seeds the dedicated budget key so the picker's active option
    // agrees with the seeded diagram tail.
    expect(initialState(mirror)[key]).toBe(REMAINING_DEFAULT_BYTES);

    // Seed renders a representative cell; the override is MOVABLE and (because
    // ppp's `-2` cancels its trailing fcs) lands exactly on the field.
    expect(leafBits(src, "information")).toBe(REMAINING_DEFAULT_BYTES * 8);
    expect(leafBits(src, "information", { [key]: 8 })).toBe(8 * 8);
    expect(leafBits(src, "information", { [key]: 16 })).toBe(16 * 8);
    // 0 bytes collapses the tail to no rendered cell (a valid empty payload).
    expect(leafBits(src, "information", { [key]: 0 })).toBe(-1);
  });

  it("tags quicLong.retryToken (remaining-16, Retry arm) and makes it movable", () => {
    const src = PRESETS.quicLong!;
    const key = remainingBytesEnvKey("retryToken");
    // longPacketType=3 selects the Retry arm where retryToken renders.
    const arm = { longPacketType: 3 };

    expect(collectRemainingFieldIds(src).has("retryToken")).toBe(true);
    const leaf = (psdlToRenderer(src).dynamicWidthLeaves ?? []).find(
      (l) => l.id === "retryToken",
    );
    expect(leaf?.kind).toBe("remaining");

    // The control is MOVABLE: raising the chosen byte count strictly grows the
    // rendered cell (was completely inert — every value stayed the same width).
    const small = leafBits(src, "retryToken", { ...arm, [key]: 8 });
    const large = leafBits(src, "retryToken", { ...arm, [key]: 64 });
    expect(large).toBeGreaterThan(small);
    // A large pick lands exactly on the field (above the trailing-tag floor).
    expect(leafBits(src, "retryToken", { ...arm, [key]: 64 })).toBe(64 * 8);
  });
});
