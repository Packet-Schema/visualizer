// STATIC-COUNT FREEZE regression: a plain `repeat{ count: <literal> }` whose
// count is a fixed numeric literal (not a ref / eos / until) never reaches an
// override surface — `psdlToRenderer` only surfaces a freeRepeat for a
// ref-driven count — so PacketViewer's product-aware env guard cannot bound it.
// The literal is passed STRAIGHT to `resolveLayout`, which expands ~one
// un-virtualized SVG cell per record / per byte: a user-authored
// `repeat{ count: 50000 }` or a single `bytes(50000)` field resolves to ~50000
// cells (~330ms and growing) and a larger literal freezes / OOM-crashes the
// page — a reachable freeze for legal PSDL that violates the part-2 bar.
// `clampStaticLayoutCounts` (wired into PacketViewer's `renderPsdl` memo, fed to
// resolveLayout in place of the raw `targetPsdl`) clamps the literal to
// MAX_DERIVED_RECORDS so the rendered cell count can never exceed the same
// ceiling the override paths already enforce. It is layout-only: the SOURCE
// packet keeps the authored literal, so it still round-trips losslessly.

import { describe, it, expect } from "vitest";

import { clampStaticLayoutCounts } from "@/lib/psdl/clamp-static-layout";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

// Mirror of PacketViewer's `MAX_DERIVED_RECORDS`.
const MAX_DERIVED_RECORDS = 1024;

function literalCountPacket(count: number): PsdlPacket {
  return {
    name: "Probe",
    rowBits: 8,
    body: [
      {
        kind: "repeat",
        id: "records",
        count: { kind: "lit", value: count },
        element: {
          kind: "struct",
          fields: [{ id: "b", name: "B", type: { kind: "int", bits: 8 } }],
        },
      },
    ],
  } as unknown as PsdlPacket;
}

function literalBytesPacket(bytes: number): PsdlPacket {
  return {
    name: "Probe",
    rowBits: 8,
    body: [
      {
        id: "blob",
        name: "Blob",
        type: { kind: "bytes", n: { kind: "lit", value: bytes } },
      },
    ],
  } as unknown as PsdlPacket;
}

describe("clampStaticLayoutCounts", () => {
  it("a literal-count-50000 repeat is never surfaced as a freeRepeat (no override clamp)", () => {
    const src = literalCountPacket(50000);
    const mirror = psdlToRenderer(src);
    // Confirms the PROBE from the finding: a literal count has no override
    // surface, so the env guard cannot reach it — only the layout clamp can.
    expect(mirror.freeRepeats ?? []).toHaveLength(0);
  });

  it("a literal-count-50000 repeat resolves to <= the cap (was 50000 cells)", () => {
    const src = literalCountPacket(50000);
    // Pre-fix: resolveLayout on the raw source emits one cell per record.
    expect(resolveLayout(src, { env: new Map() }).cells.length).toBe(50000);
    // Post-fix: the clamped render packet caps the rendered cell count.
    const clamped = clampStaticLayoutCounts(src, MAX_DERIVED_RECORDS);
    expect(resolveLayout(clamped, { env: new Map() }).cells.length).toBe(
      MAX_DERIVED_RECORDS,
    );
  });

  it("a single fixed huge bytes literal is clamped to the cap (~one cell per byte)", () => {
    const src = literalBytesPacket(50000);
    expect(resolveLayout(src, { env: new Map() }).cells.length).toBeGreaterThan(
      MAX_DERIVED_RECORDS,
    );
    const clamped = clampStaticLayoutCounts(src, MAX_DERIVED_RECORDS);
    expect(
      resolveLayout(clamped, { env: new Map() }).cells.length,
    ).toBeLessThanOrEqual(MAX_DERIVED_RECORDS);
  });

  it("leaves a within-cap literal count untouched (same reference)", () => {
    const src = literalCountPacket(4);
    expect(clampStaticLayoutCounts(src, MAX_DERIVED_RECORDS)).toBe(src);
    expect(resolveLayout(src, { env: new Map() }).cells.length).toBe(4);
  });

  it("does NOT touch a ref-driven count (handled by the override env guard)", () => {
    const src: PsdlPacket = {
      name: "RefCount",
      rowBits: 8,
      body: [
        { id: "n", name: "N", type: { kind: "int", bits: 8 } },
        {
          kind: "repeat",
          id: "records",
          count: { kind: "ref", ref: "n" },
          element: {
            kind: "struct",
            fields: [{ id: "b", name: "B", type: { kind: "int", bits: 8 } }],
          },
        },
      ],
    } as unknown as PsdlPacket;
    // A ref-driven count has no literal to clamp — the packet is unchanged.
    expect(clampStaticLayoutCounts(src, MAX_DERIVED_RECORDS)).toBe(src);
  });

  it("does NOT mutate the SOURCE packet — the authored literal still round-trips", () => {
    const src = literalCountPacket(50000);
    clampStaticLayoutCounts(src, MAX_DERIVED_RECORDS);
    const repeat = src.body[0] as { count: { value: number } };
    expect(repeat.count.value).toBe(50000);
  });

  it("clamps a literal count nested inside a top-level switch case", () => {
    const src: PsdlPacket = {
      name: "Nested",
      rowBits: 8,
      body: [
        { id: "t", name: "T", type: { kind: "int", bits: 8 } },
        {
          kind: "switch",
          id: "sw",
          on: { kind: "ref", ref: "t" },
          cases: {
            "0": {
              kind: "struct",
              fields: [
                {
                  kind: "repeat",
                  id: "inner",
                  count: { kind: "lit", value: 50000 },
                  element: {
                    kind: "struct",
                    fields: [
                      { id: "b", name: "B", type: { kind: "int", bits: 8 } },
                    ],
                  },
                },
              ],
            },
          },
        },
      ],
    } as unknown as PsdlPacket;
    const clamped = clampStaticLayoutCounts(src, MAX_DERIVED_RECORDS);
    const out = resolveLayout(clamped, { env: new Map([["t", 0]]) });
    expect(out.cells.length).toBeLessThanOrEqual(MAX_DERIVED_RECORDS + 1);
  });
});
