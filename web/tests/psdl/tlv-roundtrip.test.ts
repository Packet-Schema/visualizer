// Round-trip test for TLV instances across PSDL ↔ renderer mirror.
//
// Before PR #115's instance-persistence work, `tlvFieldToRepeat`
// emitted the catalog but silently dropped `tlv.instances`, so any
// path that went through `rendererToPsdl` (JSON export, share URL,
// "Save as preset") lost the user's chosen records. The fix carries
// instances on the PSDL `Repeat` itself; this test pins that
// behaviour.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import {
  mergeInstancesIntoPsdl,
  psdlToRenderer,
  rendererToPsdl,
} from "@/lib/psdl/psdl-to-renderer";
import { validatePsdlPacket } from "@/lib/psdl/validate";
import { fromJson, toJson } from "@/lib/formats/json";

describe("TLV instances round-trip", () => {
  it("preserves IPv4 Options across renderer → PSDL → renderer", () => {
    const mirror1 = psdlToRenderer(PRESETS.ipv4!);
    const opts = mirror1.fields.find((f) => f.id === "options");
    if (!opts?.tlv) throw new Error("options field missing tlv");

    // Mutate the renderer mirror as a user would when editing the
    // diagram: two NOPs + one Record Route with a custom extras value.
    opts.tlv.instances = [
      { kind: 1 },
      { kind: 1 },
      { kind: 7, extras: { addrCount: 3 } },
    ];

    // Lift back to PSDL (= what every export path does).
    const psdl = rendererToPsdl(mirror1);
    const repeated = psdl.body.find(
      (c) => c.kind === "repeat" && c.id === "options",
    ) as { instances?: unknown[] } | undefined;
    expect(repeated, "options Repeat must be re-emitted").toBeDefined();
    expect(
      repeated?.instances,
      "PSDL Repeat must carry the instance list",
    ).toEqual([
      { kind: 1 },
      { kind: 1 },
      { kind: 7, extras: { addrCount: 3 } },
    ]);

    // Re-import (= what every import / hydrate path does).
    const mirror2 = psdlToRenderer(psdl);
    const opts2 = mirror2.fields.find((f) => f.id === "options");
    expect(opts2?.tlv?.instances).toEqual([
      { kind: 1 },
      { kind: 1 },
      { kind: 7, extras: { addrCount: 3 } },
    ]);
  });

  it("omits the `instances` key when no records are attached", () => {
    const mirror = psdlToRenderer(PRESETS.ipv4!);
    const psdl = rendererToPsdl(mirror);
    const repeated = psdl.body.find(
      (c) => c.kind === "repeat" && c.id === "options",
    ) as { instances?: unknown[] } | undefined;
    expect(repeated).toBeDefined();
    expect(
      repeated?.instances,
      "instances should be omitted (not [] noise) when nothing's attached",
    ).toBeUndefined();
  });
});

// override-audit C1/C2/C3/C5 + A3: the export path used to reconstruct PSDL
// from the lossy renderer mirror (`rendererToPsdl`), which collapses
// variable-length `bytes:ref` payloads to `bits n:0`, drops enum labels, and
// the switch `_` default arm. The result is PSDL the app itself REJECTS on
// re-import. PacketViewer.liftActivePacketToPsdl now shape-preserving-merges the
// mirror's instances onto the source PSDL instead; this pins that the lift is
// valid and survives a full JSON export → re-import.
describe("lossless export lift", () => {
  // Every built-in single-Switch TLV preset (the ones with a variable payload /
  // enum label / `_` arm that the lossy reconstruction mangles).
  const TLV_PRESETS = ["ipv4", "dhcpv4", "ipv6Destination"] as const;

  for (const key of TLV_PRESETS) {
    it(`exports ${key} as valid, re-importable PSDL via the merge lift`, () => {
      const source = PRESETS[key]!;
      const mirror = psdlToRenderer(source);
      const lifted = mergeInstancesIntoPsdl(source, mirror);
      // The lift validates …
      expect(() => validatePsdlPacket(lifted)).not.toThrow();
      // … and survives a full JSON export → re-import (what a recipient does).
      expect(() => fromJson(toJson(lifted, new Map()))).not.toThrow();
    });
  }

  it("dhcpv4: the old rendererToPsdl path produced PSDL the app rejects (C2)", () => {
    // Pins the regression the lift fixes: the lossy path is genuinely broken,
    // so the merge lift above is load-bearing, not a no-op.
    const mirror = psdlToRenderer(PRESETS.dhcpv4!);
    expect(() => validatePsdlPacket(rendererToPsdl(mirror))).toThrow();
  });

  it("preserves a built-in TLV edit through the merge lift + JSON round-trip", () => {
    const source = PRESETS.ipv4!;
    const mirror = psdlToRenderer(source);
    const opts = mirror.fields.find((f) => f.id === "options");
    if (!opts?.tlv) throw new Error("options field missing tlv");
    opts.tlv.instances = [{ kind: 1 }, { kind: 7, extras: { addrCount: 2 } }];

    const lifted = mergeInstancesIntoPsdl(source, mirror);
    const { packet: reimported } = fromJson(toJson(lifted, new Map()));
    // The options Repeat lives inside the `optionsArea` bounded scope, so walk
    // the tree rather than only the top-level body.
    const repeat = findRepeat(reimported.body, "options");
    expect(repeat?.instances).toEqual([
      { kind: 1 },
      { kind: 7, extras: { addrCount: 2 } },
    ]);
  });
});

/** Recursively locate a Repeat by id through bounded/group/switch/etc. */
function findRepeat(
  containers: unknown[],
  id: string,
): { instances?: unknown[] } | undefined {
  for (const c of containers as Array<Record<string, unknown>>) {
    if (c?.kind === "repeat" && c.id === id)
      return c as { instances?: unknown[] };
    const kids = (c?.fields ??
      c?.children ??
      (c?.element as Record<string, unknown> | undefined)?.fields) as
      | unknown[]
      | undefined;
    if (Array.isArray(kids)) {
      const hit = findRepeat(kids, id);
      if (hit) return hit;
    }
    if (c?.cases) {
      for (const arm of Object.values(c.cases as Record<string, unknown>)) {
        const armFields = (arm as Record<string, unknown>)?.fields as
          | unknown[]
          | undefined;
        if (Array.isArray(armFields)) {
          const hit = findRepeat(armFields, id);
          if (hit) return hit;
        }
      }
    }
  }
  return undefined;
}
