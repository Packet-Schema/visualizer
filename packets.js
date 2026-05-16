// Packet templates.
//
// A packet is { name, rowBits, fields }.
// Each field is { id, name, bits, color?, description?, controlsLength? }.
//   - `bits` can be a number, or a function (state) => number for variable-length fields.
//   - `controlsLength` declares this field as a "length controller" in the state
//      under the given key. Its current numeric value drives variable fields that
//      reference the same key.
//   - `subfields: [{ id, name, bits, description? }, ...]` declares positional
//      sub-bit fields inside the parent. Sum of subfield.bits MUST equal the
//      parent's bits (validated by validatePacket / resolvePacket). Subfields are
//      laid out left-to-right within the parent's bit range. Use the synthetic
//      id `parent.id + ":" + subfield.id` to address a subfield from the UI.
//
// Variable-length fields reference a controller via `lengthFrom`: a function
// (controllerValue) => bits. This keeps the model declarative but flexible.
//
// Color tokens: instead of raw hex, fields use named tokens that the renderer
// resolves to CSS variables (e.g. --field-blue). This lets the theme swap the
// palette for light/dark mode.
//
// Available tokens: blue, indigo, violet, teal, green, amber, orange, rose, slate

export const PACKETS = {
  ipv4: {
    name: "IPv4 Header",
    rowBits: 32,
    description: "Internet Protocol version 4 header (RFC 791). IHL controls the size of the Options field.",
    fields: [
      { id: "version", name: "Version", bits: 4, color: "blue",
        description: "IP version. Always 4 for IPv4." },
      { id: "ihl", name: "IHL", bits: 4, color: "indigo",
        description: "Internet Header Length, in 32-bit words. Minimum 5 (no options), maximum 15.",
        controlsLength: "ihl", defaultValue: 5, min: 5, max: 15 },
      { id: "dscp", name: "DSCP", bits: 6, color: "orange",
        description: "Differentiated Services Code Point." },
      { id: "ecn", name: "ECN", bits: 2, color: "amber",
        description: "Explicit Congestion Notification." },
      { id: "totalLength", name: "Total Length", bits: 16, color: "teal",
        description: "Total packet length (header + data) in bytes." },
      { id: "identification", name: "Identification", bits: 16, color: "blue",
        description: "Used for fragment reassembly." },
      { id: "flags", name: "Flags", bits: 3, color: "rose",
        description: "Control flags: Reserved, DF (Don't Fragment), MF (More Fragments).",
        subfields: [
          { id: "reserved", name: "R", bits: 1,
            description: "Reserved. Must be zero (RFC 791); also called the 'evil bit' (RFC 3514, April Fools)." },
          { id: "df", name: "DF", bits: 1,
            description: "Don't Fragment. If set, the datagram must not be fragmented; if it cannot fit, it is dropped (and an ICMP error is returned)." },
          { id: "mf", name: "MF", bits: 1,
            description: "More Fragments. Set on every fragment except the last; cleared on unfragmented datagrams." },
        ] },
      { id: "fragOffset", name: "Fragment Offset", bits: 13, color: "green",
        description: "Position of this fragment in the original datagram." },
      { id: "ttl", name: "TTL", bits: 8, color: "amber",
        description: "Time To Live. Decremented each hop." },
      { id: "protocol", name: "Protocol", bits: 8, color: "teal",
        description: "Next-layer protocol (1=ICMP, 6=TCP, 17=UDP, ...)." },
      { id: "headerChecksum", name: "Header Checksum", bits: 16, color: "orange",
        description: "Checksum over the header only." },
      { id: "srcAddr", name: "Source Address", bits: 32, color: "blue",
        description: "Sender IPv4 address." },
      { id: "dstAddr", name: "Destination Address", bits: 32, color: "violet",
        description: "Receiver IPv4 address." },
      { id: "options", name: "Options", color: "amber",
        variable: true, lengthFrom: "ihl",
        // (IHL - 5) 32-bit words = (IHL - 5) * 32 bits
        toBits: (ihl) => Math.max(0, (ihl - 5) * 32),
        description: "Variable-length options. Present only when IHL > 5." },
    ],
  },

  tcp: {
    name: "TCP Header",
    rowBits: 32,
    description: "Transmission Control Protocol header (RFC 9293). Data Offset controls the Options size.",
    fields: [
      { id: "srcPort", name: "Source Port", bits: 16, color: "blue" },
      { id: "dstPort", name: "Destination Port", bits: 16, color: "violet" },
      { id: "seqNum", name: "Sequence Number", bits: 32, color: "teal" },
      { id: "ackNum", name: "Acknowledgment Number", bits: 32, color: "green" },
      { id: "dataOffset", name: "Data Offset", bits: 4, color: "indigo",
        description: "TCP header length in 32-bit words. Min 5, max 15.",
        controlsLength: "tcpDataOffset", defaultValue: 5, min: 5, max: 15 },
      { id: "reserved", name: "Rsvd", bits: 4, color: "slate",
        description: "Reserved bits." },
      { id: "flags", name: "Flags", bits: 8, color: "rose",
        description: "TCP control bits: CWR, ECE, URG, ACK, PSH, RST, SYN, FIN.",
        subfields: [
          { id: "cwr", name: "CWR", bits: 1,
            description: "Congestion Window Reduced (RFC 3168). Sender reduced its congestion window in response to ECE." },
          { id: "ece", name: "ECE", bits: 1,
            description: "ECN-Echo (RFC 3168). Indicates ECN-capable transport / echoes a received Congestion Experienced mark." },
          { id: "urg", name: "URG", bits: 1,
            description: "Urgent Pointer field is significant. Rarely used in practice." },
          { id: "ack", name: "ACK", bits: 1,
            description: "Acknowledgment Number field is significant. Set on all packets after the initial SYN." },
          { id: "psh", name: "PSH", bits: 1,
            description: "Push function. Receiver should pass buffered data to the application without waiting for more." },
          { id: "rst", name: "RST", bits: 1,
            description: "Reset the connection. Sent on protocol errors or to refuse a connection." },
          { id: "syn", name: "SYN", bits: 1,
            description: "Synchronize sequence numbers. Set on the first packet of each direction during connection setup." },
          { id: "fin", name: "FIN", bits: 1,
            description: "No more data from sender. Used to gracefully close the connection." },
        ] },
      { id: "window", name: "Window", bits: 16, color: "amber" },
      { id: "checksum", name: "Checksum", bits: 16, color: "orange" },
      { id: "urgent", name: "Urgent Pointer", bits: 16, color: "orange" },
      { id: "options", name: "Options", color: "amber",
        variable: true, lengthFrom: "tcpDataOffset",
        toBits: (off) => Math.max(0, (off - 5) * 32),
        description: "TCP options (MSS, SACK, Timestamps, ...). Present when Data Offset > 5." },
    ],
  },

  udp: {
    name: "UDP Header",
    rowBits: 32,
    description: "User Datagram Protocol header (RFC 768). Fixed 8 bytes.",
    fields: [
      { id: "srcPort", name: "Source Port", bits: 16, color: "blue" },
      { id: "dstPort", name: "Destination Port", bits: 16, color: "violet" },
      { id: "length", name: "Length", bits: 16, color: "teal",
        description: "Length of UDP header + payload in bytes." },
      { id: "checksum", name: "Checksum", bits: 16, color: "orange" },
    ],
  },

  dns: {
    name: "DNS Header",
    rowBits: 16,
    description: "Domain Name System message header (RFC 1035). 12 bytes; the Flags field encodes QR/Opcode/AA/TC/RD/RA/Z/RCODE.",
    fields: [
      { id: "id", name: "Identification", bits: 16, color: "blue",
        description: "Identifier copied to the corresponding reply, used to match queries and responses." },
      { id: "flags", name: "Flags", bits: 16, color: "rose",
        description: "Control flags: QR, Opcode, AA, TC, RD, RA, Z, RCODE.",
        subfields: [
          { id: "qr", name: "QR", bits: 1,
            description: "Query/Response. 0 = query, 1 = response." },
          { id: "opcode", name: "Opcode", bits: 4,
            description: "Kind of query: 0=QUERY, 1=IQUERY (obsolete), 2=STATUS, 4=NOTIFY, 5=UPDATE." },
          { id: "aa", name: "AA", bits: 1,
            description: "Authoritative Answer. Set in responses from an authoritative server for the queried name." },
          { id: "tc", name: "TC", bits: 1,
            description: "TrunCation. Message was truncated due to transport size limits (typically UDP)." },
          { id: "rd", name: "RD", bits: 1,
            description: "Recursion Desired. Client asks the server to pursue the query recursively." },
          { id: "ra", name: "RA", bits: 1,
            description: "Recursion Available. Server signals whether it supports recursive queries." },
          { id: "z", name: "Z", bits: 3,
            description: "Reserved for future use; must be zero in queries and responses (parts later reused by DNSSEC AD/CD)." },
          { id: "rcode", name: "RCODE", bits: 4,
            description: "Response code: 0=NOERROR, 1=FORMERR, 2=SERVFAIL, 3=NXDOMAIN, 4=NOTIMP, 5=REFUSED." },
        ] },
      { id: "qdcount", name: "QDCOUNT", bits: 16, color: "teal",
        description: "Number of entries in the Question section." },
      { id: "ancount", name: "ANCOUNT", bits: 16, color: "green",
        description: "Number of resource records in the Answer section." },
      { id: "nscount", name: "NSCOUNT", bits: 16, color: "amber",
        description: "Number of name-server resource records in the Authority section." },
      { id: "arcount", name: "ARCOUNT", bits: 16, color: "orange",
        description: "Number of resource records in the Additional section." },
    ],
  },

  ethernet: {
    name: "Ethernet II Frame Header",
    rowBits: 32,
    description: "Ethernet II frame header. 14 bytes (no 802.1Q tag).",
    fields: [
      { id: "dstMac", name: "Destination MAC", bits: 48, color: "violet" },
      { id: "srcMac", name: "Source MAC", bits: 48, color: "blue" },
      { id: "etherType", name: "EtherType", bits: 16, color: "teal",
        description: "0x0800=IPv4, 0x86DD=IPv6, 0x0806=ARP, ..." },
    ],
  },

  ipv6: {
    name: "IPv6 Header",
    rowBits: 32,
    description: "Internet Protocol version 6 header (RFC 8200 §3). Fixed 40 bytes; optional features such as fragmentation and routing live in chained extension headers selected by Next Header.",
    fields: [
      { id: "version", name: "Version", bits: 4, color: "blue",
        description: "IP version. Always 6 for IPv6 (RFC 8200 §3)." },
      { id: "trafficClass", name: "Traffic Class", bits: 8, color: "orange",
        description: "Equivalent to IPv4 DSCP+ECN: 6-bit DSCP for QoS classification plus 2-bit ECN." },
      { id: "flowLabel", name: "Flow Label", bits: 20, color: "amber",
        description: "20-bit label identifying packets that belong to the same flow for special handling (RFC 6437)." },
      { id: "payloadLength", name: "Payload Length", bits: 16, color: "teal",
        description: "Length in bytes of the payload that follows this header, including any extension headers. 0 indicates a Jumbogram (RFC 2675)." },
      { id: "nextHeader", name: "Next Header", bits: 8, color: "teal",
        description: "Type of the next header. Same values as IPv4 Protocol (6=TCP, 17=UDP, 58=ICMPv6, 0=Hop-by-Hop, 43=Routing, 44=Fragment, 50=ESP, 51=AH, 60=Destination Options)." },
      { id: "hopLimit", name: "Hop Limit", bits: 8, color: "amber",
        description: "Decremented at each forwarding node; packet is discarded when it reaches zero. IPv6 analog of IPv4 TTL." },
      { id: "srcAddr", name: "Source Address", bits: 128, color: "blue",
        description: "128-bit source address (RFC 4291). Typically rendered as eight 16-bit hex groups." },
      { id: "dstAddr", name: "Destination Address", bits: 128, color: "violet",
        description: "128-bit destination address (RFC 4291)." },
    ],
  },

  icmp: {
    name: "ICMP Echo (IPv4)",
    rowBits: 32,
    description: "Internet Control Message Protocol echo request/reply layout (RFC 792). Carried directly inside IPv4 with Protocol=1.",
    fields: [
      { id: "type", name: "Type", bits: 8, color: "blue",
        description: "Message type. 8=Echo Request, 0=Echo Reply, 3=Destination Unreachable, 11=Time Exceeded (RFC 792)." },
      { id: "code", name: "Code", bits: 8, color: "violet",
        description: "Sub-type within the Type. 0 for Echo Request/Reply." },
      { id: "checksum", name: "Checksum", bits: 16, color: "orange",
        description: "Internet checksum over the ICMP header and data." },
      { id: "identifier", name: "Identifier", bits: 16, color: "teal",
        description: "Echo identifier, used to match requests with replies (often the sender's PID)." },
      { id: "sequence", name: "Sequence Number", bits: 16, color: "amber",
        description: "Echo sequence number, incremented per ping." },
    ],
  },

  icmpv6: {
    name: "ICMPv6 Echo",
    rowBits: 32,
    description: "ICMP for IPv6 echo request/reply layout (RFC 4443). Carried in IPv6 with Next Header=58.",
    fields: [
      { id: "type", name: "Type", bits: 8, color: "blue",
        description: "Message type. 128=Echo Request, 129=Echo Reply, 1=Destination Unreachable, 3=Time Exceeded, 135/136=NDP Neighbor Solicitation/Advertisement (RFC 4443)." },
      { id: "code", name: "Code", bits: 8, color: "violet",
        description: "Sub-type within the Type. 0 for Echo Request/Reply." },
      { id: "checksum", name: "Checksum", bits: 16, color: "orange",
        description: "Checksum computed over the ICMPv6 message plus an IPv6 pseudo-header (RFC 4443 §2.3)." },
      { id: "identifier", name: "Identifier", bits: 16, color: "teal",
        description: "Echo identifier used to match requests with replies." },
      { id: "sequence", name: "Sequence Number", bits: 16, color: "amber",
        description: "Echo sequence number, incremented per ping." },
    ],
  },

  arp: {
    name: "ARP (IPv4 over Ethernet)",
    rowBits: 32,
    description: "Address Resolution Protocol packet for IPv4-over-Ethernet (RFC 826). Address fields are technically variable; this preset shows the common HTYPE=1, PTYPE=0x0800, HLEN=6, PLEN=4 form (28 bytes total).",
    fields: [
      { id: "htype", name: "Hardware Type", bits: 16, color: "blue",
        description: "Link-layer type. 1 for Ethernet (RFC 826)." },
      { id: "ptype", name: "Protocol Type", bits: 16, color: "violet",
        description: "Protocol address type. 0x0800 for IPv4, matching Ethernet's EtherType encoding." },
      { id: "hlen", name: "HLEN", bits: 8, color: "amber",
        description: "Hardware address length in bytes. 6 for Ethernet MAC addresses." },
      { id: "plen", name: "PLEN", bits: 8, color: "amber",
        description: "Protocol address length in bytes. 4 for IPv4." },
      { id: "oper", name: "Operation", bits: 16, color: "rose",
        description: "Operation code. 1=Request, 2=Reply, 3/4=RARP request/reply." },
      { id: "sha", name: "Sender Hardware Address", bits: 48, color: "blue",
        description: "Sender's MAC address. Length is HLEN bytes; fixed at 48 bits here for IPv4-over-Ethernet." },
      { id: "spa", name: "Sender Protocol Address", bits: 32, color: "teal",
        description: "Sender's IPv4 address. Length is PLEN bytes; fixed at 32 bits here for IPv4." },
      { id: "tha", name: "Target Hardware Address", bits: 48, color: "violet",
        description: "Target's MAC address. Zero in ARP requests (the value being resolved)." },
      { id: "tpa", name: "Target Protocol Address", bits: 32, color: "teal",
        description: "Target's IPv4 address being resolved." },
    ],
  },

  tlsRecord: {
    name: "TLS Record Layer",
    rowBits: 8,
    description: "TLS record layer header (RFC 8446 §5.1). 5-byte fixed header that frames every TLS record on the wire.",
    fields: [
      { id: "type", name: "Content Type", bits: 8, color: "blue",
        description: "Record content type. 20=ChangeCipherSpec, 21=Alert, 22=Handshake, 23=ApplicationData, 24=Heartbeat (RFC 8446 §5.1)." },
      { id: "versionMajor", name: "Version (Major)", bits: 8, color: "violet",
        description: "Legacy record version major byte. Always 0x03 in TLS 1.0–1.3; the real version is negotiated in the Handshake." },
      { id: "versionMinor", name: "Version (Minor)", bits: 8, color: "violet",
        description: "Legacy record version minor byte. 0x01=TLS 1.0, 0x03=TLS 1.2; TLS 1.3 records still send 0x0303 here for middlebox compatibility (RFC 8446 §5.1)." },
      { id: "lengthHi", name: "Length (high byte)", bits: 8, color: "teal",
        description: "High byte of the 16-bit big-endian fragment length. Maximum 2^14 + 256 bytes for TLSCiphertext." },
      { id: "lengthLo", name: "Length (low byte)", bits: 8, color: "teal",
        description: "Low byte of the 16-bit big-endian fragment length." },
    ],
  },

  quicShort: {
    name: "QUIC Short Header (1-RTT)",
    rowBits: 32,
    description: "QUIC v1 short-header (1-RTT) packet (RFC 9000 §17.3). Connection ID and Packet Number lengths are negotiated out-of-band; this preset assumes an 8-byte Destination CID and 1-byte Packet Number for illustration.",
    fields: [
      { id: "headerForm", name: "Header Form (0=Short)", bits: 1, color: "blue",
        description: "0 indicates a short-header packet; 1 indicates a long header (Initial/Handshake/0-RTT/Retry)." },
      { id: "fixedBit", name: "Fixed Bit", bits: 1, color: "slate",
        description: "Must be set to 1 in QUIC v1; receivers MUST drop packets where this is 0 (RFC 9000 §17.2/17.3)." },
      { id: "spinBit", name: "Spin Bit", bits: 1, color: "amber",
        description: "Latency spin bit (RFC 9000 §17.4). Toggled on every RTT to allow on-path latency measurement." },
      { id: "reserved", name: "Reserved", bits: 2, color: "slate",
        description: "Reserved bits. Protected by header protection; MUST be 0 once decrypted (RFC 9000 §17.3.1)." },
      { id: "keyPhase", name: "Key Phase", bits: 1, color: "rose",
        description: "Indicates which packet protection keys are in use; flipped on key updates (RFC 9000 §6)." },
      { id: "pnLen", name: "Packet Number Length", bits: 2, color: "violet",
        description: "Encoded length of the Packet Number minus 1 (0–3 → 1–4 bytes). Protected by header protection." },
      { id: "dcid", name: "Destination Connection ID", bits: 64, color: "teal",
        description: "Connection ID chosen by the receiver. Length is negotiated (0–20 bytes); shown here as 8 bytes as a typical value." },
      { id: "packetNumber", name: "Packet Number", bits: 8, color: "amber",
        description: "Truncated packet number, 1–4 bytes wide as indicated by Packet Number Length. Shown here as 1 byte." },
    ],
  },

  vlan: {
    name: "Ethernet II + 802.1Q VLAN Tag",
    rowBits: 32,
    description: "Ethernet II frame header with an inserted 802.1Q VLAN tag (IEEE 802.1Q-2018). 18-byte header: a 4-byte tag (TPID + TCI) sits between Source MAC and the original EtherType.",
    fields: [
      { id: "dstMac", name: "Destination MAC", bits: 48, color: "violet" },
      { id: "srcMac", name: "Source MAC", bits: 48, color: "blue" },
      { id: "tpid", name: "TPID", bits: 16, color: "orange",
        description: "Tag Protocol Identifier. 0x8100 for a single 802.1Q tag; 0x88A8 indicates an outer 802.1ad (Q-in-Q) tag." },
      { id: "pcp", name: "PCP", bits: 3, color: "rose",
        description: "Priority Code Point: 3-bit IEEE 802.1p class-of-service value (0–7)." },
      { id: "dei", name: "DEI", bits: 1, color: "slate",
        description: "Drop Eligible Indicator. May be set to mark frames eligible to be dropped under congestion." },
      { id: "vid", name: "VLAN ID", bits: 12, color: "amber",
        description: "12-bit VLAN identifier (0–4095). 0=priority-tagged only, 1=default VLAN, 4095=reserved." },
      { id: "etherType", name: "EtherType", bits: 16, color: "teal",
        description: "EtherType of the encapsulated payload. 0x0800=IPv4, 0x86DD=IPv6, 0x0806=ARP, ..." },
    ],
  },
};

// Validate a packet definition. Currently checks that subfield bit sums match
// their parent's bit width. Throws a clear error on mismatch.
export function validatePacket(packet) {
  for (const field of packet.fields) {
    if (!field.subfields) continue;
    if (field.variable) {
      throw new Error(
        `Packet "${packet.name}": field "${field.id}" is variable-length and cannot have subfields.`
      );
    }
    const sum = field.subfields.reduce((acc, sf) => acc + sf.bits, 0);
    if (sum !== field.bits) {
      throw new Error(
        `Packet "${packet.name}": subfields of "${field.id}" sum to ${sum} bits ` +
        `but parent declares ${field.bits} bits.`
      );
    }
    for (const sf of field.subfields) {
      if (!Number.isInteger(sf.bits) || sf.bits <= 0) {
        throw new Error(
          `Packet "${packet.name}": subfield "${field.id}.${sf.id}" must have positive integer bits, got ${sf.bits}.`
        );
      }
    }
  }
}

// Resolve a packet definition + controller state into laid-out cells.
// Cells with subfields get a `subCells` array, each entry positioned within
// the parent cell's segment using bit offsets (relative to the parent's start).
export function resolvePacket(packet, state) {
  validatePacket(packet);

  const cells = [];
  let bitPos = 0;

  for (const field of packet.fields) {
    let bits;
    if (field.variable) {
      const controlValue = state[field.lengthFrom];
      bits = field.toBits(controlValue);
    } else {
      bits = field.bits;
    }
    if (bits === 0) continue;

    let remaining = bits;
    let segmentIndex = 0;
    const totalSegments = computeSegmentCount(bitPos, bits, packet.rowBits);
    // Track absolute bit position of the parent's start so we can compute
    // each subfield's offset relative to the parent.
    const parentStartBitPos = bitPos;
    const parentSegments = [];

    while (remaining > 0) {
      const row = Math.floor(bitPos / packet.rowBits);
      const colInRow = bitPos % packet.rowBits;
      const take = Math.min(remaining, packet.rowBits - colInRow);
      const cell = {
        field,
        bitsTotal: bits,
        row,
        startBit: colInRow,
        endBit: colInRow + take - 1,
        segmentIndex,
        totalSegments,
        isFirst: segmentIndex === 0,
        isLast: remaining === take,
        // Bit offset (relative to the start of the field) covered by this cell.
        fieldStartOffset: bits - remaining,
        fieldEndOffset: bits - remaining + take - 1,
      };
      cells.push(cell);
      parentSegments.push(cell);
      remaining -= take;
      bitPos += take;
      segmentIndex++;
    }

    // Distribute subfields across the parent's segments.
    if (field.subfields && field.subfields.length > 0) {
      let sfOffset = 0;
      for (const sf of field.subfields) {
        const sfStart = sfOffset;
        const sfEnd = sfOffset + sf.bits - 1;
        for (const seg of parentSegments) {
          // Intersect [sfStart, sfEnd] with [seg.fieldStartOffset, seg.fieldEndOffset]
          const lo = Math.max(sfStart, seg.fieldStartOffset);
          const hi = Math.min(sfEnd, seg.fieldEndOffset);
          if (lo > hi) continue;
          // Map into segment-local bit columns (within seg.startBit..seg.endBit).
          const colStart = seg.startBit + (lo - seg.fieldStartOffset);
          const colEnd = seg.startBit + (hi - seg.fieldStartOffset);
          if (!seg.subCells) seg.subCells = [];
          seg.subCells.push({
            parentField: field,
            subfield: sf,
            // Synthetic id used by the renderer for data-field-id and click routing.
            id: `${field.id}:${sf.id}`,
            startBit: colStart,
            endBit: colEnd,
            // Whether this is the first/last segment of the subfield (for label placement).
            isFirst: lo === sfStart,
            isLast: hi === sfEnd,
            bitsTotal: sf.bits,
          });
        }
        sfOffset += sf.bits;
      }
    }
  }
  return { cells, totalBits: bitPos };
}

function computeSegmentCount(startPos, bits, rowBits) {
  let remaining = bits;
  let pos = startPos;
  let count = 0;
  while (remaining > 0) {
    const colInRow = pos % rowBits;
    const take = Math.min(remaining, rowBits - colInRow);
    remaining -= take;
    pos += take;
    count++;
  }
  return count;
}

// Initial controller state for a packet (uses each controller field's defaultValue).
export function initialState(packet) {
  const state = {};
  for (const field of packet.fields) {
    if (field.controlsLength) {
      state[field.controlsLength] = field.defaultValue ?? 0;
    }
  }
  return state;
}
