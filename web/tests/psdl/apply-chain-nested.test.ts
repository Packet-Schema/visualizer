// Regression: a chain-shaped Repeat (IPv6-style `nextHeader_chain`) reachable
// only via a body-level `{kind:"ref"}` def, or nested inside an `optional`
// wrapper, must still be MATERIALISED by `applyChainInstances`. Before the fix,
// `expandContainer` recursed only through `bounded`/`group`, so a ref/optional-
// nested chain hit the default `return [c]`: chainInstances rode through
// JSON/share round-trips but the diagram never showed the per-instance
// extension-header groups (an inert, see-but-cannot-edit control). This is the
// same class as the apply-tlv ref/optional gap; no built-in preset puts a chain
// behind a ref/optional, so this is arbitrary-PSDL only.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import {
  applyChainInstances,
  psdlToRenderer,
} from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import type {
  Packet as PsdlPacket,
  Repeat as PsdlRepeat,
} from "@/lib/psdl/types";

function cellsOf(psdl: PsdlPacket) {
  const env = new Map<string, number>();
  for (const [k, v] of initialEnv(psdl)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  return resolveLayout(psdl, { env }).cells;
}

/** Pull the ipv6 chain Repeat + the rest of the body out of the preset. */
function splitIpv6() {
  const src = PRESETS.ipv6!;
  const chainRepeat = src.body.find(
    (c): c is PsdlRepeat =>
      "kind" in c && c.kind === "repeat" && /chain/.test(c.id),
  );
  if (!chainRepeat) throw new Error("ipv6 preset missing chain repeat");
  const others = src.body.filter((c) => c !== chainRepeat);
  return { src, chainRepeat, others };
}

/** A mirror whose chain field carries two heterogeneous instances. Built from
 *  the SAME source it will be applied to, so the (now ref-qualified) chain
 *  field id matches what `expandContainer` looks up. */
function chainEditMirror(src: PsdlPacket) {
  const mirror = psdlToRenderer(src);
  const chainField = mirror.fields.find((f) => f.chainCatalog);
  if (!chainField) throw new Error("nested chain mirror missing chain field");
  // Hop-by-Hop (0) then Routing (43) — two DIFFERENT variants.
  chainField.chainInstances = [{ proto: 0 }, { proto: 43 }];
  return mirror;
}

function subNames(cells: ReturnType<typeof cellsOf>, groupId: string) {
  return cells
    .filter((c) => c.field.id === groupId)
    .flatMap((c) => c.subCells ?? [])
    .map((s) => s.subfield.name);
}

describe("applyChainInstances: ref / optional-nested chain", () => {
  it("materialises a chain reachable only via a body-level ref def", () => {
    const { src, chainRepeat, others } = splitIpv6();

    const refSrc: PsdlPacket = {
      ...src,
      defs: {
        ...(src.defs ?? {}),
        ipv6ExtChain: { id: "ipv6ExtChain", fields: [chainRepeat] },
      },
      body: [
        ...others,
        { kind: "ref", ref: "ipv6ExtChain", id: "extChainRef" },
      ],
    };
    const mirror = chainEditMirror(refSrc);

    const before = cellsOf(refSrc).length;
    const cells = cellsOf(applyChainInstances(refSrc, mirror));
    // The diagram is rewritten: two per-instance groups now render. The chain
    // id is qualified by the enclosing ref id (`extChainRef.`).
    expect(cells.length).toBeGreaterThan(before);
    expect(subNames(cells, "extChainRef.nextHeader_chain__chain_0")).toContain(
      "Options + padding",
    );
    const routing = subNames(cells, "extChainRef.nextHeader_chain__chain_1");
    expect(routing).toContain("Routing Type");
    expect(routing).not.toContain("Options + padding");
  });

  it("materialises a chain nested inside an optional wrapper", () => {
    const { src, chainRepeat, others } = splitIpv6();

    const optSrc: PsdlPacket = {
      ...src,
      body: [
        ...others,
        {
          kind: "optional",
          id: "extHeaders",
          when: { kind: "lit", value: 1 },
          container: chainRepeat,
        },
      ],
    };
    // The chain is body-level (only WRAPPED in an optional, no ref), so its
    // mirror id stays bare. Build the mirror from the real ipv6 preset (which
    // surfaces the chain catalog on the bare `nextHeader` base field) to match.
    const mirror = chainEditMirror(src);

    const before = cellsOf(optSrc).length;
    const cells = cellsOf(applyChainInstances(optSrc, mirror));
    // An `optional` is a transparent scope (no ref), so the chain id stays
    // bare.
    expect(cells.length).toBeGreaterThan(before);
    expect(subNames(cells, "nextHeader_chain__chain_0")).toContain(
      "Options + padding",
    );
    const routing = subNames(cells, "nextHeader_chain__chain_1");
    expect(routing).toContain("Routing Type");
    expect(routing).not.toContain("Options + padding");
  });

  it("does not rewrite a ref/optional-nested chain when there are no instances", () => {
    const { src, chainRepeat, others } = splitIpv6();
    // A mirror with the chain field present but ZERO instances must leave the
    // body untouched (no inert empty groups; the chain renders 0, correctly).
    const refSrc: PsdlPacket = {
      ...src,
      defs: {
        ...(src.defs ?? {}),
        ipv6ExtChain: { id: "ipv6ExtChain", fields: [chainRepeat] },
      },
      body: [
        ...others,
        { kind: "ref", ref: "ipv6ExtChain", id: "extChainRef" },
      ],
    };
    const emptyMirror = psdlToRenderer(refSrc);
    // No chain instances -> hasChainEdit false -> identity.
    expect(applyChainInstances(refSrc, emptyMirror)).toBe(refSrc);
  });
});
