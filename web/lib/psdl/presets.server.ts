// Server-only full preset registry — sourced from @packet-schema/presets.
//
// This module eagerly imports all 184 presets (~960 KB) and is therefore
// SERVER-ONLY: it must never reach the client bundle. The `server-only` import
// makes a client import a build error. Server routes that genuinely need the
// whole set — the share-URL psdl→preset reverse match in `app/page.tsx`, OG
// image generation in `app/api/og` — import from here.
//
// The client instead uses `presets.ts` (a lightweight index + per-preset
// `loadPreset(key)` fetch of `/presets/<key>.json`).

import "server-only";
import { PRESETS as CORE_PRESETS } from "@packet-schema/presets";
import { applyPresetPatches } from "./preset-patches";
import type { Packet } from "./types";

/**
 * Fill the visualizer's `rowBits` invariant from `rendererHints.rowBits` (or a
 * 32-bit default) and apply visualizer-owned preset patches at the ingestion
 * boundary. MUST stay in sync with the same logic in
 * `scripts/build-presets.ts`, which bakes the per-preset JSON the client
 * fetches — so server-computed and client-fetched packets match.
 */
function adaptPreset(key: string, p: (typeof CORE_PRESETS)[string]): Packet {
  const rowBits = p.rowBits ?? p.rendererHints?.rowBits ?? 32;
  const patched = applyPresetPatches(key, {
    ...p,
    rowBits,
  } as Record<string, unknown>);
  return patched as Packet;
}

export const PRESETS: Record<string, Packet> = Object.fromEntries(
  Object.entries(CORE_PRESETS).map(([key, p]) => [key, adaptPreset(key, p)]),
);

export const PRESET_KEYS: string[] = Object.keys(PRESETS);
