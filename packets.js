// Packet templates.
//
// A packet is { name, rowBits, fields }.
// Each field is { id, name, bits, color?, description?, controlsLength? }.
//   - `bits` can be a number, or a function (state) => number for variable-length fields.
//   - `controlsLength` declares this field as a "length controller" in the state
//      under the given key. Its current numeric value drives variable fields that
//      reference the same key.
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
        description: "Control flags: Reserved, DF (Don't Fragment), MF (More Fragments)." },
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
      { id: "flags", name: "Flags (CWR ECE URG ACK PSH RST SYN FIN)", bits: 8, color: "rose" },
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

// Resolve a packet definition + controller state into laid-out cells.
export function resolvePacket(packet, state) {
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

    while (remaining > 0) {
      const row = Math.floor(bitPos / packet.rowBits);
      const colInRow = bitPos % packet.rowBits;
      const take = Math.min(remaining, packet.rowBits - colInRow);
      cells.push({
        field,
        bitsTotal: bits,
        row,
        startBit: colInRow,
        endBit: colInRow + take - 1,
        segmentIndex,
        totalSegments,
        isFirst: segmentIndex === 0,
        isLast: remaining === take,
      });
      remaining -= take;
      bitPos += take;
      segmentIndex++;
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
