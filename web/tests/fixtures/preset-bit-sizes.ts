// Expected totalBits for every PSML preset under its initial state. The
// runtime resolver and the PSML layout adapter must both produce these
// numbers; they are also the canonical "default" sizes the README documents.

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
  quicShort: 80,
  vlan: 144,
};

export const PRESET_KEYS = Object.keys(EXPECTED_TOTAL_BITS);
