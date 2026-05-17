// Expected totalBits for every PSML preset under its initial state. After
// Round 6 every preset is a PSML Packet and these numbers are produced by
// `resolveLayout`; the totals are also the canonical "default" sizes the
// README documents.
//
// `EXPECTED_TOTAL_BITS` covers the original 13 presets that ship with the
// picker. `EXPECTED_TOTAL_BITS_PSML_ONLY` extends that with the encrypted
// presets (quicLong, tlsClientHelloFull) added in PSML 0.3 Phase 2C.

export const EXPECTED_TOTAL_BITS: Record<string, number> = {
  ipv4: 160,
  tcp: 160,
  udp: 64,
  dns: 96,
  ethernet: 112,
  ipv6: 320,
  icmp: 64,
  icmpv6: 64,
  arp: 224,
  tlsRecord: 40,
  tlsClientHello: 648,
  quicShort: 208,
  vlan: 144,
  // STP Configuration BPDU (IEEE 802.1D-1998) is a fixed 35-byte payload.
  stpBpdu: 280,
  // OSPFv2 Hello (RFC 2328) — 24 B common header + 20 B Hello fixed; the
  // Neighbor List is a Repeat<count = ref(ospfNeighborCount)> which defaults
  // to 0 under the all-refs-zero env used by `layout-parity.test.ts`.
  ospfHello: 352,
  // IS-IS LSP (ISO 10589 §9.8 / RFC 1142) — 8 B common header + 19 B LSP-
  // specific header = 27 B. The TLV repeat defaults to 0 under env=0.
  isisLsp: 216,
  // SCTP (RFC 9260) — 12 B common header; the Chunks repeat defaults to 0.
  sctp: 96,
  // DHCPv4 (RFC 2131 §2 + RFC 2132) — 236 B BOOTP-compatible fixed header +
  // 4 B Magic Cookie. Options repeat defaults to 0 under env=0.
  dhcpv4: 1920,
  // BGP-4 UPDATE (RFC 4271 §4.1 + §4.3) — 19 B Common Header + 2 B Withdrawn
  // Length + 2 B Total Path Attribute Length. The three opaque variable-
  // length sections (Withdrawn Routes / Path Attributes / NLRI) default to
  // 0 bytes — matching the spec's stated 23-octet minimum UPDATE.
  bgpUpdate: 184,
  // CoAP (RFC 7252 §3) — 4 B fixed header. Token (bytes n=ref(tkl)) and the
  // Options Repeat / Payload Optional all collapse to 0 at env=0.
  coap: 32,
  // MQTT v3.1.1 CONNECT (OASIS §3.1) — 1 B Fixed Header type/flags +
  // 1 B Remaining Length placeholder + 10 B Variable Header (Protocol Name
  // length+payload + Level + Flags + Keep Alive) + 2 B Client Identifier
  // Length. Will / Username / Password Optional fields all gate to 0.
  mqttConnect: 112,
  // WebSocket frame (RFC 6455 §5.2) — 2 B fixed header. Extended payload
  // length Switch hits its empty default (0..125 inline) at env=0, Masking
  // Key Optional erases at MASK=0, Payload bytes(n=ref) is 0.
  websocketFrame: 16,
  // IEEE 802.11 MAC Data Frame header (IEEE 802.11-2020 §9.2.4) — 24 B basic
  // form (Frame Control 2 + Duration 2 + Addr1-3 18 + Sequence Control 2).
  // Address 4 Optional uses `op("*", ref(toDS), ref(fromDS))` (AND via
  // product of 1-bit fields) and HT Control gates on `ref(order)` — both
  // erase at env=0.
  ieee80211Mac: 192,
};

/**
 * PSML 0.4 demo presets — minimal fixtures exercising one new primitive each.
 * Bit totals use the same "all refs default to 0" env that `buildEnv()`
 * synthesises in `layout-parity.test.ts`.
 *
 *   * http2FrameHeader  — 9-byte header (72 bits) + 0-byte payload at default.
 *   * tlsExtensionsBlock — Repeat count refs default to 0 → no extensions.
 *   * pcieTlpFragment   — 8 + 32 + 16 + 8 = 64 fixed bits.
 */
export const EXPECTED_TOTAL_BITS_PSML_04: Record<string, number> = {
  http2FrameHeader: 72,
  tlsExtensionsBlock: 0,
  pcieTlpFragment: 64,
};

/**
 * PSML-only presets added in Phase 2C. Wire-mode totalBits — the on-the-wire
 * encoding with every Encrypted container collapsed to its `wireBits` (or
 * to the sum of its plaintext bit widths when `wireBits` is absent).
 */
export const EXPECTED_TOTAL_BITS_PSML_ONLY: Record<string, number> = {
  quicLong: 320,
  tlsClientHelloFull: 1032,
};

/**
 * Semantic-mode totalBits — Encrypted containers expand to their plaintext
 * substructure. Used to assert that toggling viewMode actually changes the
 * layout (the renderer's "Decrypted view" toggle relies on this).
 */
export const EXPECTED_TOTAL_BITS_SEMANTIC: Record<string, number> = {
  quicShort: 216,
  quicLong: 328,
  tlsClientHelloFull: 1080,
};

export const PRESET_KEYS = Object.keys(EXPECTED_TOTAL_BITS);
export const PSML_ONLY_PRESET_KEYS = Object.keys(EXPECTED_TOTAL_BITS_PSML_ONLY);
export const PSML_04_PRESET_KEYS = Object.keys(EXPECTED_TOTAL_BITS_PSML_04);
