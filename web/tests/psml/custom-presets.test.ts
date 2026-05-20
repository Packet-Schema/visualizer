// @vitest-environment jsdom
//
// Custom-preset persistence tests — exercise localStorage round-trips,
// defensive parsing on corrupt/missing storage, and the listing helper.

import { beforeEach, describe, expect, it } from "vitest";
import {
  STORAGE_KEY,
  deleteCustomPreset,
  listCustomPresets,
  loadCustomPresets,
  saveCustomPreset,
} from "../../lib/psml/custom-presets";
import type { PsmlPacket } from "../../lib/psml/types";

function mkPacket(name: string): PsmlPacket {
  return {
    name,
    rowBits: 32,
    body: [{ id: "x", name: "X", type: { kind: "int", bits: 8 } }],
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("loadCustomPresets", () => {
  it("returns {} when storage is empty", () => {
    expect(loadCustomPresets()).toEqual({});
  });

  it("returns {} when storage holds corrupt JSON", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadCustomPresets()).toEqual({});
  });

  it("returns {} when storage holds a JSON array", () => {
    localStorage.setItem(STORAGE_KEY, "[1,2,3]");
    expect(loadCustomPresets()).toEqual({});
  });

  it("returns {} when storage holds JSON null", () => {
    localStorage.setItem(STORAGE_KEY, "null");
    expect(loadCustomPresets()).toEqual({});
  });

  it("round-trips a saved packet", () => {
    const p = mkPacket("Round-Trip");
    saveCustomPreset("custom:round-trip", p);
    expect(loadCustomPresets()["custom:round-trip"]).toEqual(p);
  });
});

describe("saveCustomPreset", () => {
  it("ignores an empty key", () => {
    saveCustomPreset("", mkPacket("ignored"));
    expect(loadCustomPresets()).toEqual({});
  });

  it("overwrites an existing key", () => {
    saveCustomPreset("custom:a", mkPacket("first"));
    saveCustomPreset("custom:a", mkPacket("second"));
    expect(loadCustomPresets()["custom:a"].name).toBe("second");
  });

  it("preserves sibling entries", () => {
    saveCustomPreset("custom:a", mkPacket("A"));
    saveCustomPreset("custom:b", mkPacket("B"));
    const map = loadCustomPresets();
    expect(Object.keys(map).sort()).toEqual(["custom:a", "custom:b"]);
  });
});

describe("deleteCustomPreset", () => {
  it("removes the named key", () => {
    saveCustomPreset("custom:a", mkPacket("A"));
    saveCustomPreset("custom:b", mkPacket("B"));
    deleteCustomPreset("custom:a");
    expect(Object.keys(loadCustomPresets())).toEqual(["custom:b"]);
  });

  it("is a no-op for unknown key", () => {
    saveCustomPreset("custom:a", mkPacket("A"));
    deleteCustomPreset("custom:missing");
    expect(Object.keys(loadCustomPresets())).toEqual(["custom:a"]);
  });

  it("ignores empty key", () => {
    saveCustomPreset("custom:a", mkPacket("A"));
    deleteCustomPreset("");
    expect(Object.keys(loadCustomPresets())).toEqual(["custom:a"]);
  });
});

describe("listCustomPresets", () => {
  it("returns key/name pairs sorted by key", () => {
    saveCustomPreset("custom:b", mkPacket("Beta"));
    saveCustomPreset("custom:a", mkPacket("Alpha"));
    expect(listCustomPresets()).toEqual([
      { key: "custom:a", name: "Alpha" },
      { key: "custom:b", name: "Beta" },
    ]);
  });

  it("drops entries that fail PSML validation (e.g. missing name)", () => {
    // `readRaw` runs `validatePsmlPacket` on each entry now so a third
    // party that wrote a malformed blob into our storage key can't get
    // a half-shaped Packet through to the UI. A valid sibling survives
    // — per-entry isolation keeps one bad packet from wiping the
    // library.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        "custom:nameless": { rowBits: 32, body: [] },
        "custom:ok": { name: "OK", rowBits: 32, body: [] },
      }),
    );
    expect(listCustomPresets()).toEqual([{ key: "custom:ok", name: "OK" }]);
  });

  it("returns [] when nothing is stored", () => {
    expect(listCustomPresets()).toEqual([]);
  });
});
