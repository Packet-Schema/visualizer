// high (see-but-cannot-edit): a plain `length`-category cell that directly
// sizes a SIBLING `bytes(ref <thisId>)` payload (or a sibling single-ref
// `bounded.bytes` scope) but lives inside a Switch case is neither a top-level
// renderer cell nor a Group subfield. The constraint path
// (`constraintToController`) and the single-ref bounded path
// (`collectBoundedControllers`) both only stamp `controlsLength` onto a field
// that is ALSO a renderer cell / subfield, so the switch-case-nested length
// field — and the variable region it measures — surfaced as a read-only
// display: the user could watch the payload grow/shrink but had no control.
//
//   ancp:   ancpAdjTotalLength (Adjacency case) → ancpCapabilities (bounded)
//   oncRpc: credLength / verfLength (Call case)  → credBody / verfBody (bytes ref)
//
// collectSiblingLengthControllers now surfaces each as a packet-level
// `lengthController` keyed on `env[<thisId>]`, the same slider IHL / Data Offset
// already get. Length fields inside a Repeat record stay owned by the TLV /
// chain editor (insideRepeat guard).

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

/** Total wire bits laid out by the diagram for a given override set. */
function layoutBits(
  psdl: PsdlPacket,
  overrides: Record<string, number>,
): number {
  const env = new Map<string, number>(Object.entries(overrides));
  for (const [k, v] of initialEnv(psdl)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  return resolveLayout(psdl, { env }).cells.reduce(
    (sum, c) => sum + (c.bitsTotal ?? 0),
    0,
  );
}

describe("switch-case-nested length controllers", () => {
  it("ancp surfaces a length controller for ancpAdjTotalLength", () => {
    const mirror = psdlToRenderer(PRESETS.ancp!);
    const lc = (mirror.lengthControllers ?? []).find(
      (l) => l.id === "ancpAdjTotalLength",
    );
    expect(lc).toBeDefined();
    // It is wired to drive its own env id, with a usable 16-bit slider range.
    expect(lc!.controlsLength).toBe("ancpAdjTotalLength");
    expect(lc!.bits).toBe(16);

    // It is NOT a top-level renderer cell (so it would otherwise be uneditable).
    expect(mirror.fields.some((f) => f.id === "ancpAdjTotalLength")).toBe(
      false,
    );
  });

  it("driving ancpAdjTotalLength resizes the capability block", () => {
    const psdl = PRESETS.ancp!;
    // ancpMessageType defaults to 10 (Adjacency), so the Total Length scope is
    // already active. Raising the controller must grow the diagram.
    const lo = layoutBits(psdl, { ancpAdjTotalLength: 0 });
    const hi = layoutBits(psdl, { ancpAdjTotalLength: 16 });
    expect(hi).toBeGreaterThan(lo);
  });

  it("oncRpc surfaces length controllers for credLength and verfLength", () => {
    const mirror = psdlToRenderer(PRESETS.oncRpc!);
    const ids = (mirror.lengthControllers ?? []).map((l) => l.id).sort();
    expect(ids).toContain("credLength");
    expect(ids).toContain("verfLength");

    for (const id of ["credLength", "verfLength"]) {
      const lc = mirror.lengthControllers!.find((l) => l.id === id)!;
      expect(lc.controlsLength).toBe(id);
      // Neither is a top-level renderer cell.
      expect(mirror.fields.some((f) => f.id === id)).toBe(false);
    }
  });

  it("driving credLength / verfLength resizes the opaque auth bodies", () => {
    const psdl = PRESETS.oncRpc!;
    // rpcMsgType=0 selects the Call body where credLength/verfLength live.
    const base = { rpcMsgType: 0 };
    const credLo = layoutBits(psdl, { ...base, credLength: 0 });
    const credHi = layoutBits(psdl, { ...base, credLength: 16 });
    expect(credHi).toBeGreaterThan(credLo);

    const verfLo = layoutBits(psdl, { ...base, verfLength: 0 });
    const verfHi = layoutBits(psdl, { ...base, verfLength: 16 });
    expect(verfHi).toBeGreaterThan(verfLo);
  });

  it("seeds initial controller state so the slider tracks the diagram", () => {
    // The lengthController must carry controlsLength so initialState seeds
    // env[<thisId>] — otherwise the slider and the diagram disagree on load.
    const mirror = psdlToRenderer(PRESETS.oncRpc!);
    for (const lc of mirror.lengthControllers ?? []) {
      expect(lc.controlsLength).toBe(lc.id);
    }
  });

  it("does not surface per-record TLV lengths (insideRepeat guard)", () => {
    // dhcpv4 `optionLength` sizes a per-record TLV value INSIDE a repeat; it is
    // owned by the TLV editor and must NOT also get a packet-level slider.
    const dhcpv4 = psdlToRenderer(PRESETS.dhcpv4!);
    expect(
      (dhcpv4.lengthControllers ?? []).some((l) => l.id === "optionLength"),
    ).toBe(false);
  });
});
