// The inert-length-controller probe decides whether the panel offers a length
// slider as live or disables it with a hint. It used to sample only UPWARD from
// the current value, which is right for the case it was written for (an affine
// `bytes(len - K)` payload that stays width-0 until the slider clears K) but
// wrong for the opposite one:
//
// A controller can sit ABOVE what the layout will honour. The product budget
// divides one cell allowance across every repeat, so `radius` at
// attributes=32 stops honouring attrLength past floor(1024/32). Raising it
// then changes nothing, the upward-only probe called it inert, and BOTH the
// slider and the number input were disabled — with the hint pointing at a
// variant that does not exist. The value could not be brought back down.
//
// The probe was a closure inside a `useMemo` in PacketViewer, so exercising it
// meant mounting the whole viewer; that is why the asymmetry went unnoticed.

import { describe, it, expect } from "vitest";

import { collectInertLengthControllers } from "@/components/packet-viewer/inert-length-controllers";
import type { Cell, ResolvedLayout } from "@/lib/psdl/renderer";

const cell = (id: string): Cell =>
  ({
    field: { id, name: id, bits: 8 },
    bitsTotal: 8,
    row: 0,
    startBit: 0,
    endBit: 7,
    segmentIndex: 0,
    totalSegments: 1,
    isFirst: true,
    isLast: true,
    fieldStartOffset: 0,
    fieldEndOffset: 8,
  }) as unknown as Cell;

const layoutOf = (totalBits: number, ids: string[]): ResolvedLayout =>
  ({ cells: ids.map(cell), totalBits }) as unknown as ResolvedLayout;

/** A payload sized by `len`, but the renderer honours at most `cap` bytes. */
function cappedResolver(cap: number) {
  return (env: Map<string, number>): ResolvedLayout =>
    layoutOf(32 + 8 * Math.min(env.get("len") ?? 0, cap), ["len", "payload"]);
}

const buildEnv = (values: Record<string, number>) =>
  new Map(Object.entries(values).map(([k, v]) => [k, Number(v)]));

const run = (controllers: Record<string, number>, cap: number) =>
  collectInertLengthControllers({
    lengthControllers: [{ controlsLength: "len", bits: 16 } as never],
    fields: [],
    base: cappedResolver(cap)(buildEnv(controllers)),
    controllers,
    buildEnv,
    resolve: cappedResolver(cap),
  });

describe("collectInertLengthControllers", () => {
  it("is live below the cap, where raising the value grows the diagram", () => {
    expect(run({ len: 4 }, 32).has("len")).toBe(false);
  });

  it("stays live AT and ABOVE the cap, because lowering still shrinks it", () => {
    // This is the regression: raising 32 → 33..160 is all clamped to 32, so an
    // upward-only probe saw no change and disabled the only way back down.
    expect(run({ len: 32 }, 32).has("len")).toBe(false);
    expect(run({ len: 64 }, 32).has("len")).toBe(false);
  });

  it("is inert when the value cannot change the diagram in either direction", () => {
    const fixed = (): ResolvedLayout => layoutOf(64, ["len", "payload"]);
    const inert = collectInertLengthControllers({
      lengthControllers: [{ controlsLength: "len", bits: 16 } as never],
      fields: [],
      base: fixed(),
      controllers: { len: 8 },
      buildEnv,
      resolve: fixed,
    });
    expect(inert.has("len")).toBe(true);
  });

  it("ignores a controller whose field is not in the diagram", () => {
    // Absent fields are handled by the separate `fieldRendered` gate, and a
    // bumped value there can legitimately materialise a cell.
    const absent = collectInertLengthControllers({
      lengthControllers: [{ controlsLength: "ghost", bits: 16 } as never],
      fields: [],
      base: layoutOf(32, ["len"]),
      controllers: { ghost: 0 },
      buildEnv,
      resolve: () => layoutOf(32, ["len"]),
    });
    expect(absent.has("ghost")).toBe(false);
  });
});
