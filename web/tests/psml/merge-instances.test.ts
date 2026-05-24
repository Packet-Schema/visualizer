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
});
