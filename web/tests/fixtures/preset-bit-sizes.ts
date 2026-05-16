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
