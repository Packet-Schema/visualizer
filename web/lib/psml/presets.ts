// PSML 0.3 — Packet Schema Markup Language.
// Hand-written PSML presets. After Round 6 this file is the canonical home
// of every preset shipped with packet-view; the Typst-driven runtime
// resolver and its auto-generated registry were retired.
//
// IPv4 — variable-length Options expressed as a Repeat over a Switch on the
//        option Type byte, plus a Constraint linking IHL ⇔ headerBytes.
// TCP  — same shape: Repeat<Switch on Kind> for Options, Data Offset ⇔
//        tcpHeaderBytes constraint.
// UDP  — pure fixed layout.
// Ethernet — pure fixed layout.
//
// PSML 0.3 — Phase 2C additions exercise the Encrypted container and
// Varint primitives end-to-end:
//   * quicShort       — header-protection + payload Encrypted (overrides
//                       the flat shape in baseline-presets.ts).
//   * quicLong        — Long Header with Switch over Initial/0-RTT/Handshake/
//                       Retry and an encrypted Payload.
//   * tlsClientHelloFull — TLS 1.3 ClientHello + ServerHello/post-handshake
//                       encrypted block.
//
// The simpler 9 presets (dns, ipv6, icmp, icmpv6, arp, tlsRecord,
// tlsClientHello, vlan, plus a flat quicShort baseline) live alongside in
// `baseline-presets.ts` and are merged into the exported `PRESETS` map below.

import { lit, op, ref } from "./expr";
import type { Container, Encrypted, Packet, Struct } from "./types";
import { BASELINE_PRESETS } from "./baseline-presets";

/* ------------------------------------------------------------------ *
 * Small helpers — keep preset definitions terse and consistent.
 * ------------------------------------------------------------------ */

const bits = (n: number) => ({ kind: "bits" as const, n });
const int = (n: number) => ({ kind: "int" as const, bits: n });

function group(id: string, children: Container[]): Container {
  return { kind: "group", id, children };
}

function struct(id: string, fields: Container[]): Struct {
  return { id, fields };
}

/* ------------------------------------------------------------------ *
 * IPv4
 * ------------------------------------------------------------------ */

const ipv4OptionVariants: Record<string, Struct> = {
  // EOL — single byte type=0.
  "0": struct("eol", [
    {
      id: "type",
      name: "Type=0",
      type: bits(8),
      category: "type",
    },
  ]),
  // NOP — single byte type=1.
  "1": struct("nop", [
    {
      id: "type",
      name: "Type=1",
      type: bits(8),
      category: "type",
    },
  ]),
  // Record Route (kind=7) — type + length + pointer + 3 × 32-bit addr slots
  // (mirrors v1's ipv4_record_route default extras count=3).
  "7": struct("recordRoute", [
    { id: "type", name: "Type=7", type: bits(8), category: "type" },
    { id: "length", name: "Len=15", type: bits(8), category: "length" },
    { id: "pointer", name: "Ptr", type: bits(8), category: "identifier" },
    { id: "addr0", name: "Addr 1", type: int(32), category: "addressing" },
    { id: "addr1", name: "Addr 2", type: int(32), category: "addressing" },
    { id: "addr2", name: "Addr 3", type: int(32), category: "addressing" },
  ]),
  // Loose Source Route (kind=131) — default count=2 addresses.
  "131": struct("looseSourceRoute", [
    { id: "type", name: "Type=131", type: bits(8), category: "type" },
    { id: "length", name: "Len=11", type: bits(8), category: "length" },
    { id: "pointer", name: "Ptr", type: bits(8), category: "identifier" },
    { id: "addr0", name: "Addr 1", type: int(32), category: "addressing" },
    { id: "addr1", name: "Addr 2", type: int(32), category: "addressing" },
  ]),
  // Strict Source Route (kind=137).
  "137": struct("strictSourceRoute", [
    { id: "type", name: "Type=137", type: bits(8), category: "type" },
    { id: "length", name: "Len=11", type: bits(8), category: "length" },
    { id: "pointer", name: "Ptr", type: bits(8), category: "identifier" },
    { id: "addr0", name: "Addr 1", type: int(32), category: "addressing" },
    { id: "addr1", name: "Addr 2", type: int(32), category: "addressing" },
  ]),
  // Timestamp (kind=68) — default count=2 timestamps.
  "68": struct("timestamp", [
    { id: "type", name: "Type=68", type: bits(8), category: "type" },
    { id: "length", name: "Len=12", type: bits(8), category: "length" },
    { id: "pointer", name: "Ptr", type: bits(8), category: "identifier" },
    { id: "oflwflg", name: "Oflw/Flg", type: bits(8), category: "flags" },
    { id: "ts0", name: "TS 1", type: int(32), category: "identifier" },
    { id: "ts1", name: "TS 2", type: int(32), category: "identifier" },
  ]),
};

export const ipv4: Packet = {
  name: "IPv4 Header",
  rowBits: 32,
  byteOrder: "BE",
  description: "IPv4 header (RFC 791) — IHL drives the Options length.",
  body: [
    { id: "version", name: "Version", type: bits(4), category: "type", defaultValue: 4 },
    {
      id: "ihl",
      name: "IHL",
      type: bits(4),
      category: "length",
      defaultValue: 5,
    },
    { id: "dscp", name: "DSCP", type: bits(6), category: "type" },
    { id: "ecn", name: "ECN", type: bits(2), category: "flags" },
    {
      id: "totalLength",
      name: "Total Length",
      type: int(16),
      category: "length",
    },
    {
      id: "identification",
      name: "Identification",
      type: int(16),
      category: "identifier",
    },
    // Flags is laid out flat (3 bits) — v2 expands subfields via Group/nested
    // Field but the renderer cares about absolute bit offsets, so a sibling
    // group of 1-bit fields produces identical totals.
    group("flagsBits", [
      { id: "flags_reserved", name: "R", type: bits(1), category: "flags" },
      { id: "flags_df", name: "DF", type: bits(1), category: "flags" },
      { id: "flags_mf", name: "MF", type: bits(1), category: "flags" },
    ]),
    {
      id: "fragOffset",
      name: "Fragment Offset",
      type: bits(13),
      category: "identifier",
    },
    { id: "ttl", name: "TTL", type: int(8), category: "identifier" },
    { id: "protocol", name: "Protocol", type: int(8), category: "type" },
    {
      id: "headerChecksum",
      name: "Header Checksum",
      type: int(16),
      category: "checksum",
    },
    {
      id: "srcAddr",
      name: "Source Address",
      type: int(32),
      category: "addressing",
    },
    {
      id: "dstAddr",
      name: "Destination Address",
      type: int(32),
      category: "addressing",
    },
    // Options — a Repeat over a Switch on the option Type byte. count is
    // derived from the env key `ipv4OptionsCount`, mirroring v1's behaviour
    // where empty `instances` produces zero options.
    {
      kind: "repeat",
      id: "options",
      name: "Options",
      category: "variable",
      element: struct("optionRecord", [
        {
          kind: "switch",
          id: "byType",
          on: ref("optType"),
          cases: ipv4OptionVariants,
        },
      ]),
      count: ref("ipv4OptionsCount"),
    },
  ],
  constraints: [
    // IHL ⇔ headerBytes — bidirectional. IHL counts 32-bit words; one word
    // is 4 bytes. The canonical constraint is IHL * 4 == headerBytes.
    {
      lhs: op("*", ref("ihl"), lit(4)),
      rhs: ref("headerBytes"),
      doc: "IHL counts 32-bit words; total header bytes = IHL × 4.",
    },
  ],
};

/* ------------------------------------------------------------------ *
 * TCP
 * ------------------------------------------------------------------ */

const tcpOptionVariants: Record<string, Struct> = {
  "0": struct("eol", [{ id: "kind", name: "Kind=0", type: bits(8), category: "type" }]),
  "1": struct("nop", [{ id: "kind", name: "Kind=1", type: bits(8), category: "type" }]),
  "2": struct("mss", [
    { id: "kind", name: "Kind=2", type: bits(8), category: "type" },
    { id: "length", name: "Len=4", type: bits(8), category: "length" },
    { id: "mss", name: "MSS", type: int(16), category: "length" },
  ]),
  "3": struct("windowScale", [
    { id: "kind", name: "Kind=3", type: bits(8), category: "type" },
    { id: "length", name: "Len=3", type: bits(8), category: "length" },
    { id: "shift", name: "Shift", type: int(8), category: "identifier" },
  ]),
  "4": struct("sackPermitted", [
    { id: "kind", name: "Kind=4", type: bits(8), category: "type" },
    { id: "length", name: "Len=2", type: bits(8), category: "length" },
  ]),
  "5": struct("sack", [
    { id: "kind", name: "Kind=5", type: bits(8), category: "type" },
    { id: "length", name: "Len=10", type: bits(8), category: "length" },
    { id: "leftEdge", name: "Left Edge", type: int(32), category: "identifier" },
    { id: "rightEdge", name: "Right Edge", type: int(32), category: "identifier" },
  ]),
  "8": struct("timestamps", [
    { id: "kind", name: "Kind=8", type: bits(8), category: "type" },
    { id: "length", name: "Len=10", type: bits(8), category: "length" },
    { id: "tsval", name: "TS Value", type: int(32), category: "identifier" },
    { id: "tsecr", name: "TS Echo Reply", type: int(32), category: "identifier" },
  ]),
};

export const tcp: Packet = {
  name: "TCP Header",
  rowBits: 32,
  byteOrder: "BE",
  description: "TCP header (RFC 9293).",
  body: [
    { id: "srcPort", name: "Source Port", type: int(16), category: "addressing" },
    {
      id: "dstPort",
      name: "Destination Port",
      type: int(16),
      category: "addressing",
    },
    { id: "seqNum", name: "Sequence Number", type: int(32), category: "identifier" },
    {
      id: "ackNum",
      name: "Acknowledgment Number",
      type: int(32),
      category: "identifier",
    },
    {
      id: "dataOffset",
      name: "Data Offset",
      type: bits(4),
      category: "length",
      defaultValue: 5,
    },
    { id: "reserved", name: "Rsvd", type: bits(4), category: "reserved" },
    group("flagsBits", [
      { id: "flags_cwr", name: "CWR", type: bits(1), category: "flags" },
      { id: "flags_ece", name: "ECE", type: bits(1), category: "flags" },
      { id: "flags_urg", name: "URG", type: bits(1), category: "flags" },
      { id: "flags_ack", name: "ACK", type: bits(1), category: "flags" },
      { id: "flags_psh", name: "PSH", type: bits(1), category: "flags" },
      { id: "flags_rst", name: "RST", type: bits(1), category: "flags" },
      { id: "flags_syn", name: "SYN", type: bits(1), category: "flags" },
      { id: "flags_fin", name: "FIN", type: bits(1), category: "flags" },
    ]),
    { id: "window", name: "Window", type: int(16), category: "flags" },
    { id: "checksum", name: "Checksum", type: int(16), category: "checksum" },
    {
      id: "urgent",
      name: "Urgent Pointer",
      type: int(16),
      category: "identifier",
    },
    {
      kind: "repeat",
      id: "options",
      name: "Options",
      category: "variable",
      element: struct("optionRecord", [
        {
          kind: "switch",
          id: "byKind",
          on: ref("optKind"),
          cases: tcpOptionVariants,
        },
      ]),
      count: ref("tcpOptionsCount"),
    },
  ],
  constraints: [
    {
      lhs: op("*", ref("dataOffset"), lit(4)),
      rhs: ref("tcpHeaderBytes"),
      doc: "Data Offset counts 32-bit words; tcpHeaderBytes = Data Offset × 4.",
    },
  ],
};

/* ------------------------------------------------------------------ *
 * UDP
 * ------------------------------------------------------------------ */

export const udp: Packet = {
  name: "UDP Header",
  rowBits: 32,
  byteOrder: "BE",
  description: "UDP header (RFC 768) — fixed 8 bytes.",
  body: [
    { id: "srcPort", name: "Source Port", type: int(16), category: "addressing" },
    {
      id: "dstPort",
      name: "Destination Port",
      type: int(16),
      category: "addressing",
    },
    { id: "length", name: "Length", type: int(16), category: "length" },
    { id: "checksum", name: "Checksum", type: int(16), category: "checksum" },
  ],
};

/* ------------------------------------------------------------------ *
 * Ethernet II
 * ------------------------------------------------------------------ */

export const ethernet: Packet = {
  name: "Ethernet II Frame Header",
  rowBits: 32,
  byteOrder: "BE",
  description: "Ethernet II frame header — 14 bytes.",
  body: [
    {
      id: "dstMac",
      name: "Destination MAC",
      type: bits(48),
      category: "addressing",
    },
    { id: "srcMac", name: "Source MAC", type: bits(48), category: "addressing" },
    { id: "etherType", name: "EtherType", type: int(16), category: "type" },
  ],
};

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Shared building blocks for PSML 0.3 encrypted-protocol presets
 * ------------------------------------------------------------------ */

/**
 * Stub QUIC frame layout used inside the Payload Encrypted container of
 * `quicShort` and `quicLong`. A real QUIC payload is a sequence of frames,
 * each prefixed by a 1+ byte frame type (RFC 9000 §12.4). We model a single
 * frame with a Switch over three common types — STREAM (0x08), ACK (0x02),
 * CRYPTO (0x06) — and a 16-byte fixed placeholder body so the renderer has
 * something concrete to show in semantic view. The default branch keeps
 * normalize tolerant when the discriminator hasn't been seeded.
 */
function quicFramesStub(): Struct {
  const FRAME_BODY_BITS = 128;
  return struct("frames", [
    {
      id: "frameType",
      name: "Frame Type",
      type: bits(8),
      category: "type",
      defaultValue: 8, // STREAM by default
    },
    {
      kind: "switch",
      id: "frameByType",
      on: ref("frameType"),
      cases: {
        // STREAM (0x08-0x0f base) — modeled as the canonical 0x08 form.
        "8": struct("streamFrame", [
          {
            id: "stream_body",
            name: "Stream Data",
            type: bits(FRAME_BODY_BITS),
            category: "payload-marker",
            doc: "STREAM frame payload (RFC 9000 §19.8). 16-byte placeholder.",
          },
        ]),
        // ACK (0x02).
        "2": struct("ackFrame", [
          {
            id: "ack_body",
            name: "ACK Ranges",
            type: bits(FRAME_BODY_BITS),
            category: "payload-marker",
            doc: "ACK frame ranges (RFC 9000 §19.3). 16-byte placeholder.",
          },
        ]),
        // CRYPTO (0x06).
        "6": struct("cryptoFrame", [
          {
            id: "crypto_body",
            name: "CRYPTO Data",
            type: bits(FRAME_BODY_BITS),
            category: "payload-marker",
            doc: "CRYPTO frame data (RFC 9000 §19.6). 16-byte placeholder.",
          },
        ]),
      },
      default: struct("frameDefault", [
        {
          id: "frame_body",
          name: "Frame Payload",
          type: bits(FRAME_BODY_BITS),
          category: "payload-marker",
          doc: "Unknown frame type — placeholder body.",
        },
      ]),
    },
  ]);
}

/* ------------------------------------------------------------------ *
 * QUIC Short Header (1-RTT) — PSML 0.3 override
 *
 * Overrides the flat shape in presets.generated.ts to expose
 * header protection and AEAD as Encrypted containers:
 *   * `pnArea` wraps Packet Number Length + Packet Number, both tagged
 *     `headerProtected` — a real receiver applies an XOR mask derived
 *     from the AEAD sample before reading them.
 *   * `payload` carries the AEAD ciphertext; the plaintext is a single
 *     stub frame.
 * ------------------------------------------------------------------ */

const quicShortPnArea: Encrypted = {
  kind: "encrypted",
  id: "pnArea",
  name: "Header-protected PN area",
  contextNote:
    "Header protection mask (XOR) derived from the AEAD sample using the hp key — required before reading these bits.",
  headerProtected: ["pnLen", "packetNumber"],
  category: "identifier",
  plaintext: struct("pnAreaPlaintext", [
    {
      id: "pnLen",
      name: "Packet Number Length",
      type: bits(2),
      category: "length",
      doc: "Encoded length of the Packet Number field minus 1 (1–4 bytes). Header-protected. [RFC 9000 §17.3.1]",
    },
    {
      id: "packetNumber",
      name: "Packet Number",
      type: bits(8),
      category: "identifier",
      doc: "Truncated packet number — header-protected on the wire. 1–4 bytes wide. [RFC 9000 §17.1]",
    },
  ]),
};

const quicShortPayload: Encrypted = {
  kind: "encrypted",
  id: "payload",
  name: "Encrypted Payload",
  contextNote:
    "AEAD-protected QUIC frames — requires TLS 1.3 handshake outputs (1-RTT keys) to decrypt.",
  wireBits: lit(128),
  category: "payload-marker",
  plaintext: quicFramesStub(),
};

export const quicShort: Packet = {
  name: "QUIC Short Header (1-RTT)",
  rowBits: 32,
  byteOrder: "BE",
  description:
    "QUIC v1 short-header (1-RTT) packet (RFC 9000 §17.3). Connection ID length is negotiated out-of-band; this preset assumes an 8-byte Destination CID for illustration and wraps the header-protected and AEAD-protected regions in Encrypted containers.",
  body: [
    {
      id: "headerForm",
      name: "Header Form (0=Short)",
      type: bits(1),
      category: "type",
      doc: "0 = short header (1-RTT). [RFC 9000 §17.3]",
    },
    {
      id: "fixedBit",
      name: "Fixed Bit",
      type: bits(1),
      category: "reserved",
      doc: "Must be 1 in QUIC v1. [RFC 9000 §17.2]",
    },
    {
      id: "spinBit",
      name: "Spin Bit",
      type: bits(1),
      category: "flags",
      doc: "Latency spin bit — toggled once per RTT for passive on-path RTT measurement. [RFC 9000 §17.4]",
    },
    {
      id: "reserved",
      name: "Reserved",
      type: bits(2),
      category: "reserved",
      doc: "Reserved bits — protected by header protection on the wire; must decrypt to 0. [RFC 9000 §17.3.1]",
    },
    {
      id: "keyPhase",
      name: "Key Phase",
      type: bits(1),
      category: "flags",
      doc: "Identifies which set of packet-protection keys is in use; flips on key update. [RFC 9000 §6]",
    },
    {
      id: "dcid",
      name: "Destination Connection ID",
      type: bits(64),
      category: "addressing",
      doc: "Receiver-chosen Connection ID — length is negotiated out-of-band (0–20 bytes); shown here as 8 bytes.",
    },
    quicShortPnArea,
    quicShortPayload,
  ],
};

/* ------------------------------------------------------------------ *
 * QUIC Long Header (RFC 9000 §17.2)
 *
 * Long header used for Initial / 0-RTT / Handshake / Retry packets. The
 * Long Packet Type 2-bit field selects per-type tail fields via a Switch:
 *   * Initial / 0-RTT — Token Length + Token + Length + Packet Number
 *   * Handshake      — Length + Packet Number
 *   * Retry          — Retry Token + 16-byte Retry Integrity Tag (no PN)
 * Followed by an Encrypted Payload container.
 * ------------------------------------------------------------------ */

// Header-protected Packet Number — wrap each case's PN field in an Encrypted
// container with `headerProtected: ['packetNumber']` so the semantic-view
// renderer can decorate the cell with an "HP" badge. The wireBits is set to
// 8 (matching the truncated PN width modeled here) so wire-mode totals stay
// unchanged from the pre-fix preset.
function quicLongPnHp(): Encrypted {
  return {
    kind: "encrypted",
    id: "pnArea",
    name: "Header-protected PN",
    contextNote:
      "QUIC header protection (RFC 9001 §5.4) masks the Packet Number bytes with an XOR derived from the AEAD sample under the header-protection key.",
    headerProtected: ["packetNumber"],
    wireBits: lit(8),
    category: "identifier",
    plaintext: struct("pnPlaintext", [
      {
        id: "packetNumber",
        name: "Packet Number",
        type: bits(8),
        category: "identifier",
        doc: "Truncated packet number — header-protected. 1–4 bytes per pnLen, modeled here as 1 byte. [RFC 9000 §17.1]",
      },
    ]),
  };
}

const quicLongInitialCase: Struct = struct("longInitial", [
  {
    id: "tokenLength",
    name: "Token Length",
    type: { kind: "varint", encoding: "quic" },
    category: "length",
    doc: "Variable-length token length prefix (QUIC varint). [RFC 9000 §17.2.2]",
  },
  {
    id: "token",
    name: "Token",
    type: { kind: "bytes", n: lit(0) },
    category: "variable",
    doc: "Server-chosen retry/NEW_TOKEN token. Default 0 bytes for an unsolicited Initial. [RFC 9000 §17.2.2]",
  },
  {
    id: "length",
    name: "Length",
    type: { kind: "varint", encoding: "quic" },
    category: "length",
    doc: "QUIC varint length of the rest of the packet (PN + payload). [RFC 9000 §17.2]",
  },
  quicLongPnHp(),
]);

const quicLongHandshakeCase: Struct = struct("longHandshake", [
  {
    id: "length",
    name: "Length",
    type: { kind: "varint", encoding: "quic" },
    category: "length",
    doc: "QUIC varint length of (PN + payload). [RFC 9000 §17.2.4]",
  },
  quicLongPnHp(),
]);

const quicLongRetryCase: Struct = struct("longRetry", [
  {
    id: "retryToken",
    name: "Retry Token",
    type: { kind: "bytes", n: lit(0) },
    category: "variable",
    doc: "Server-issued retry token; consumes the rest of the packet up to the integrity tag. Default 0 bytes. [RFC 9000 §17.2.5]",
  },
  {
    id: "retryIntegrityTag",
    name: "Retry Integrity Tag",
    type: { kind: "bytes", n: lit(16) },
    category: "checksum",
    doc: "128-bit integrity tag covering the Retry Pseudo-Packet. [RFC 9001 §5.8]",
  },
]);

const quicLongPayload: Encrypted = {
  kind: "encrypted",
  id: "payload",
  name: "Encrypted Payload",
  contextNote:
    "AEAD-protected QUIC frames — requires Initial / 0-RTT / Handshake / 1-RTT keys depending on packet type.",
  wireBits: lit(128),
  category: "payload-marker",
  plaintext: quicFramesStub(),
};

export const quicLong: Packet = {
  name: "QUIC Long Header",
  rowBits: 32,
  byteOrder: "BE",
  description:
    "QUIC v1 long-header packet (RFC 9000 §17.2). Header Form=1; the Long Packet Type 2-bit field selects Initial / 0-RTT / Handshake / Retry tail layout via a Switch. Followed by an Encrypted Payload.",
  body: [
    {
      id: "headerForm",
      name: "Header Form (1=Long)",
      type: bits(1),
      category: "type",
      defaultValue: 1,
      doc: "1 = long header (Initial / 0-RTT / Handshake / Retry). [RFC 9000 §17.2]",
    },
    {
      id: "fixedBit",
      name: "Fixed Bit",
      type: bits(1),
      category: "reserved",
      defaultValue: 1,
      doc: "Must be 1 in QUIC v1. [RFC 9000 §17.2]",
    },
    {
      id: "longPacketType",
      name: "Long Packet Type",
      type: bits(2),
      category: "type",
      defaultValue: 0,
      doc: "0=Initial, 1=0-RTT, 2=Handshake, 3=Retry. [RFC 9000 §17.2]",
    },
    {
      id: "typeSpecificBits",
      name: "Type-Specific Bits",
      type: bits(4),
      category: "flags",
      doc: "Lower 4 bits — meaning depends on Long Packet Type (e.g. Initial: reserved + PN length). [RFC 9000 §17.2]",
    },
    {
      id: "version",
      name: "Version",
      type: { kind: "int", bits: 32 },
      category: "type",
      doc: "QUIC version (e.g. 0x00000001 for v1). [RFC 9000 §15]",
    },
    {
      id: "dcidLength",
      name: "DCID Length",
      type: bits(8),
      category: "length",
      defaultValue: 8,
      doc: "Length in bytes of the Destination Connection ID. 0–20. [RFC 9000 §17.2]",
    },
    {
      id: "dcid",
      name: "Destination Connection ID",
      type: { kind: "bytes", n: ref("dcidLength") },
      category: "addressing",
      doc: "Destination Connection ID — `dcidLength` bytes. [RFC 9000 §17.2]",
    },
    {
      id: "scidLength",
      name: "SCID Length",
      type: bits(8),
      category: "length",
      defaultValue: 8,
      doc: "Length in bytes of the Source Connection ID. 0–20. [RFC 9000 §17.2]",
    },
    {
      id: "scid",
      name: "Source Connection ID",
      type: { kind: "bytes", n: ref("scidLength") },
      category: "addressing",
      doc: "Source Connection ID — `scidLength` bytes. [RFC 9000 §17.2]",
    },
    {
      kind: "switch",
      id: "longTail",
      name: "Type-Specific Tail",
      on: ref("longPacketType"),
      cases: {
        "0": quicLongInitialCase,
        // 0-RTT shares the Initial tail layout in this model.
        "1": quicLongInitialCase,
        "2": quicLongHandshakeCase,
        "3": quicLongRetryCase,
      },
      default: quicLongInitialCase,
      doc: "Per-type tail fields selected by Long Packet Type.",
    },
    quicLongPayload,
  ],
};

/* ------------------------------------------------------------------ *
 * TLS 1.3 ClientHello (full) — RFC 8446 §4.1.2
 *
 * Extends the basic tlsClientHello with:
 *   * a richer Extensions Repeat<Switch> catalog (SNI, supported_versions,
 *     supported_groups, key_share, ALPN — already present in the generated
 *     preset; preserved here in the same shape).
 *   * an Encrypted block representing the post-handshake records the
 *     server sends back (ServerHello + EncryptedExtensions + Certificate
 *     + Finished). On the wire these arrive concatenated and most of the
 *     body is wrapped under TLS 1.3's handshake-traffic AEAD.
 * ------------------------------------------------------------------ */

const tlsExtensionVariants: Record<string, Struct> = {
  // server_name (SNI) — RFC 6066.
  "0": struct("sni", [
    { id: "type", name: "Type=0", type: bits(16), category: "type" },
    { id: "length", name: "Ext Len", type: bits(16), category: "length" },
    { id: "listLen", name: "List Len", type: bits(16), category: "length" },
    { id: "nameType", name: "Name Type=0", type: bits(8), category: "type" },
    { id: "nameLen", name: "Name Len", type: bits(16), category: "length" },
    {
      id: "hostname",
      name: "host_name (var)",
      type: bits(96),
      category: "addressing",
    },
  ]),
  // supported_versions — RFC 8446 §4.2.1.
  "43": struct("supportedVersions", [
    { id: "type", name: "Type=43", type: bits(16), category: "type" },
    { id: "length", name: "Ext Len", type: bits(16), category: "length" },
    { id: "vListLen", name: "Versions Len", type: bits(8), category: "length" },
    { id: "versions", name: "versions", type: bits(16), category: "type" },
  ]),
  // supported_groups — RFC 8446 §4.2.7.
  "10": struct("supportedGroups", [
    { id: "type", name: "Type=10", type: bits(16), category: "type" },
    { id: "length", name: "Ext Len", type: bits(16), category: "length" },
    { id: "listLen", name: "List Len", type: bits(16), category: "length" },
    { id: "groups", name: "named_group_list", type: bits(32), category: "type" },
  ]),
  // key_share — RFC 8446 §4.2.8 (one 32-byte X25519 share modeled).
  "51": struct("keyShare", [
    { id: "type", name: "Type=51", type: bits(16), category: "type" },
    { id: "length", name: "Ext Len", type: bits(16), category: "length" },
    { id: "listLen", name: "Shares Len", type: bits(16), category: "length" },
    { id: "group", name: "group", type: bits(16), category: "type" },
    { id: "keyLen", name: "key Len", type: bits(16), category: "length" },
    {
      id: "key",
      name: "key_exchange (X25519, 32B)",
      type: bits(256),
      category: "identifier",
    },
  ]),
  // ALPN — RFC 7301.
  "16": struct("alpn", [
    { id: "type", name: "Type=16", type: bits(16), category: "type" },
    { id: "length", name: "Ext Len", type: bits(16), category: "length" },
    { id: "listLen", name: "Proto List Len", type: bits(16), category: "length" },
    { id: "protoLen", name: "Proto Len", type: bits(8), category: "length" },
    { id: "protocol", name: "protocol (var)", type: bits(16), category: "type" },
  ]),
};

/**
 * Encrypted block representing the server-side post-handshake records
 * (ServerHello + EncryptedExtensions + Certificate + Finished). In TLS 1.3
 * everything after ServerHello is wrapped under the handshake-traffic AEAD.
 * Modeled here as a single Encrypted container with a stub plaintext.
 */
const tlsServerEncryptedHandshake: Encrypted = {
  kind: "encrypted",
  id: "serverHandshake",
  name: "Server Handshake (encrypted)",
  contextNote:
    "Encrypted handshake — requires TLS 1.3 key schedule outputs (handshake traffic keys derived from ECDHE).",
  wireBits: lit(384),
  category: "payload-marker",
  plaintext: struct("serverHandshakePlaintext", [
    {
      id: "sh_msgType",
      name: "ServerHello Type=2",
      type: bits(8),
      category: "type",
      doc: "ServerHello handshake message type. [RFC 8446 §4.1.3]",
    },
    {
      id: "sh_length",
      name: "Handshake Length",
      type: bits(24),
      category: "length",
    },
    {
      id: "sh_legacyVersion",
      name: "legacy_version",
      type: bits(16),
      category: "type",
    },
    {
      id: "sh_random",
      name: "random",
      type: bits(256),
      category: "identifier",
    },
    {
      id: "ee_msgType",
      name: "EncryptedExtensions Type=8",
      type: bits(8),
      category: "type",
      doc: "EncryptedExtensions handshake message type. [RFC 8446 §4.3.1]",
    },
    {
      id: "ee_body",
      name: "EncryptedExtensions Body",
      type: bits(64),
      category: "variable",
    },
    {
      id: "fin_msgType",
      name: "Finished Type=20",
      type: bits(8),
      category: "type",
      doc: "Finished handshake message type. [RFC 8446 §4.4.4]",
    },
    {
      id: "fin_verifyData",
      name: "verify_data",
      type: bits(48),
      category: "checksum",
    },
  ]),
};

export const tlsClientHelloFull: Packet = {
  name: "TLS ClientHello (full)",
  rowBits: 32,
  byteOrder: "BE",
  description:
    "TLS 1.3 ClientHello (RFC 8446 §4.1.2) with a populated Extensions catalog (SNI / supported_versions / supported_groups / key_share / ALPN) and the server-side encrypted handshake records modeled as an Encrypted container.",
  body: [
    {
      id: "msgType",
      name: "Handshake Type",
      type: bits(8),
      category: "type",
      defaultValue: 1,
      doc: "1 = ClientHello. [RFC 8446 §4]",
    },
    {
      id: "length",
      name: "Handshake Length",
      type: bits(24),
      category: "length",
      doc: "Length of the handshake message body that follows. [RFC 8446 §4]",
    },
    {
      id: "legacyVersion",
      name: "legacy_version",
      type: bits(16),
      category: "type",
      doc: "Frozen at 0x0303 (TLS 1.2) for middlebox compatibility. [RFC 8446 §4.1.2]",
    },
    {
      id: "random",
      name: "random",
      type: bits(256),
      category: "identifier",
      doc: "32 cryptographically random bytes. [RFC 8446 §4.1.2]",
    },
    {
      id: "sessionIdLen",
      name: "session_id length",
      type: bits(8),
      category: "length",
    },
    {
      id: "sessionId",
      name: "session_id",
      type: bits(256),
      category: "identifier",
    },
    {
      id: "cipherSuitesLen",
      name: "cipher_suites length",
      type: bits(16),
      category: "length",
    },
    {
      id: "cipherSuites",
      name: "cipher_suites",
      type: bits(32),
      category: "type",
    },
    {
      id: "compMethodsLen",
      name: "compression length",
      type: bits(8),
      category: "length",
    },
    {
      id: "compMethods",
      name: "compression_methods",
      type: bits(8),
      category: "reserved",
    },
    {
      id: "extensionsLen",
      name: "extensions length",
      type: bits(16),
      category: "length",
      defaultValue: 0,
      doc: "Total length in bytes of the extensions block that follows.",
    },
    {
      kind: "repeat",
      id: "extensions",
      name: "Extensions",
      category: "variable",
      element: struct("extensionRecord", [
        {
          kind: "switch",
          id: "byKind",
          on: ref("extensions_kind"),
          cases: tlsExtensionVariants,
        },
      ]),
      count: ref("tlsClientHelloFull_extensions_count"),
    },
    tlsServerEncryptedHandshake,
  ],
};

/* ------------------------------------------------------------------ *
 * PSML 0.4 demo presets — exercise the four new primitives.
 *
 * Each preset is small and focused on demonstrating a single primitive in
 * isolation so the format adapters have a stable fixture to render and
 * round-trip. The on-the-wire totals are documented in
 * `tests/fixtures/preset-bit-sizes.ts`.
 * ------------------------------------------------------------------ */

/**
 * HTTP/2 frame header (RFC 9113 §4.1) — a 9-byte fixed prefix followed by a
 * variable-length payload whose byte count is given by the Length field.
 * Demonstrates a chained length-prefix: `payload` reads `length * 8` bits.
 * The bidirectional constraint `payloadBits == length * 8` keeps the two in
 * sync when the user edits either side.
 */
export const http2FrameHeader: Packet = {
  name: "HTTP/2 Frame Header",
  rowBits: 32,
  byteOrder: "BE",
  description:
    "HTTP/2 frame header (RFC 9113 §4.1). 9-byte fixed prefix (Length:24 + Type:8 + Flags:8 + R:1 + Stream Identifier:31) followed by a length-prefixed payload.",
  body: [
    { id: "length", name: "Length", type: bits(24), category: "length", defaultValue: 0 },
    { id: "type", name: "Type", type: bits(8), category: "type" },
    { id: "flags", name: "Flags", type: bits(8), category: "flags" },
    { id: "r", name: "R", type: bits(1), category: "reserved" },
    {
      id: "streamId",
      name: "Stream Identifier",
      type: bits(31),
      category: "identifier",
    },
    {
      id: "payload",
      name: "Payload",
      type: { kind: "bytes", n: ref("length") },
      category: "payload-marker",
      doc: "Frame payload — length bytes. [RFC 9113 §4.1]",
    },
  ],
  constraints: [
    {
      lhs: op("*", ref("length"), lit(8)),
      rhs: ref("payloadBits"),
      doc: "Length counts bytes; payloadBits = length × 8.",
    },
  ],
};

/**
 * TLS extensions block (RFC 8446 §4.2) — a Repeat over a Switch dispatched
 * on a peek(16) of the extension_type word. Demonstrates the PSML 0.4 peek
 * lookahead Expr: the discriminator is read without consuming the bytes so
 * each case can re-read the same 16-bit type as its own first field.
 */
const tlsExtensionPeekCases: Record<string, Struct> = {
  // server_name (SNI) — RFC 6066 §3.
  "0": struct("sniExt", [
    { id: "extensionType", name: "extension_type=0", type: bits(16), category: "type" },
    { id: "serverNameListLength", name: "server_name_list length", type: bits(16), category: "length" },
    {
      id: "serverNameList",
      name: "server_name_list",
      type: { kind: "bytes", n: ref("serverNameListLength") },
      category: "addressing",
    },
  ]),
  // ALPN — RFC 7301 §3.
  "16": struct("alpnExt", [
    { id: "extensionType", name: "extension_type=16", type: bits(16), category: "type" },
    {
      id: "protocolNameListLength",
      name: "protocol_name_list length",
      type: bits(16),
      category: "length",
    },
    {
      id: "alpnProtocols",
      name: "alpn_protocols",
      type: { kind: "bytes", n: ref("protocolNameListLength") },
      category: "type",
    },
  ]),
  // supported_versions — RFC 8446 §4.2.1.
  "43": struct("supportedVersionsExt", [
    { id: "extensionType", name: "extension_type=43", type: bits(16), category: "type" },
    {
      id: "supportedVersionsLength",
      name: "SupportedVersions length",
      type: bits(8),
      category: "length",
    },
    {
      id: "versions",
      name: "versions",
      type: { kind: "bytes", n: ref("supportedVersionsLength") },
      category: "type",
    },
  ]),
  // key_share — RFC 8446 §4.2.8.
  "51": struct("keyShareExt", [
    { id: "extensionType", name: "extension_type=51", type: bits(16), category: "type" },
    {
      id: "clientSharesLength",
      name: "client_shares length",
      type: bits(16),
      category: "length",
    },
    {
      id: "keyShareEntry",
      name: "KeyShareEntry",
      type: { kind: "bytes", n: ref("clientSharesLength") },
      category: "identifier",
    },
  ]),
};

export const tlsExtensionsBlock: Packet = {
  name: "TLS Extensions Block",
  rowBits: 32,
  byteOrder: "BE",
  description:
    "TLS 1.3 extensions block (RFC 8446 §4.2) modeled as a Repeat<Switch> where the Switch discriminator is a peek(16) of the extension_type word. The peek is non-consuming so each case re-reads the same 16-bit field as its first member. Demonstrates the PSML 0.4 lookahead Switch.",
  body: [
    {
      kind: "repeat",
      id: "extensions",
      name: "Extensions",
      category: "variable",
      element: struct("extensionRecord", [
        {
          kind: "switch",
          id: "byPeekedType",
          on: { kind: "peek", bits: 16 },
          cases: tlsExtensionPeekCases,
        },
      ]),
      count: ref("tlsExtensionsBlock_extensions_count"),
    },
  ],
};

/**
 * PCIe TLP fragment (synthetic) — illustrative only; not a real PCIe TLP.
 * Demonstrates per-field byteOrder by mixing a BE-tagged 32-bit address with
 * an LE-tagged 16-bit length, plus a default-endian tag byte for contrast.
 */
export const pcieTlpFragment: Packet = {
  name: "PCIe TLP Fragment (Illustrative)",
  rowBits: 32,
  byteOrder: "BE",
  description:
    "Illustrative — not a real PCIe TLP. Demonstrates PSML 0.4 per-field byteOrder by mixing a BE 32-bit address with an LE 16-bit length field in the same packet. Use this preset only as a fixture for the byteOrder badge.",
  body: [
    { id: "fmtType", name: "Fmt/Type", type: bits(8), category: "type" },
    {
      id: "address",
      name: "Address (BE)",
      type: { kind: "int", bits: 32 },
      byteOrder: "BE",
      category: "addressing",
      doc: "32-bit address field — explicitly BE for documentation purposes.",
    },
    {
      id: "length",
      name: "Length (LE)",
      type: { kind: "int", bits: 16 },
      byteOrder: "LE",
      category: "length",
      doc: "16-bit length field — LE on the wire despite the BE packet default.",
    },
    { id: "tail", name: "Tail", type: bits(8), category: "reserved" },
  ],
};

/* ------------------------------------------------------------------ *
 * Registry — unified PSML presets
 * ------------------------------------------------------------------ */

/**
 * Hand-authored PSML presets that override (or extend) the baseline set.
 * Hand-authored entries win over the baseline so the encrypted/Repeat-
 * authored versions of ipv4/tcp/udp/ethernet/quicShort take precedence over
 * the flat baseline shapes for those keys.
 */
const MANUAL_PRESETS: Record<string, Packet> = {
  ipv4,
  tcp,
  udp,
  ethernet,
  quicShort,
  quicLong,
  tlsClientHelloFull,
  http2FrameHeader,
  tlsExtensionsBlock,
  pcieTlpFragment,
};

/** The single unified PSML registry consumed by the renderer and every format. */
export const PRESETS: Record<string, Packet> = {
  ...BASELINE_PRESETS,
  ...MANUAL_PRESETS,
};

export const PRESET_KEYS: string[] = Object.keys(PRESETS);
