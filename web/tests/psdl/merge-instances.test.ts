// Verifies the boundary-merge helper that lifts runtime renderer-mirror
// instances back onto a PSDL packet without touching the rest of its
// shape. Without this merge, every editMode export path
// (save-as-preset / share URL / JSON pane) silently drops the TLV/chain
// records the user added through the diagram (sub-agent CRITICAL).

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import {
  mergeInstancesIntoPsdl,
  psdlToRenderer,
} from "@/lib/psdl/psdl-to-renderer";
import type { Bounded, Container, Packet, Repeat } from "@/lib/psdl/types";
import type { Packet as RendererPacket } from "@/lib/psdl/renderer";

// In PSDL 0.5 the ipv4 `options` Repeat is no longer a top-level body
// container: it lives nested inside the `optionsArea` Bounded wire-scope
// (the IHL length relation moved from top-level constraints to
// `bounded.bytes`). Descend through Bounded.fields to locate it.
function findOptionsRepeat(
  containers: readonly Container[],
): Repeat | undefined {
  for (const c of containers) {
    if (c.kind === "repeat" && c.id === "options") return c;
    if (c.kind === "bounded") {
      const found = findOptionsRepeat(c.fields);
      if (found) return found;
    }
  }
  return undefined;
}

describe("mergeInstancesIntoPsdl", () => {
  it("copies TLV instances from the renderer mirror onto the studio packet", () => {
    const studio = structuredClone(PRESETS.ipv4!);
    const mirror = psdlToRenderer(PRESETS.ipv4!);
    const opts = mirror.fields.find((f) => f.id === "options");
    if (!opts?.tlv) throw new Error("options field missing tlv");

    // Simulate diagram-driven TLV adds: the mirror gains records but the
    // studio packet (still pristine) does NOT — exactly the bug the
    // merge helper fixes.
    opts.tlv.instances = [{ kind: 1 }, { kind: 7, extras: { addrCount: 3 } }];

    const merged = mergeInstancesIntoPsdl(studio, mirror);
    // 0.5: the merged options Repeat stays nested inside the `optionsArea`
    // Bounded (the wire-scope is preserved on export), so descend to find it.
    const optionsRepeat = findOptionsRepeat(merged.body);
    expect(optionsRepeat?.instances).toEqual([
      { kind: 1 },
      { kind: 7, extras: { addrCount: 3 } },
    ]);
    // The studio packet must NOT be mutated in place — every editor path
    // depends on referential stability for memoisation / history.
    const studioOptions = studio.body.find(
      (c): c is Repeat => c.kind === "repeat" && c.id === "options",
    );
    expect(studioOptions?.instances).toBeUndefined();
  });

  it("omits the merge when the mirror has no instances", () => {
    const studio = structuredClone(PRESETS.ipv4!);
    const mirror = psdlToRenderer(PRESETS.ipv4!);
    const merged = mergeInstancesIntoPsdl(studio, mirror);
    const optionsRepeat = findOptionsRepeat(merged.body);
    expect(optionsRepeat?.instances).toBeUndefined();
  });

  it("copies chain instances from the renderer mirror for IPv6-style Repeats", () => {
    const studio = structuredClone(PRESETS.ipv6!);
    const mirror = psdlToRenderer(PRESETS.ipv6!);
    const nextHeader = mirror.fields.find((f) => f.id === "nextHeader");
    if (!nextHeader) throw new Error("ipv6 mirror missing nextHeader");
    nextHeader.chainInstances = [{ proto: 0 }, { proto: 60 }];

    const merged = mergeInstancesIntoPsdl(studio, mirror);
    const chainRepeat = merged.body.find(
      (c): c is Repeat =>
        c.kind === "repeat" && /(^|_)chain($|[A-Z_])/.test(c.id),
    );
    expect(chainRepeat?.chainInstances).toEqual([{ proto: 0 }, { proto: 60 }]);
  });

  it("clears stale TLV instances when the user empties the diagram (Codex P1)", () => {
    // Studio packet starts with TLV records baked in (as if loaded from a
    // saved preset). Mirror reflects the user emptying the list via the
    // diagram. Without an explicit overwrite the export would keep the
    // baked-in records.
    const studio = structuredClone(PRESETS.ipv4!);
    // 0.5: the options Repeat is nested inside the `optionsArea` Bounded
    // scope, not at studio.body top-level.
    const optionsRepeat = findOptionsRepeat(studio.body);
    if (!optionsRepeat) throw new Error("options Repeat missing");
    optionsRepeat.instances = [{ kind: 1 }, { kind: 1 }];

    const mirror = psdlToRenderer(PRESETS.ipv4!);
    const opts = mirror.fields.find((f) => f.id === "options");
    if (!opts?.tlv) throw new Error("options field missing tlv");
    opts.tlv.instances = []; // user cleared the diagram

    const merged = mergeInstancesIntoPsdl(studio, mirror);
    const mergedRepeat = merged.body.find(
      (c): c is Repeat => c.kind === "repeat" && c.id === "options",
    );
    expect(mergedRepeat?.instances).toBeUndefined();
  });

  it("clears stale chain instances on diagram clear (Codex P2)", () => {
    const studio = structuredClone(PRESETS.ipv6!);
    const chainRepeat = studio.body.find(
      (c): c is Repeat =>
        c.kind === "repeat" && /(^|_)chain($|[A-Z_])/.test(c.id),
    );
    if (!chainRepeat) throw new Error("chain Repeat missing");
    chainRepeat.chainInstances = [{ proto: 0 }];

    const mirror = psdlToRenderer(PRESETS.ipv6!);
    const nextHeader = mirror.fields.find((f) => f.id === "nextHeader");
    if (!nextHeader) throw new Error("ipv6 mirror missing nextHeader");
    nextHeader.chainInstances = [];

    const merged = mergeInstancesIntoPsdl(studio, mirror);
    const mergedChain = merged.body.find(
      (c): c is Repeat =>
        c.kind === "repeat" && /(^|_)chain($|[A-Z_])/.test(c.id),
    );
    expect(mergedChain?.chainInstances).toBeUndefined();
  });

  it("overlays byteOrder edits from the mirror onto leaf Fields (C1)", () => {
    const studio = structuredClone(PRESETS.ipv4!);
    const mirror = psdlToRenderer(PRESETS.ipv4!);
    const versionField = mirror.fields.find((f) => f.id === "version");
    if (!versionField) throw new Error("version field missing");
    versionField.byteOrder = "LE"; // user flipped via the override panel

    const merged = mergeInstancesIntoPsdl(studio, mirror);
    const versionPsdl = merged.body.find(
      (c) => (c as { id?: string }).id === "version",
    ) as { byteOrder?: "BE" | "LE" } | undefined;
    expect(versionPsdl?.byteOrder).toBe("LE");
  });

  it("preserves chain instance extras through renderer → PSDL lift (Round 8 HIGH)", async () => {
    // PSDL packet with hand-authored chain `extras` — Round 8 HIGH
    // confirmed that `chainFieldToRepeat` silently dropped them on
    // every `rendererToPsdl` lift (ImportExportDrawer, non-editMode
    // share/save). This pins the symmetric round-trip.
    const { rendererToPsdl } = await import("@/lib/psdl/psdl-to-renderer");
    const mirror = psdlToRenderer(PRESETS.ipv6!);
    const nextHeader = mirror.fields.find((f) => f.id === "nextHeader");
    if (!nextHeader) throw new Error("ipv6 mirror missing nextHeader");
    nextHeader.chainInstances = [
      { proto: 0, extras: { hdrExtLen: 1 } },
      { proto: 60 },
    ];
    const psdl = rendererToPsdl(mirror);
    const chainRepeat = psdl.body.find(
      (c): c is Repeat =>
        c.kind === "repeat" && /(^|_)chain($|[A-Z_])/.test(c.id),
    );
    expect(chainRepeat?.chainInstances).toEqual([
      { proto: 0, extras: { hdrExtLen: 1 } },
      { proto: 60 },
    ]);
  });

  it("keeps a bounded intact when it holds only a plain (non-TLV/chain) Repeat", () => {
    // `mergeContainer` never unwraps a `bounded`: `mergeRepeats` recurses into
    // `bounded.fields` to update any inner Repeat in place, and the wrapper —
    // with its `bytes` wire-budget — must round-trip so the exported PSDL still
    // matches the built-in preset (share / "Save as preset" rely on it).
    const plainRepeat: Repeat = {
      kind: "repeat",
      id: "rows",
      element: {
        id: "row",
        fields: [{ id: "byte", name: "Byte", type: { kind: "int", bits: 8 } }],
      },
      count: "eos",
    };
    const bounded: Bounded = {
      kind: "bounded",
      id: "region",
      bytes: { kind: "lit", value: 16 },
      fields: [plainRepeat],
    };
    const studio: Packet = {
      name: "PlainBounded",
      rowBits: 32,
      body: [bounded],
    };
    // Mirror carries no field at id "rows" (and no chain catalog), so the
    // Repeat is not a merge target.
    const mirror: RendererPacket = {
      name: "PlainBounded",
      rowBits: 32,
      fields: [],
    };

    const merged = mergeInstancesIntoPsdl(studio, mirror);
    // The bounded must still be present at top level (not spliced away), and
    // it must still carry its byte budget.
    expect(merged.body).toHaveLength(1);
    const survived = merged.body[0] as Bounded;
    expect(survived.kind).toBe("bounded");
    expect(survived.id).toBe("region");
    expect(survived.bytes).toEqual({ kind: "lit", value: 16 });
    const inner = survived.fields[0] as Repeat;
    expect(inner.kind).toBe("repeat");
    expect(inner.id).toBe("rows");
  });

  it("persists chainFinalProto onto the chain Repeat (H1)", () => {
    const studio = structuredClone(PRESETS.ipv6!);
    const mirror = psdlToRenderer(PRESETS.ipv6!);
    const nextHeader = mirror.fields.find((f) => f.id === "nextHeader");
    if (!nextHeader) throw new Error("ipv6 mirror missing nextHeader");
    nextHeader.chainFinalProto = 58; // user picked ICMPv6

    const merged = mergeInstancesIntoPsdl(studio, mirror);
    const chainRepeat = merged.body.find(
      (c): c is Repeat =>
        c.kind === "repeat" && /(^|_)chain($|[A-Z_])/.test(c.id),
    );
    expect(chainRepeat?.chainFinalProto).toBe(58);
  });
});
