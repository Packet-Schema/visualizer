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
