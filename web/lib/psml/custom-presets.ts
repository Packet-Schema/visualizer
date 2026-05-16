// Custom-preset persistence — localStorage-backed registry for user-authored
// PSML packets created in the Custom Packet Studio. Keys are stored under the
// canonical prefix `custom:<name>` so the studio can merge them with the
// built-in PRESETS map without colliding with baseline/manual entries.
//
// Storage format (v1):
//   key:   `packet-view-custom-presets-v1`
//   value: JSON.stringify({ "custom:<name>": PsmlPacket, ... })
//
// All read paths are defensive: a missing storage, missing key, or corrupt
// JSON returns an empty record. Write paths no-op silently when localStorage
// is unavailable (SSR or sandboxed iframes).

import type { PsmlPacket } from "./types";

export const STORAGE_KEY = "packet-view-custom-presets-v1";

type PresetMap = Record<string, PsmlPacket>;

/* ------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------ */

function getStore(): Storage | null {
  if (typeof globalThis === "undefined") return null;
  // Use a narrow cast so this file compiles in Node environments where the
  // DOM lib isn't part of tsconfig.
  const ls = (globalThis as { localStorage?: Storage }).localStorage;
  return ls ?? null;
}

function readRaw(): PresetMap {
  const ls = getStore();
  if (!ls) return {};
  let raw: string | null;
  try {
    raw = ls.getItem(STORAGE_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as PresetMap;
  } catch {
    return {};
  }
}

function writeRaw(map: PresetMap): void {
  const ls = getStore();
  if (!ls) return;
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Quota exceeded / serialization failure — swallow; UI surfaces errors.
  }
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

export function loadCustomPresets(): Record<string, PsmlPacket> {
  return readRaw();
}

/**
 * Persist a single custom preset. The key is stored verbatim; callers are
 * expected to pass `custom:<name>`. An empty key is rejected (no-op) so an
 * empty form field cannot blow away other entries by overwriting key `""`.
 */
export function saveCustomPreset(key: string, packet: PsmlPacket): void {
  if (typeof key !== "string" || key.length === 0) return;
  const map = readRaw();
  map[key] = packet;
  writeRaw(map);
}

export function deleteCustomPreset(key: string): void {
  if (typeof key !== "string" || key.length === 0) return;
  const map = readRaw();
  if (!(key in map)) return;
  delete map[key];
  writeRaw(map);
}

/**
 * Lightweight listing for picker UIs — returns `{ key, name }` pairs sorted
 * alphabetically by key. `name` falls back to the key when the stored packet
 * lacks a name (which can happen with corrupt or partially-written entries).
 */
export function listCustomPresets(): { key: string; name: string }[] {
  const map = readRaw();
  return Object.keys(map)
    .sort()
    .map((key) => {
      const pkt = map[key];
      const name =
        pkt && typeof pkt === "object" && typeof pkt.name === "string"
          ? pkt.name
          : key;
      return { key, name };
    });
}
