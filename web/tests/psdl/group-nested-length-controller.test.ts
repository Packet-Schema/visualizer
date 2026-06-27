// high (see-but-cannot-edit): a `length`-category int/bits field that lives
// INSIDE a Group (so it collapses to a renderer subfield) and sizes a VISIBLE
// variable `bytes` cell that is NOT its direct sibling got ZERO editable
// surface. The user sees the variable region appear/grow but has no control to
// drive it:
//
//   geneve:  optLen (in group `word1`)            → top-level `options`           = bytes(optLen*4)
//   nsh:     nshLength (in `nshBaseHeader`)        → top-level `nshContextHeaders` = bytes((nshLength-k)*m)
//   pgm:     pgmTsduLength (in `pgmCommonHeader`)  → top-level `pgmOdataData`      = bytes(pgmTsduLength)
//   ipinip:  innerTotalLength/innerIhl (in `innerIpv4Header`) → top-level `innerPayload`
//
// `collectSiblingLengthControllers` inspects only the DIRECT siblings of the
// length field (the sized cell here is a sibling of the GROUP, not the field),
// and `collectBoundedControllers` only handles `bounded.bytes` scopes — so
// neither matched. A subfield can't host its own slider, so the fix surfaces a
// packet-level `lengthController` keyed on `env[X]` (the same slider IHL gets).

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

/** Total laid-out cell count for a given env, mirroring PacketViewer. */
function cellCount(
  psdl: PsdlPacket,
  overrides: Record<string, number>,
): number {
  const env = new Map<string, number>(Object.entries(overrides));
  for (const [k, v] of initialEnv(psdl)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  return resolveLayout(psdl, { env }).cells.length;
}

/** The packet-level length controller (if any) surfaced for `id`. */
function lengthController(psdl: PsdlPacket, id: string) {
  return (psdlToRenderer(psdl).lengthControllers ?? []).find(
    (l) => l.id === id,
  );
}

describe("group-nested length field surfaces a packet-level slider", () => {
  it("geneve optLen drives the options region", () => {
    const lc = lengthController(PRESETS.geneve!, "optLen");
    expect(
      lc,
      "optLen should be a packet-level length controller",
    ).toBeDefined();
    expect(lc!.controlsLength).toBe("optLen");
    expect(lc!.bits).toBe(6);
    expect(lc!.max).toBe(63);
    // optLen is a subfield of `word1`, NOT a top-level cell.
    const mirror = psdlToRenderer(PRESETS.geneve!);
    expect(mirror.fields.some((f) => f.id === "optLen")).toBe(false);
    // Raising the slider grows the visible diagram.
    expect(cellCount(PRESETS.geneve!, { optLen: 4 })).toBeGreaterThan(
      cellCount(PRESETS.geneve!, { optLen: 0 }),
    );
  });

  it("nsh nshLength drives the context-headers region", () => {
    const lc = lengthController(PRESETS.nsh!, "nshLength");
    expect(
      lc,
      "nshLength should be a packet-level length controller",
    ).toBeDefined();
    expect(lc!.controlsLength).toBe("nshLength");
    expect(cellCount(PRESETS.nsh!, { nshLength: 8 })).toBeGreaterThan(
      cellCount(PRESETS.nsh!, { nshLength: 0 }),
    );
  });

  it("pgm pgmTsduLength drives the ODATA/RDATA data region", () => {
    const lc = lengthController(PRESETS.pgm!, "pgmTsduLength");
    expect(
      lc,
      "pgmTsduLength should be a packet-level length controller",
    ).toBeDefined();
    expect(lc!.controlsLength).toBe("pgmTsduLength");
    expect(cellCount(PRESETS.pgm!, { pgmTsduLength: 8 })).toBeGreaterThan(
      cellCount(PRESETS.pgm!, { pgmTsduLength: 0 }),
    );
  });

  it("ipinip innerTotalLength drives the inner payload region", () => {
    const lc = lengthController(PRESETS.ipinip!, "innerTotalLength");
    expect(
      lc,
      "innerTotalLength should be a packet-level length controller",
    ).toBeDefined();
    expect(lc!.controlsLength).toBe("innerTotalLength");
    // innerTotalLength is a subfield of `innerIpv4Header`, never a top-level cell.
    const mirror = psdlToRenderer(PRESETS.ipinip!);
    expect(mirror.fields.some((f) => f.id === "innerTotalLength")).toBe(false);
    expect(cellCount(PRESETS.ipinip!, { innerTotalLength: 8 })).toBeGreaterThan(
      cellCount(PRESETS.ipinip!, { innerTotalLength: 0 }),
    );
  });

  it("every group-nested length controller is keyed on its own id (no dup)", () => {
    // The surfaced controller is keyed on the field's own env id (`controlsLength
    // === id`) and is emitted at most once across the whole packet.
    for (const [, psdl] of Object.entries(PRESETS)) {
      const seen = new Set<string>();
      for (const lc of psdlToRenderer(psdl).lengthControllers ?? []) {
        expect(seen.has(lc.id), `duplicate length controller ${lc.id}`).toBe(
          false,
        );
        seen.add(lc.id);
        if (lc.controlsLength) expect(lc.controlsLength).toBe(lc.id);
      }
    }
  });
});
