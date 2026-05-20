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
import { validatePsmlPacket } from "./validate";

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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  // Validate every entry with `validatePsmlPacket` (the same checker
  // the format-adapter `parse` wrappers now run on imported files), so
  // a hand-crafted JSON blob that ended up in our localStorage key —
  // browser extension, dev tools paste, or an XSS foothold elsewhere
  // on this origin (cross-origin writes are blocked by same-origin
  // policy, so the threat model is same-origin tampering rather than
  // CSRF) — can't get a malformed PsmlPacket into the renderer or the
  // bulk-export bundle. Per-entry try/catch keeps a single bad packet
  // from wiping the whole user library: only the corrupt key is
  // dropped, the rest survive.
  // `Object.create(null)` (cast to PresetMap) avoids prototype pollution
  // from a tampered localStorage payload — a key like `__proto__` or
  // `constructor` against a plain `{}` literal would otherwise mutate
  // the map's prototype and leak into any merge/iteration downstream
  // (Copilot security review).
  const out = Object.create(null) as PresetMap;
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (typeof key !== "string" || key.length === 0) continue;
    // Explicit reject for dangerous keys — `Object.create(null)` already
    // makes the map prototype-pollution-immune, but we'd still surface
    // a confusing "preset" labelled `__proto__` in the picker if we
    // didn't skip it here.
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    try {
      validatePsmlPacket(value as PsmlPacket);
      out[key] = value as PsmlPacket;
    } catch {
      // Skip the entry; keep others.
    }
  }
  return out;
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
