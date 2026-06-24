// override-audit B1/B2/B3: the IPv6 extension-header chain is modelled as an
// eos `Repeat<Switch on ref(nextHeader)>`, which the live diagram could not
// render (0 cells) and could not vary per iteration. `applyChainInstances`
// materialises the mirror's chainInstances into explicit per-instance Groups so
// the chain renders, heterogeneously.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import {
  applyChainInstances,
  psdlToRenderer,
} from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

function cellsOf(psdl: PsdlPacket) {
  const env = new Map<string, number>();
  for (const [k, v] of initialEnv(psdl)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  return resolveLayout(psdl, { env }).cells;
}

describe("applyChainInstances", () => {
  it("leaves the packet unchanged when there are no chain instances", () => {
    const src = PRESETS.ipv6!;
    const mirror = psdlToRenderer(src);
    // The default ipv6 view (no extension headers) must be untouched.
    expect(applyChainInstances(src, mirror)).toBe(src);
  });

  it("materialises a heterogeneous chain into per-instance variant cells", () => {
    const src = PRESETS.ipv6!;
    const mirror = psdlToRenderer(src);
    const chainField = mirror.fields.find((f) => f.chainCatalog);
    if (!chainField) throw new Error("ipv6 mirror missing chain field");
    // Hop-by-Hop (0) then Routing (43) — two DIFFERENT variants.
    chainField.chainInstances = [{ proto: 0 }, { proto: 43 }];

    const cells = cellsOf(applyChainInstances(src, mirror));
    const subNames = (groupId: string) =>
      cells
        .filter((c) => c.field.id === groupId)
        .flatMap((c) => c.subCells ?? [])
        .map((s) => s.subfield.name);

    // Instance 0 is Hop-by-Hop Options (Options payload); instance 1 is Routing
    // (Routing Type / Segments Left) — proving each keeps its own variant.
    const hbh = subNames("nextHeader_chain__chain_0");
    const routing = subNames("nextHeader_chain__chain_1");
    expect(hbh).toContain("Options + padding");
    expect(routing).toContain("Routing Type");
    expect(routing).not.toContain("Options + padding");
  });

  it("renders more cells once a chain instance is added (was 0 before)", () => {
    const src = PRESETS.ipv6!;
    const mirror = psdlToRenderer(src);
    const before = cellsOf(src).length;
    const chainField = mirror.fields.find((f) => f.chainCatalog)!;
    chainField.chainInstances = [{ proto: 44 }]; // Fragment
    const after = cellsOf(applyChainInstances(src, mirror)).length;
    expect(after).toBeGreaterThan(before);
  });
});
