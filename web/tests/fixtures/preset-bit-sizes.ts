// Expected totalBits for every PSDL preset under its initial state. After
// Round 6 every preset is a PSDL Packet and these numbers are produced by
// `resolveLayout`; the totals are also the canonical "default" sizes the
// README documents.
//
// `EXPECTED_TOTAL_BITS` covers the original 13 presets that ship with the
// picker. `EXPECTED_TOTAL_BITS_PSDL_ONLY` extends that with the encrypted
// presets (quicLong, tlsClientHelloFull) added in PSDL 0.3 Phase 2C.

export const EXPECTED_TOTAL_BITS: Record<string, number> = {
  ipv4: 160,
  tcp: 160,
  udp: 64,
  dns: 96,
  ethernet: 112,
  ipv6: 320,
  icmp: 64,
  icmpv6: 64,
  // ARP (RFC 826) — 5 fixed fields (htype 16 + ptype 16 + hlen 8 + plen 8 +
  // oper 16 = 64 bits). The four address fields (sha/spa/tha/tpa) are
  // bytes<n = ref(hlen|plen)>; the 0.5 preset no longer seeds hlen/plen
  // defaults, so under the all-refs-zero env they collapse to 0 → 64.
  arp: 64,
  tlsRecord: 40,
  // TLS ClientHello (RFC 8446 §4.1.2) — under the all-refs-zero env every
  // variable-length section (session id / cipher suites / extensions, all
  // bytes<n = ref(...)>) collapses to 0; only the fixed header rows remain.
  tlsClientHello: 352,
  // quicShort encrypted region carries wireBits=136 in the published 0.5
  // preset, so wire-mode (and semantic) total is 216.
  quicShort: 216,
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
  // 0 bytes. NLRI is bytes<remaining>; under resolveLayout's totalBits
  // 2-pass it materialises as a single trailing rowBits (32) placeholder
  // row on top of the 184-bit fixed minimum → 216.
  bgpUpdate: 216,
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
 * PSDL 0.4 demo presets — minimal fixtures exercising one new primitive each.
 * Bit totals use the same "all refs default to 0" env that `buildEnv()`
 * synthesises in `layout-parity.test.ts`.
 *
 *   * http2FrameHeader  — 9-byte header (72 bits) + 0-byte payload at default.
 *   * tlsExtensionsBlock — Repeat count refs default to 0 → no extensions.
 *   * pcieTlpFragment   — 8 + 32 + 16 + 8 = 64 fixed bits.
 */
export const EXPECTED_TOTAL_BITS_PSDL_04: Record<string, number> = {
  http2FrameHeader: 72,
  tlsExtensionsBlock: 0,
  pcieTlpFragment: 64,
};

/**
 * PSDL-only presets added in Phase 2C. Wire-mode totalBits — the on-the-wire
 * encoding with every Encrypted container collapsed to its `wireBits` (or
 * to the sum of its plaintext bit widths when `wireBits` is absent).
 */
export const EXPECTED_TOTAL_BITS_PSDL_ONLY: Record<string, number> = {
  // quicLong encrypted region carries wireBits=136 in the published 0.5
  // preset, so wire-mode (and semantic) total is 328.
  quicLong: 328,
  // tlsClientHelloFull was rebuilt for PSDL 0.5; its wire-mode total grew
  // from 1032 to 1416 bits. (The encrypted region resolves to identical
  // wire/semantic totals — no plaintext expansion — so semantic == wire.)
  tlsClientHelloFull: 1416,
};

/**
 * Semantic-mode totalBits — Encrypted containers expand to their plaintext
 * substructure. Used to assert that toggling viewMode actually changes the
 * layout (the renderer's "Decrypted view" toggle relies on this).
 */
export const EXPECTED_TOTAL_BITS_SEMANTIC: Record<string, number> = {
  quicShort: 216,
  quicLong: 328,
  // tlsClientHelloFull rebuilt for PSDL 0.5: semantic-mode total is 1416 —
  // equal to wire-mode (the encrypted region does not expand in semantic
  // view). Previously 1080.
  tlsClientHelloFull: 1416,
};

export const PRESET_KEYS = Object.keys(EXPECTED_TOTAL_BITS);
export const PSDL_ONLY_PRESET_KEYS = Object.keys(EXPECTED_TOTAL_BITS_PSDL_ONLY);
export const PSDL_04_PRESET_KEYS = Object.keys(EXPECTED_TOTAL_BITS_PSDL_04);
