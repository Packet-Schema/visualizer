import type { PacketEnv } from "./types";

/**
 * Derive secondary repeat-count keys for presets whose UI slider drives a
 * bytes-counter rather than the PSDL count ref.
 *
 * Each TLV editor sets {opts}_count directly via syncTlvControllers; this
 * covers the IHL / Data Offset slider path where the user grows the header
 * without touching the TLV editor.
 */
export function setupDerivedCounts(env: PacketEnv): void {
  const ihl = Number(env.get("ihl") ?? 5);
  env.set("ipv4OptionsCount", Math.max(0, ihl - 5));

  const dataOffset = Number(env.get("dataOffset") ?? 5);
  env.set("tcpOptionsCount", Math.max(0, dataOffset - 5));
}
