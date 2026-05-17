// PSML 0.2 — runtime constants.
//
// Category labels, byte-order copy, preset grouping, theme storage key. The
// category → CSS variable mapping lives in `./render-tokens.ts` (renderer
// intent, not schema metadata). This file re-exports the common items so
// existing component imports stay one-stop.

import type { CategoryToken } from "./psml/renderer";

export {
  CATEGORY_TO_TOKEN,
  tokenToCssVar,
  type ColorToken,
} from "./render-tokens";

// Human-readable labels for the semantic categories used in the legend.
export const CATEGORY_LABELS: Record<CategoryToken, string> = {
  addressing: "Addressing",
  identifier: "Identifier / sequencing",
  length: "Length / size",
  type: "Type / protocol selector",
  flags: "Flags / control bits",
  reserved: "Reserved / padding",
  checksum: "Checksum / integrity",
  variable: "Variable-length options",
  "payload-marker": "Payload marker",
};

export const DEFAULT_BYTE_ORDER =
  "Network byte order (big-endian, MSB-first).";

// Curriculum-ordered grouping of presets by OSI layer.
export const PRESET_GROUPS: ReadonlyArray<{ label: string; keys: string[] }> = [
  { label: "Layer 2 — Link", keys: ["ethernet", "vlan", "arp", "stpBpdu"] },
  { label: "Layer 3 — Network", keys: ["ipv4", "ipv6", "icmp", "icmpv6", "ospfHello", "isisLsp"] },
  { label: "Layer 4 — Transport", keys: ["tcp", "udp", "sctp", "quicShort", "quicLong"] },
  {
    label: "Layer 7 — Application",
    keys: ["dns", "tlsRecord", "tlsClientHello", "tlsClientHelloFull"],
  },
];

export const THEME_STORAGE_KEY = "packet-view-theme";
