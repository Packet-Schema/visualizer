// Regression: the built-in "TLS Extensions Block" (tlsExtensionsBlock) preset
// has a body that is ENTIRELY a single top-level TLV Repeat
// (`repeat{count:eos, element:[switch on peek]}`). At load there are no TLV
// instances and no slot-byte budget (no length controller / no
// TLV_LENGTH_SYNC rule), so applyTlvInstances would hit Stage 3 ("no
// instances and no slot → keep the raw Repeat → 0 cells"). Because there are
// no surrounding header fields, the WHOLE diagram would be blank at load —
// the see-nothing class the codebase elsewhere avoids (lldp defaultCount,
// tlsClientHello defaultLength).
//
// applyTlvInstances now seeds a representative default slot when the TLV
// Repeat is the body's sole cell-producing container, so a clickable
// "Options" placeholder shows at load. IPv4/TCP (options Repeat among many
// header fields, sized by an IHL/dataOffset controller) keep Stage-3.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import {
  applyChainInstances,
  applyTlvInstances,
  psdlToRenderer,
} from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { evalExprOr } from "@/lib/psdl/expr";
import { initialState } from "@/lib/psdl/renderer-helpers";
import type { Packet as RendererPacket } from "@/lib/psdl/renderer";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

// Faithfully reproduce the PacketViewer load path: TLV/chain expansion +
// initial controller state + the bounded-repeat count derive, then count the
// rendered cells. Mirrors the helper in bounded-repeat.test.ts.
function loadCellCount(src: PsdlPacket, mirror: RendererPacket): number {
  const ctrl = initialState(mirror);
  const base = applyChainInstances(applyTlvInstances(src, mirror, {}), mirror);
  const env = new Map<string, number>(
    Object.entries(ctrl).map(([k, v]) => [k, Number(v)]),
  );
  for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
  for (const br of mirror.boundedRepeats ?? []) {
    const budget = evalExprOr(br.bytesExpr, env, 0);
    const forRecords = Math.max(0, budget - br.prefixBytes);
    env.set(br.countKey, Math.floor(forRecords / br.perRecordBytes));
  }
  return resolveLayout(base, { env }).cells.length;
}

describe("tlsExtensionsBlock renders at load (not blank)", () => {
  it("renders at least one cell at load even with no instances / no slot", () => {
    const src = PRESETS.tlsExtensionsBlock!;
    const mirror = psdlToRenderer(src);
    expect(loadCellCount(src, mirror)).toBeGreaterThan(0);
  });

  it("the seeded cell is the clickable TLV Options slot (carries the tlv id)", () => {
    const src = PRESETS.tlsExtensionsBlock!;
    const mirror = psdlToRenderer(src);
    const tlvField = mirror.fields.find((f) => f.tlv);
    expect(
      tlvField,
      "tlsExtensionsBlock should expose a tlv field",
    ).toBeDefined();
    // With no slot supplied, applyTlvInstances seeds a Stage-1 placeholder
    // Field whose id is the TLV id, so a click lands on packet.fields[tlvId].
    const out = applyTlvInstances(src, mirror, {});
    expect(out).not.toBe(src);
    const placeholder = out.body.find(
      (c) =>
        (!("kind" in c) || c.kind === "field") &&
        (c as { id: string }).id === tlvField!.id,
    );
    expect(placeholder).toBeDefined();
    const type = (placeholder as { type: { kind: string; n: unknown } }).type;
    expect(type.kind).toBe("bytes");
    expect((type.n as { value: number }).value).toBeGreaterThan(0);
  });

  it("does NOT seed a slot for IPv4 options (Repeat sits among header fields)", () => {
    // IPv4's options Repeat is one of many body containers, so it must keep
    // Stage-3 behaviour: applyTlvInstances({}) returns the packet unchanged.
    const src = PRESETS.ipv4!;
    const mirror = psdlToRenderer(src);
    expect(applyTlvInstances(src, mirror, {})).toBe(src);
  });
});
