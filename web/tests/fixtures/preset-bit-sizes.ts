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
  // DNS response (RFC 1035 §4.1) — 12-byte fixed header only. The Question and
  // Resource Record (Answer/Authority/Additional) sections are Repeats whose
  // counts (QDCOUNT/ANCOUNT/NSCOUNT/ARCOUNT) default to 0 under the all-refs-
  // zero env, so no labels or records are expanded.
  dnsResponse: 96,
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
  // OSPFv2 Database Description (RFC 2328 §A.3.3, packet type 2) — 24 B common
  // header + 8 B DD body (Interface MTU 2 + Options 1 + Flags 1 + DD Sequence
  // Number 4) = 32 B. The LSA Header List is a Repeat<count =
  // ref(ospfLsaHeaderCount)> which defaults to 0 under the all-refs-zero env.
  ospfDbDescription: 256,
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
  // BGP-4 UPDATE full (RFC 4271 §4.1 + §4.3 / RFC 4760) — same 19 B Common
  // Header + 2 B Withdrawn Length + 2 B Total Path Attribute Length as the
  // simple version. Withdrawn Routes / Path Attributes / NLRI are now Repeats
  // (count=ref) and the Path Attribute Value is a Type-Code Switch; all
  // collapse to 0 / the 1-byte-length default at env=0.
  bgpUpdateFull: 184,
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
  // PPP (RFC 1661) — 6-byte fixed header (Flag 1 + Address 1 + Control 1 +
  // Protocol 2 + FCS 1 placeholder). Information and Padding collapse to 0.
  ppp: 48,
  // MPLS (RFC 3032) — 4-byte fixed label stack entry.
  mpls: 32,
  // L2TP (RFC 2661) — 6-byte minimal fixed header (Flags/Ver 2 + Length 2 +
  // Session ID 2). Tunnel ID / Ns / Nr optional fields erase at env=0.
  l2tp: 48,
  // IGMPv3 Membership Query (RFC 3376) — 12-byte fixed header, 0 source
  // addresses at default.
  igmpv3Query: 96,
  // GRE (RFC 2784) — 4-byte minimal fixed header (Flags/Ver 2 + Protocol 2).
  gre: 32,
  // IPsec AH (RFC 4302) — 12-byte fixed header (Next Header 1 + Payload Len 1
  // + Reserved 2 + SPI 4 + Sequence 4).
  ipsecAh: 96,
  // IPsec ESP (RFC 4303) — 10-byte fixed header/trailer stub (SPI 4 + Seq 4 +
  // Pad Length 1 + Next Header 1). Encrypted payload collapses to 0.
  ipsecEsp: 80,
  // RIPv2 (RFC 2453) — 4-byte fixed header (Command 1 + Version 1 + Reserved
  // 2). Route Table Entries repeat defaults to 0.
  ripv2: 32,
  // PIM Hello (RFC 7761 §4.9.2) — 4-byte fixed header (Type/Ver 1 + Reserved
  // 1 + Checksum 2). Options repeat defaults to 0.
  pimHello: 32,
  // IPv6 Fragment Extension Header (RFC 8200 §4.5) — 8-byte fixed header
  // (Next Header 1 + Reserved 1 + Fragment Offset+Flags 2 + Identification 4).
  ipv6Fragment: 64,
  // IPv6 Hop-by-Hop Options Extension Header (RFC 8200 §4.3) — 8-byte minimal
  // fixed header (Next Header 1 + Hdr Ext Len 1 + Options 6). Options Repeat
  // defaults to 0.
  ipv6HopByHop: 64,
  // VXLAN (RFC 7348) — 8-byte fixed header (Flags 1 + Reserved 3 + VNI 3 +
  // Reserved 1).
  vxlan: 64,
  // Geneve (RFC 8926) — 8-byte fixed header (Ver/OAM/Crit/Rsv 1 + Opt Len 1 +
  // Protocol 2 + VNI+Reserved 4). Options Repeat defaults to 0.
  geneve: 64,
  // DCCP (RFC 4340 §5.1) — 12-byte fixed generic header (Src Port 2 + Dst
  // Port 2 + Data Offset 1 + CCVal/CsCov 1 + Checksum 2 + Res/Type/X 1 +
  // Sequence Number High 1 + Sequence Number Low 2).
  dccp: 96,
  // NTP (RFC 5905 §7.3) — 48-byte fixed header.
  ntp: 384,
  // DHCPv6 (RFC 8415 §8) — 4-byte fixed header (Msg-Type 1 + Transaction-ID
  // 3). Options Repeat defaults to 0.
  dhcpv6: 32,
  // RTP (RFC 3550 §5.1) — 12-byte fixed header (V/P/X/CC/M/PT/Seq 4 +
  // Timestamp 4 + SSRC 4). CSRC list and Extension collapse to 0 at env=0.
  rtp: 96,
  // RTCP Sender Report (RFC 3550 §6.4.1) — 28-byte fixed header (V/P/RC/PT/
  // Length 4 + SSRC 4 + NTP Timestamp 8 + RTP Timestamp 4 + Packet/Octet
  // Count 8). Report Blocks repeat defaults to 0.
  rtcpSr: 224,
  // RADIUS (RFC 2865 §3) — 20-byte fixed header (Code 1 + Identifier 1 +
  // Length 2 + Authenticator 16). Attributes repeat defaults to 0.
  radius: 160,
  // BGP OPEN (RFC 4271 §4.2) — 29-byte fixed header (19 B Common + Version 1
  // + AS 2 + Hold Time 2 + BGP Identifier 4 + Opt Param Len 1). Optional
  // Parameters repeat defaults to 0.
  bgpOpen: 232,
  // BGP NOTIFICATION (RFC 4271 §4.5) — 21-byte fixed (19 B Common + Error
  // Code 1 + Error Subcode 1). Data bytes repeat defaults to 0.
  bgpNotification: 168,
  // STUN (RFC 8489 §5) — 20-byte fixed header (Type 2 + Length 2 + Magic
  // Cookie 4 + Transaction ID 12). Attributes repeat defaults to 0.
  stun: 160,
  // DTLS 1.2 Record (RFC 6347 §4.3.1) — 13-byte fixed header (Content Type 1
  // + Version 2 + Epoch 2 + Sequence 6 + Length 2).
  dtlsRecord: 104,
  // SSH Binary Packet (RFC 4253 §6) — 5-byte fixed header stub (Packet Length
  // 4 + Padding Length 1). Payload / Padding / MAC collapse to 0 at env=0.
  sshBinary: 40,
  // ICMPv6 Neighbor Discovery (RFC 4861 §4 / RFC 4443 §2.1) — 4-byte fixed
  // ICMPv6 header (Type 1 + Code 1 + Checksum 2). The message body is a Switch
  // on Type and the NDP Options are Repeats; both collapse to 0 at env=0
  // (Type=0 selects no modelled case), leaving the bare 32-bit header.
  icmpv6Ndp: 32,
  // --- New protocols (PSDL YAML batch). Measured under the all-refs-zero env
  // synthesised by `layout-parity.test.ts` (every Repeat/Switch count and
  // `bytes n=ref(...)` width collapses to 0). ---
  // PPPoE (RFC 2516) — 6-byte Discovery/Session header (Ver/Type 1 + Code 1 +
  // Session ID 2 + Length 2). TLV tags repeat defaults to 0.
  pppoe: 48,
  // LLDP (IEEE 802.1AB) — body is a single TLV Repeat whose count refs default
  // to 0, so no TLV rows are expanded.
  lldp: 0,
  // EAPOL (IEEE 802.1X) — 4-byte header (Version 1 + Type 1 + Length 2).
  eapol: 32,
  // EAP (RFC 3748) — 4-byte header (Code 1 + Identifier 1 + Length 2).
  eap: 32,
  // LACP (IEEE 802.1AX / 802.3ad) — fixed 60-byte PDU.
  lacp: 480,
  // MACsec (IEEE 802.1AE) — 8-byte SecTAG (TCI/AN 1 + SL 1 + PN 4 + SCI stub).
  macsec: 64,
  // VRRP (RFC 5798) — 8-byte fixed header; IP address list repeat defaults to 0.
  vrrp: 64,
  // IGMPv2 (RFC 2236) — 8-byte fixed message.
  igmpv2: 64,
  // MLDv2 Query (RFC 3810) — 28-byte fixed header; source list defaults to 0.
  mldv2Query: 224,
  // BFD (RFC 5880) — 24-byte fixed control packet.
  bfd: 192,
  // OSPFv3 Hello (RFC 5340) — 16-byte OSPFv3 header + 20-byte Hello body
  // (Interface ID 4 + Rtr Pri/Options 4 + Hello/Dead Interval 4 + DR 4 + BDR 4)
  // minus packing = 287 bits at env=0; neighbor list repeat defaults to 0.
  ospfv3Hello: 287,
  // IPv6 Routing Extension Header (RFC 8200 §4.4) — 2-byte fixed prefix
  // (Next Header 1 + Hdr Ext Len 1); type-specific data repeat defaults to 0.
  ipv6Routing: 64,
  // IPv6 Destination Options Extension Header (RFC 8200 §4.6) — 2-byte fixed
  // prefix; options repeat defaults to 0.
  ipv6Destination: 16,
  // RSVP Path (RFC 2205) — 8-byte common header; object repeat defaults to 0.
  rsvpPath: 64,
  // RIPng (RFC 2080) — 4-byte fixed header; route table entries repeat to 0.
  ripng: 32,
  // UDP-Lite (RFC 3828) — 8-byte fixed header.
  udpLite: 64,
  // GTPv1-U (3GPP TS 29.281) — 8-byte fixed mandatory header.
  gtpv1u: 64,
  // GTPv2-C (3GPP TS 29.274) — 8-byte fixed header (TEID-less form at env=0).
  gtpv2c: 64,
  // Teredo (RFC 4380) — every Indicator field is gated Optional (erases at
  // env=0) and the trailing IPv6 payload is bytes(n=ref)=0, leaving 0 bits.
  teredo: 0,
  // LISP (RFC 6830) — 8-byte data header.
  lisp: 64,
  // VXLAN-GPE (draft-ietf-nvo3-vxlan-gpe) — 8-byte header.
  vxlanGpe: 64,
  // SNMPv2c (RFC 1901 / RFC 3416) — 8-byte fixed prefix at env=0.
  snmpV2c: 64,
  // TFTP (RFC 1350) — 2-byte Opcode; filename/mode strings default to 0.
  tftp: 16,
  // Syslog (RFC 5424) — 11-byte fixed header prefix at env=0.
  syslog: 88,
  // Diameter (RFC 6733) — 20-byte fixed header; AVP repeat defaults to 0.
  diameter: 160,
  // IKEv2 (RFC 7296) — 28-byte fixed header; payload repeat defaults to 0.
  ikev2: 224,
  // BGP KEEPALIVE (RFC 4271 §4.4) — 19-byte common header only.
  bgpKeepalive: 152,
  // BGP ROUTE-REFRESH (RFC 2918) — 19-byte common header + 4-byte body
  // (AFI 2 + Reserved 1 + SAFI 1) = 23 octets.
  bgpRouteRefresh: 184,
  // HTTP/3 Frame (RFC 9114) — leads with two QUIC varints sized 0 bits under
  // the all-refs-zero env, and the Type=0 DATA case carries a 0-byte payload.
  http3Frame: 0,
  // TLS ServerHello (RFC 8446 §4.1.3) — 44-byte fixed prefix at env=0.
  tlsServerHello: 352,
  // TLS Handshake (RFC 8446 §4) — 4-byte generic handshake header.
  tlsHandshake: 32,
  // IPFIX (RFC 7011) — 16-byte Message Header; Sets repeat defaults to 0.
  ipfix: 128,
  // NetFlow v5 — 24-byte export header; flow record repeat defaults to 0.
  netflowV5: 192,
  // QUIC Version Negotiation (RFC 9000 §17.2.1) — 8-byte fixed prefix at env=0.
  quicVersionNegotiation: 64,
  // --- New protocols (RFC-defined YAML batch, 34). Placeholder totals (32);
  // corrected against resolveLayout under the all-refs-zero env during Validate. ---
  // RIPv1 (RFC 1058) — fixed header; route entries repeat defaults to 0.
  ripv1: 32,
  // OSPFv2 LS Update (RFC 2328 §A.3.5) — LSA repeat defaults to 0.
  ospfLsUpdate: 224,
  // OSPFv2 LS Acknowledgment (RFC 2328 §A.3.6) — LSA header repeat defaults to 0.
  ospfLsAck: 192,
  // OSPFv2 LS Request (RFC 2328 §A.3.4) — request entry repeat defaults to 0.
  ospfLsRequest: 192,
  // Babel (RFC 8966) — 4-byte header; TLV repeat defaults to 0.
  babel: 32,
  // PIM Join/Prune (RFC 7761 §4.9.5) — fixed header; group repeat defaults to 0.
  pimJoinPrune: 112,
  // PIM Register (RFC 7761 §4.9.1) — fixed header.
  pimRegister: 64,
  // IGMPv3 Membership Report (RFC 3376 §4.2) — group record repeat defaults to 0.
  igmpv3Report: 64,
  // MLDv2 Report (RFC 3810 §5.2) — multicast address record repeat defaults to 0.
  mldv2Report: 64,
  // ICMP Router Advertisement (RFC 1256) — fixed header; address repeat to 0.
  icmpRouterAdvert: 64,
  // MSDP (RFC 3618) — TLV header; SA entry repeat defaults to 0.
  msdp: 24,
  // EIGRP (RFC 7868) — fixed header; TLV repeat defaults to 0.
  eigrp: 160,
  // Mobility Header (RFC 6275 §6.1) — fixed header; mobility options repeat to 0.
  mobilityHeader: 48,
  // HIP (RFC 7401 §5.1) — fixed header; HIP parameters repeat defaults to 0.
  hip: 320,
  // IP-in-IP (RFC 2003) — encapsulated IP payload bytes(n=ref) collapse to 0.
  ipinip: 320,
  // NVGRE (RFC 7637) — 8-byte header.
  nvgre: 64,
  // L2TPv3 (RFC 3931) — fixed session header; AVPs collapse to 0.
  l2tpv3: 32,
  // ESP-in-UDP (RFC 3948) — UDP-encapsulated ESP; encrypted payload collapses to 0.
  espInUdp: 128,
  // AMT (RFC 7450) — fixed message header.
  amt: 64,
  // ISAKMP (RFC 2408) — fixed header; payload repeat defaults to 0.
  isakmp: 224,
  // OCSP Request (RFC 6960 §4.1.1) — request structure collapses to 0 at env=0.
  ocspRequest: 48,
  // SOCKS5 (RFC 1928) — version/command prefix; variable address collapses to 0.
  socks5: 80,
  // TACACS+ (RFC 8907) — 12-byte fixed header; body collapses to 0.
  tacacsPlus: 96,
  // SNMPv3 (RFC 3412) — message header prefix; scoped PDU collapses to 0 at env=0.
  snmpv3: 152,
  // PCP (RFC 6887 §7.1) — fixed request/response header.
  pcp: 192,
  // NAT-PMP (RFC 6886) — fixed header.
  natPmp: 16,
  // SLP (RFC 2608) — fixed header prefix; URL entries collapse to 0.
  slp: 112,
  // RTCP Receiver Report (RFC 3550 §6.4.2) — fixed header; report blocks repeat to 0.
  rtcpRr: 64,
  // RTCP SDES (RFC 3550 §6.5) — fixed header; SDES chunks repeat default to 0.
  rtcpSdes: 32,
  // RTCP BYE (RFC 3550 §6.6) — fixed header; SSRC list repeat defaults to 0.
  rtcpBye: 32,
  // TURN ChannelData (RFC 8656 §12.4) — 4-byte header; data bytes(n=ref) to 0.
  turnChannelData: 32,
  // BMP (RFC 7854 §4.1) — 6-byte common header; per-message body collapses to 0.
  bmp: 384,
  // PCEP (RFC 5440 §6.1) — 4-byte common header; objects repeat default to 0.
  pcep: 32,
  // LDP (RFC 5036 §3.1) — fixed PDU header; messages repeat default to 0.
  ldp: 80,
  // --- New protocols (RFC-defined YAML batch, 30). Placeholder totals (32);
  // corrected against resolveLayout under the all-refs-zero env during Validate. ---
  // DNSSEC Resource Records (RFC 4034).
  dnssecRecords: 96,
  // EDNS0 OPT pseudo-RR (RFC 6891).
  ednsOpt: 88,
  // LLMNR (RFC 4795).
  llmnr: 96,
  // NetBIOS Name Service (RFC 1002).
  netbiosNs: 96,
  // NSH — Network Service Header (RFC 8300).
  nsh: 64,
  // SRv6 Segment Routing Header (RFC 8754).
  srhv6: 64,
  // MPLS Pseudowire Control Word (RFC 4385).
  mplsPwControlWord: 32,
  // TWAMP (RFC 5357).
  twamp: 128,
  // OWAMP (RFC 4656).
  owamp: 112,
  // LISP Map-Request (RFC 6833).
  lispMapRequest: 112,
  // LISP Map-Reply (RFC 6833).
  lispMapReply: 96,
  // RADIUS CoA (RFC 5176).
  radiusCoa: 160,
  // COPS (RFC 2748).
  cops: 96,
  // ONC RPC (RFC 5531).
  oncRpc: 320,
  // Portmapper (RFC 1833).
  portmap: 128,
  // iSCSI Basic Header Segment (RFC 7143).
  iscsiBhs: 384,
  // TLS Alert (RFC 8446).
  tlsAlert: 16,
  // TLS ChangeCipherSpec (RFC 5246).
  tlsChangeCipherSpec: 8,
  // DTLS Handshake (RFC 6347).
  dtlsHandshake: 96,
  // SEND — Secure Neighbor Discovery (RFC 3971) — 2-byte option header
  // (Type 1 + Length 1); the type-specific Switch body collapses to 0 at env=0.
  send: 16,
  // DVMRP (RFC 1075).
  dvmrp: 64,
  // PIM Assert (RFC 7761).
  pimAssert: 208,
  // PIM Bootstrap (RFC 5059).
  pimBootstrap: 120,
  // BGP FlowSpec (RFC 8955).
  bgpFlowSpec: 8,
  // PSAMP (RFC 5476).
  psamp: 128,
  // ANCP (RFC 6320).
  ancp: 328,
  // GIST (RFC 5971).
  gist: 64,
  // SCTP-AUTH chunk (RFC 4895).
  sctpAuth: 64,
  // ROHC Uncompressed profile (RFC 5795).
  rohcUncompressed: 24,
  // Kerberos AS-REQ (RFC 4120).
  kerberosAsReq: 128,
  // --- New protocols (RFC-defined YAML batch, 30). Placeholder totals (32);
  // corrected against resolveLayout under the all-refs-zero env during Validate. ---
  // CAPWAP (RFC 5415).
  capwap: 64,
  // GTPv1-C (3GPP TS 29.060).
  gtpv1c: 64,
  // DHCPv6 Relay-Forward/Relay-Reply message (RFC 8415 §9).
  dhcpv6Relay: 272,
  // BOOTP (RFC 951).
  bootp: 2400,
  // PIM Hello with options (RFC 7761 §4.9.2).
  pimHelloOptions: 64,
  // OSPFv3 LS Update (RFC 5340).
  ospfv3LsUpdate: 160,
  // RSVP-TE (RFC 3209).
  rsvpTe: 96,
  // BGP-LS (RFC 7752).
  bgpLs: 104,
  // IKEv2 Security Association payload (RFC 7296 §3.3).
  ikev2Sa: 32,
  // IKEv2 Key Exchange payload (RFC 7296 §3.4).
  ikev2Ke: 64,
  // IKEv2 Notify payload (RFC 7296 §3.10).
  ikev2Notify: 64,
  // CoAP Signaling messages (RFC 8323).
  coapSignaling: 16,
  // OSCORE (RFC 8613).
  oscore: 10,
  // LwM2M Register (OMA / RFC 7252-based).
  lwm2mRegister: 0,
  // NFSv3 READ (RFC 1813).
  nfsv3Read: 128,
  // SMB header (RFC / MS-CIFS / MS-SMB2).
  smbHeader: 512,
  // TLS NewSessionTicket (RFC 8446 §4.6.1).
  tlsNewSessionTicket: 136,
  // TLS Certificate (RFC 8446 §4.4.2).
  tlsCertificate: 72,
  // DTLS ClientHello (RFC 6347).
  dtlsClientHello: 416,
  // sFlow (RFC 3176).
  sflow: 224,
  // VRRPv2 (RFC 3768).
  vrrpv2: 128,
  // PGM — Pragmatic General Multicast (RFC 3208).
  pgm: 192,
  // RTMP (Adobe Real-Time Messaging Protocol).
  rtmp: 96,
  // Syslog over TLS (RFC 5425).
  syslogTls: 32,
  // RADIUS Accounting (RFC 2866).
  radiusAccounting: 168,
  // L2TP control message (RFC 2661).
  l2tpControl: 96,
  // NTP Control message (RFC 1305 / RFC 5905 mode 6).
  ntpControl: 96,
  // mDNS — Multicast DNS (RFC 6762).
  mdns: 96,
  // DNS UPDATE (RFC 2136).
  dnsUpdate: 96,
  // TSIG (RFC 8945).
  tsig: 224,
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
export const PSDL_ONLY_PRESET_KEYS = Object.keys(EXPECTED_TOTAL_BITS_PSDL_ONLY);
export const PSDL_04_PRESET_KEYS = Object.keys(EXPECTED_TOTAL_BITS_PSDL_04);
