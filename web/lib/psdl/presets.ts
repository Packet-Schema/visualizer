// PSDL preset registry — sourced from @packet-schema/presets (PSDL 0.5).
//
// Built-in presets now live in the standalone `@packet-schema/presets` package
// (YAML authored against PSDL 0.5, validated and compiled there). This module
// is the visualizer's ingestion boundary: it adapts each core-typed preset to
// the visualizer's `Packet` shape.
//
// NOTE (Phase 2): presets are still imported eagerly here, so the full set is
// bundled into the client. The follow-up is to ship a lightweight index and
// lazy-fetch each preset body as static JSON. See migration plan.

import { PRESETS as CORE_PRESETS } from "@packet-schema/presets";
import type { Packet } from "./types";

/**
 * `@packet-schema/presets` types every preset as core's `Packet`, where
 * `rowBits` is optional (0.5 deprecates it in favour of `rendererHints.rowBits`).
 * The visualizer renderer relies on `rowBits` always being present, so fill it
 * from `rendererHints.rowBits` (or a 32-bit default) at this ingestion boundary
 * and keep the `rowBits: number` invariant for the rest of the app.
 */
function adaptPreset(p: (typeof CORE_PRESETS)[string]): Packet {
  const rowBits = p.rowBits ?? p.rendererHints?.rowBits ?? 32;
  return { ...p, rowBits } as Packet;
}

export const PRESETS: Record<string, Packet> = Object.fromEntries(
  Object.entries(CORE_PRESETS).map(([key, p]) => [key, adaptPreset(p)]),
);

export const PRESET_KEYS: string[] = Object.keys(PRESETS);
