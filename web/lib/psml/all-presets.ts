// Unified preset registry exposed to UI components.
//
// Two sources feed this registry:
//   1. The Typst-generated runtime presets at `./runtime-presets` (auto-built
//      by `scripts/build-presets.ts` from `data/presets.typ`). These are the
//      historical 13 protocols.
//   2. Hand-written PSML 0.3 packets in `./presets` (MANUAL_PRESETS). Added
//      in Round 5, these exercise the Encrypted container + Varint type and
//      currently include `quicLong` and `tlsClientHelloFull`.
//
// Existing Typst keys win, so the older `quicShort` (no Encrypted decoration)
// stays as the runtime version until the data pipeline supports the new
// primitives. New PSML-only keys flow in via `psmlToRuntime` so they appear
// in the picker and resolve to a flat layout — Encrypted/Varint decoration
// will be wired once the runtime resolver speaks PSML natively.

import { PRESETS as RUNTIME_PRESETS } from "./runtime-presets";
import type { PacketRegistry } from "./runtime-types";
import { MANUAL_PRESETS } from "./presets";
import type { Packet as PsmlPacket } from "./types";
import { psmlToRuntime } from "./runtime-from-psml";

// PSML-native registry of keys whose source-of-truth is a PSML Packet. The
// runtime adapter `psmlToRuntime` produces a flat fields[] view of these for
// any UI surface that needs runtime metadata (Field list, controls, detail
// panel). Encrypted/Varint flags are preserved by routing through the PSML
// resolver (lib/psml/layout.ts) rather than this flat shape.
const psmlOnly: Record<string, PsmlPacket> = {};
const extras: PacketRegistry = {};
for (const [key, psmlPkt] of Object.entries(MANUAL_PRESETS)) {
  if (Object.prototype.hasOwnProperty.call(RUNTIME_PRESETS, key)) continue;
  try {
    extras[key] = psmlToRuntime(psmlPkt);
    psmlOnly[key] = psmlPkt;
  } catch {
    // Best-effort: skip presets that don't translate.
  }
}

export const PRESETS: PacketRegistry = { ...RUNTIME_PRESETS, ...extras };
export const PRESET_KEYS = Object.keys(PRESETS);

/** Returns the original PSML Packet for keys whose canonical source is PSML
 * (so the diagram can be resolved via `resolveLayout` with encrypted/varint
 * decoration). Returns null for runtime-native keys. */
export function getPsmlPacket(key: string): PsmlPacket | null {
  return psmlOnly[key] ?? null;
}
