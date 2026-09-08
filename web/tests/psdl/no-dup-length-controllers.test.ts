// Integration guard: FIX 2 (collectPlainRepeatLengthControllers) and FIX 3
// (relaxed collectSiblingLengthControllers ownership flags) both surface
// per-record length controllers for plain repeats (dnsResponse dnsRdLength,
// pimHelloOptLen, …). They must never emit DUPLICATE lengthController ids for
// any preset — the dedup in psdlToRenderer keeps each id unique.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";

describe("length controllers are unique per preset", () => {
  it("no preset emits a duplicate lengthController id", () => {
    for (const [name, psdl] of Object.entries(PRESETS)) {
      const mirror = psdlToRenderer(psdl);
      const ids = (mirror.lengthControllers ?? []).map((l) => l.id);
      const seen = new Set<string>();
      const dups: string[] = [];
      for (const id of ids) {
        if (seen.has(id)) dups.push(id);
        seen.add(id);
      }
      expect(dups, `${name} has duplicate lengthController ids`).toEqual([]);
    }
  });
});
