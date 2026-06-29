// Goal: ANY user-imported PSDL (not just built-in presets) must round-trip
// perfectly. Imported packets now retain their source PSDL, and every lift
// (diagram / share / export) merges the renderer mirror's instance edits onto
// that source via mergeInstancesIntoPsdl rather than reconstructing from the
// lossy renderer mirror (rendererToPsdl). This pins that the imported-source
// lift is SHAPE-IDENTICAL for an unedited import across all presets (which
// stand in for arbitrary PSDL: they exercise Switch / Encrypted / bounded /
// variable-length / ref constructs), and stays valid + re-importable.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import {
  mergeInstancesIntoPsdl,
  psdlToRenderer,
  rendererToPsdl,
} from "@/lib/psdl/psdl-to-renderer";
import { validatePsdlPacket } from "@/lib/psdl/validate";
import { fromJson, toJson } from "@/lib/formats/json";
import { stableStringify } from "@/lib/stable-stringify";

describe("imported PSDL is losslessly representable", () => {
  it("the imported-source lift is shape-identical for every preset (unedited)", () => {
    // = the import → re-export path with no edits. Must return the EXACT source.
    const diverged: string[] = [];
    for (const key of Object.keys(PRESETS)) {
      const source = PRESETS[key]!;
      const lifted = mergeInstancesIntoPsdl(source, psdlToRenderer(source));
      if (stableStringify(lifted) !== stableStringify(source)) {
        diverged.push(key);
      }
    }
    expect(diverged).toEqual([]);
  });

  it("survives a full JSON import → export → re-import for every preset", () => {
    for (const key of Object.keys(PRESETS)) {
      const source = PRESETS[key]!;
      // Import: parse PSDL → mirror. Re-export: merge lift → JSON. Re-import.
      const lifted = mergeInstancesIntoPsdl(source, psdlToRenderer(source));
      expect(
        () => validatePsdlPacket(lifted),
        `${key} lift valid`,
      ).not.toThrow();
      expect(
        () => fromJson(toJson(lifted, new Map())),
        `${key} JSON round-trip`,
      ).not.toThrow();
    }
  });

  it("preserves Switch/Encrypted regions the lossy lift would drop", () => {
    // A preset with a bare Switch (ipv6 chain switch) and one with Encrypted.
    const withSwitch = Object.keys(PRESETS).find((k) =>
      JSON.stringify(PRESETS[k]!.body).includes('"kind":"switch"'),
    )!;
    const source = PRESETS[withSwitch]!;
    const merged = mergeInstancesIntoPsdl(source, psdlToRenderer(source));
    const lossy = rendererToPsdl(psdlToRenderer(source));
    // Merge keeps the switch count; the lossy reconstruction drops it.
    const countSwitch = (p: unknown) =>
      (JSON.stringify(p).match(/"kind":"switch"/g) ?? []).length;
    expect(countSwitch(merged)).toBe(countSwitch(source));
    expect(countSwitch(lossy)).toBeLessThan(countSwitch(source));
  });
});
