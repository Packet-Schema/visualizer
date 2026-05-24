// Verifies the boundary-merge helper that lifts runtime renderer-mirror
// instances back onto a PSML packet without touching the rest of its
// shape. Without this merge, every editMode export path
// (save-as-preset / share URL / JSON pane) silently drops the TLV/chain
// records the user added through the diagram (sub-agent CRITICAL).

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psml/presets.generated";
import {
  mergeInstancesIntoPsml,
  psmlToRenderer,
} from "@/lib/psml/psml-to-renderer";
import type { Repeat } from "@/lib/psml/types";

describe("mergeInstancesIntoPsml", () => {
  it("copies TLV instances from the renderer mirror onto the studio packet", () => {
    const studio = structuredClone(PRESETS.ipv4!);
    const mirror = psmlToRenderer(PRESETS.ipv4!);
    const opts = mirror.fields.find((f) => f.id === "options");
    if (!opts?.tlv) throw new Error("options field missing tlv");

    // Simulate diagram-driven TLV adds: the mirror gains records but the
    // studio packet (still pristine) does NOT — exactly the bug the
    // merge helper fixes.
    opts.tlv.instances = [{ kind: 1 }, { kind: 7, extras: { addrCount: 3 } }];

    const merged = mergeInstancesIntoPsml(studio, mirror);
    const optionsRepeat = merged.body.find(
      (c): c is Repeat => c.kind === "repeat" && c.id === "options",
    );
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
    const mirror = psmlToRenderer(PRESETS.ipv4!);
    const merged = mergeInstancesIntoPsml(studio, mirror);
    const optionsRepeat = merged.body.find(
      (c): c is Repeat => c.kind === "repeat" && c.id === "options",
    );
    expect(optionsRepeat?.instances).toBeUndefined();
  });

  it("copies chain instances from the renderer mirror for IPv6-style Repeats", () => {
    const studio = structuredClone(PRESETS.ipv6!);
    const mirror = psmlToRenderer(PRESETS.ipv6!);
    const nextHeader = mirror.fields.find((f) => f.id === "nextHeader");
    if (!nextHeader) throw new Error("ipv6 mirror missing nextHeader");
    nextHeader.chainInstances = [{ proto: 0 }, { proto: 60 }];

    const merged = mergeInstancesIntoPsml(studio, mirror);
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
    const optionsRepeat = studio.body.find(
      (c): c is Repeat => c.kind === "repeat" && c.id === "options",
    );
    if (!optionsRepeat) throw new Error("options Repeat missing");
    optionsRepeat.instances = [{ kind: 1 }, { kind: 1 }];

    const mirror = psmlToRenderer(PRESETS.ipv4!);
    const opts = mirror.fields.find((f) => f.id === "options");
    if (!opts?.tlv) throw new Error("options field missing tlv");
    opts.tlv.instances = []; // user cleared the diagram

    const merged = mergeInstancesIntoPsml(studio, mirror);
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

    const mirror = psmlToRenderer(PRESETS.ipv6!);
    const nextHeader = mirror.fields.find((f) => f.id === "nextHeader");
    if (!nextHeader) throw new Error("ipv6 mirror missing nextHeader");
    nextHeader.chainInstances = [];

    const merged = mergeInstancesIntoPsml(studio, mirror);
    const mergedChain = merged.body.find(
      (c): c is Repeat =>
        c.kind === "repeat" && /(^|_)chain($|[A-Z_])/.test(c.id),
    );
    expect(mergedChain?.chainInstances).toBeUndefined();
  });

  it("overlays byteOrder edits from the mirror onto leaf Fields (C1)", () => {
    const studio = structuredClone(PRESETS.ipv4!);
    const mirror = psmlToRenderer(PRESETS.ipv4!);
    const versionField = mirror.fields.find((f) => f.id === "version");
    if (!versionField) throw new Error("version field missing");
    versionField.byteOrder = "LE"; // user flipped via the override panel

    const merged = mergeInstancesIntoPsml(studio, mirror);
    const versionPsml = merged.body.find(
      (c) => (c as { id?: string }).id === "version",
    ) as { byteOrder?: "BE" | "LE" } | undefined;
    expect(versionPsml?.byteOrder).toBe("LE");
  });

  it("persists chainFinalProto onto the chain Repeat (H1)", () => {
    const studio = structuredClone(PRESETS.ipv6!);
    const mirror = psmlToRenderer(PRESETS.ipv6!);
    const nextHeader = mirror.fields.find((f) => f.id === "nextHeader");
    if (!nextHeader) throw new Error("ipv6 mirror missing nextHeader");
    nextHeader.chainFinalProto = 58; // user picked ICMPv6

    const merged = mergeInstancesIntoPsml(studio, mirror);
    const chainRepeat = merged.body.find(
      (c): c is Repeat =>
        c.kind === "repeat" && /(^|_)chain($|[A-Z_])/.test(c.id),
    );
    expect(chainRepeat?.chainFinalProto).toBe(58);
  });
});
