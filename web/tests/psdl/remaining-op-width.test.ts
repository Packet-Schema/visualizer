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

// bar #1 (see-but-cannot-edit, CRITICAL): ipsecEsp rendered a fully BLANK,
// uneditable diagram on first paint. Its encrypted scope `espEncrypted` declares
// `wireBits = (remaining - icvLen) * 8`; at the app's default env (no packet-size
// override) `remaining` resolves to 0, so the scope width collapses to 0 bits
// while the plaintext minimum (padLength 8b + nextHeader 8b = 16b) still has to
// fit. core's normalize then threw `encrypted scope over-consumed`, PacketViewer's
// resolveLayout try/catch fell back to the last-good layout — but on FIRST paint
// that is null, so the diagram came out EMPTY: every field (SPI, Sequence Number,
// Encrypted Region, ICV) was invisible and uneditable. It is the only preset whose
// encrypted scope wireBits depends on packet-level `remaining` (quicLong/quicShort
// use literal scope wireBits and always rendered).
//
// Fix (visualizer-only, in `normalizeWithBudget`'s fixed-prefix measurement): the
// fixed prefix used to be measured at `totalBits: 0`, which over-consumes for such
// a scope. We now grow the trial budget until normalize accepts it, so the fixed
// prefix is measured correctly and the variable region (the seeded default, or a
// `__remainingBytes__<id>` override) is added on top. The diagram renders a full,
// editable packet at default env, and the encrypted payload's byte-count picker is
// movable like any other remaining-sized tail.
// The encrypted payload only expands to an individual cell in SEMANTIC view
// (wire view collapses the whole encrypted scope to one virtual field), so read
// its width with the viewMode pinned rather than `leafBits`' wire default.
function semanticLeafBits(
  src: PsdlPacket,
  leafId: string,
  overrides: Record<string, number> = {},
): number {
  const { cells } = resolveLayout(src, {
    env: loadEnv(src, overrides),
    viewMode: "semantic",
  });
  for (const c of cells) {
    if (c.field.id.replace(/#.*$/, "") === leafId) return c.field.bits ?? -1;
    for (const s of c.subCells ?? []) {
      if (s.subfield.id.replace(/#.*$/, "") === leafId)
        return s.subfield.bits ?? -1;
    }
  }
  return -1;
}

describe("ipsecEsp encrypted scope sized by remaining renders + is editable", () => {
  it("yields a non-empty diagram at the app-default env (was blank)", () => {
    const src = PRESETS.ipsecEsp!;
    for (const viewMode of ["wire", "semantic"] as const) {
      const { cells } = resolveLayout(src, { env: loadEnv(src), viewMode });
      // Was 0 cells (over-consume throw → empty fallback on first paint).
      expect(cells.length).toBeGreaterThan(0);
      // Every visible header field must be present and uneditable no longer.
      const ids = new Set(cells.map((c) => c.field.id.replace(/#.*$/, "")));
      expect(ids.has("spi")).toBe(true);
      expect(ids.has("sequenceNumber")).toBe(true);
      expect(ids.has("icv")).toBe(true);
    }
  });

  it("renders payloadData inside the encrypted scope as a representative cell", () => {
    const src = PRESETS.ipsecEsp!;
    // The encrypted payload is a `bytes(remaining - 2)` tail: tagged isRemaining
    // and surfaced for the byte-count WidthPicker so it is editable, not just
    // visible.
    expect(collectRemainingFieldIds(src).has("payloadData")).toBe(true);
    // Default env paints a non-zero representative payload cell.
    expect(semanticLeafBits(src, "payloadData")).toBeGreaterThan(0);
  });

  it("makes the encrypted payload byte-count override movable", () => {
    const src = PRESETS.ipsecEsp!;
    const key = remainingBytesEnvKey("payloadData");
    const small = semanticLeafBits(src, "payloadData", { [key]: 8 });
    const large = semanticLeafBits(src, "payloadData", { [key]: 64 });
    expect(small).toBe(8 * 8);
    expect(large).toBe(64 * 8);
    expect(large).toBeGreaterThan(small);
  });
});
