// override-design-audit (medium): a top-level / switch-arm `bytes(remaining)`
// payload renders a real cell on the diagram (one default row) but the
// OverridePanel previously gave it NO control — it is not a varint / berLength /
// delimited leaf, not a lengthController, not a switch / enum / optional target,
// and was never surfaced as a dynamic-width leaf, so a click fell through every
// widget branch to the "Read-only display" EmptyState. Across the 184 presets,
// 16 render such a cell at seed with no way to grow / shrink it (mobilityHeader
// mh6MessageBytes, syslog msg, teredo ipv6Payload, sshBinary mac, …): a
// see-but-cannot-edit gap.
//
// Fix: tag the renderer Field / SubField with `isRemaining` (collected alongside
// the other dynamic-width flags), give it a byte-count WidthPicker keyed on the
// visualizer-only `__remainingBytes__<id>` budget key, and have `resolveLayout`
// size the packet budget to `fixedPrefix + bytes*8` so the picker drives the
// cell. `initialState` / `seedDynamicWidthDefaults` seed REMAINING_DEFAULT_BYTES
// so the picker's active option matches the seeded diagram tail.
//
// This test pins: (1) the layout honors the `__remainingBytes__<id>` override
// for a top-level remaining tail (syslog) AND a switch-arm one (mobilityHeader);
// (2) the seed default renders a representative cell; (3) the mirror tags
// `isRemaining` / surfaces nested remaining leaves; (4) a remaining leaf inside a
// repeat is NOT tagged (its size follows the repeat budget); (5) the budget cap
// clamps a hostile override so it can't freeze the diagram.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import {
  initialState,
  nonDefaultControllerEnv,
} from "@/lib/psdl/renderer-helpers";
import {
  REMAINING_DEFAULT_BYTES,
  remainingBytesEnvKey,
  collectRemainingFieldIds,
} from "@/lib/psdl/dynamic-width-defaults";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

/** Load-time env exactly as PacketViewer builds it: the mirror's initialState
 *  seeds, then the packet defaults, then a 0 fallback for every ref. */
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

/** Resolved wire bits of a leaf. A field wider than a row is emitted as several
 *  segment cells that all carry the SAME `field.bits` (the full field width), so
 *  read it from the first matching cell rather than summing the segments. */
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

describe("bytes(remaining) payload width is editable", () => {
  it("drives a top-level remaining tail's cell width via __remainingBytes__ (syslog msg)", () => {
    const src = PRESETS.syslog!;
    const key = remainingBytesEnvKey("msg");
    // Seed default renders a representative cell.
    expect(leafBits(src, "msg")).toBe(REMAINING_DEFAULT_BYTES * 8);
    // The width picker key drives the cell: N bytes -> N*8 bits.
    expect(leafBits(src, "msg", { [key]: 8 })).toBe(8 * 8);
    expect(leafBits(src, "msg", { [key]: 16 })).toBe(16 * 8);
    // 0 bytes collapses the tail to a width-0 region (no rendered cell — a valid
    // choice on the ladder for an empty payload).
    expect(leafBits(src, "msg", { [key]: 0 })).toBe(-1);
  });

  it("drives a switch-arm remaining tail's width too (mobilityHeader mh6MessageBytes)", () => {
    const src = PRESETS.mobilityHeader!;
    const key = remainingBytesEnvKey("mh6MessageBytes");
    expect(leafBits(src, "mh6MessageBytes")).toBe(REMAINING_DEFAULT_BYTES * 8);
    expect(leafBits(src, "mh6MessageBytes", { [key]: 12 })).toBe(12 * 8);
  });

  it("tags the top-level remaining mirror field and surfaces nested ones for seeding", () => {
    // Top-level remaining leaves become mirror fields tagged isRemaining.
    const syslog = psdlToRenderer(PRESETS.syslog!);
    expect(syslog.fields.find((f) => f.id === "msg")?.isRemaining).toBe(true);
    // initialState seeds the dedicated budget key for them.
    expect(initialState(syslog)[remainingBytesEnvKey("msg")]).toBe(
      REMAINING_DEFAULT_BYTES,
    );

    // Switch-arm remaining leaves never reach mirror.fields; they surface in
    // dynamicWidthLeaves with kind:"remaining" so initialState still seeds them.
    const mh = psdlToRenderer(PRESETS.mobilityHeader!);
    const leaf = (mh.dynamicWidthLeaves ?? []).find(
      (l) => l.id === "mh6MessageBytes",
    );
    expect(leaf?.kind).toBe("remaining");
    expect(initialState(mh)[remainingBytesEnvKey("mh6MessageBytes")]).toBe(
      REMAINING_DEFAULT_BYTES,
    );
  });

  it("excludes a remaining leaf nested inside a repeat (no budget-key width)", () => {
    // Arbitrary PSDL: a `bytes(remaining)` INSIDE a repeat element is governed by
    // the repeat / bounded budget, not the packet-level budget knob, so it must
    // not be tagged isRemaining (its WidthPicker would drive an inert key).
    const src: PsdlPacket = {
      name: "t",
      rowBits: 32,
      body: [
        { id: "hdr", type: { kind: "int", bits: 8 } },
        {
          kind: "repeat",
          id: "recs",
          count: { kind: "lit", value: 1 },
          element: {
            fields: [
              {
                id: "recTail",
                type: { kind: "bytes", n: { kind: "remaining" } },
              },
            ],
          },
        },
      ],
    } as unknown as PsdlPacket;
    expect(collectRemainingFieldIds(src).has("recTail")).toBe(false);
    const mirror = psdlToRenderer(src);
    const nested = (mirror.dynamicWidthLeaves ?? []).find(
      (l) => l.id === "recTail",
    );
    expect(nested).toBeUndefined();
  });

  it("clamps a hostile oversized override so the diagram can't explode", () => {
    const src = PRESETS.syslog!;
    const key = remainingBytesEnvKey("msg");
    // 1e9 bytes would be billions of cells; the layout caps the budget at 1024 B.
    expect(leafBits(src, "msg", { [key]: 1_000_000_000 })).toBe(1024 * 8);
  });

  it("keeps the seeded remaining width out of the share / save delta", () => {
    const mirror = psdlToRenderer(PRESETS.syslog!);
    const controllers = initialState(mirror);
    // Untouched: nothing differs from the seeded defaults.
    expect(nonDefaultControllerEnv(mirror, controllers)).toBeUndefined();
    // A user width does ride along.
    const edited = { ...controllers, [remainingBytesEnvKey("msg")]: 16 };
    expect(nonDefaultControllerEnv(mirror, edited)).toEqual({
      [remainingBytesEnvKey("msg")]: 16,
    });
  });
});
