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

export const PACKETS = {
  ipv4: {
    name: "IPv4 Header",
    rowBits: 32,
    description: "Internet Protocol version 4 header (RFC 791). IHL controls the size of the Options field.",
    fields: [
      { id: "version", name: "Version", bits: 4, color: "#6c8eef",
        description: "IP version. Always 4 for IPv4." },
      { id: "ihl", name: "IHL", bits: 4, color: "#8a6cef",
        description: "Internet Header Length, in 32-bit words. Minimum 5 (no options), maximum 15.",
        controlsLength: "ihl", defaultValue: 5, min: 5, max: 15 },
      { id: "dscp", name: "DSCP", bits: 6, color: "#ef8a6c",
        description: "Differentiated Services Code Point." },
      { id: "ecn", name: "ECN", bits: 2, color: "#efc56c",
        description: "Explicit Congestion Notification." },
      { id: "totalLength", name: "Total Length", bits: 16, color: "#6cefb5",
        description: "Total packet length (header + data) in bytes." },
      { id: "identification", name: "Identification", bits: 16, color: "#6c8eef",
        description: "Used for fragment reassembly." },
      { id: "flags", name: "Flags", bits: 3, color: "#ef6c8a",
        description: "Control flags: Reserved, DF (Don't Fragment), MF (More Fragments)." },
      { id: "fragOffset", name: "Fragment Offset", bits: 13, color: "#8aef6c",
        description: "Position of this fragment in the original datagram." },
      { id: "ttl", name: "TTL", bits: 8, color: "#efc56c",
        description: "Time To Live. Decremented each hop." },
      { id: "protocol", name: "Protocol", bits: 8, color: "#6cefb5",
        description: "Next-layer protocol (1=ICMP, 6=TCP, 17=UDP, ...)." },
      { id: "headerChecksum", name: "Header Checksum", bits: 16, color: "#ef8a6c",
        description: "Checksum over the header only." },
      { id: "srcAddr", name: "Source Address", bits: 32, color: "#6c8eef",
        description: "Sender IPv4 address." },
      { id: "dstAddr", name: "Destination Address", bits: 32, color: "#8a6cef",
        description: "Receiver IPv4 address." },
      { id: "options", name: "Options", color: "#efc56c",
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
      { id: "srcPort", name: "Source Port", bits: 16, color: "#6c8eef" },
      { id: "dstPort", name: "Destination Port", bits: 16, color: "#8a6cef" },
      { id: "seqNum", name: "Sequence Number", bits: 32, color: "#6cefb5" },
      { id: "ackNum", name: "Acknowledgment Number", bits: 32, color: "#6cefb5" },
      { id: "dataOffset", name: "Data Offset", bits: 4, color: "#8a6cef",
        description: "TCP header length in 32-bit words. Min 5, max 15.",
        controlsLength: "tcpDataOffset", defaultValue: 5, min: 5, max: 15 },
      { id: "reserved", name: "Rsvd", bits: 4, color: "#999",
        description: "Reserved bits." },
      { id: "flags", name: "Flags (CWR ECE URG ACK PSH RST SYN FIN)", bits: 8, color: "#ef6c8a" },
      { id: "window", name: "Window", bits: 16, color: "#efc56c" },
      { id: "checksum", name: "Checksum", bits: 16, color: "#ef8a6c" },
      { id: "urgent", name: "Urgent Pointer", bits: 16, color: "#ef8a6c" },
      { id: "options", name: "Options", color: "#efc56c",
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
      { id: "srcPort", name: "Source Port", bits: 16, color: "#6c8eef" },
      { id: "dstPort", name: "Destination Port", bits: 16, color: "#8a6cef" },
      { id: "length", name: "Length", bits: 16, color: "#6cefb5",
        description: "Length of UDP header + payload in bytes." },
      { id: "checksum", name: "Checksum", bits: 16, color: "#ef8a6c" },
    ],
  },

  ethernet: {
    name: "Ethernet II Frame Header",
    rowBits: 32,
    description: "Ethernet II frame header. 14 bytes (no 802.1Q tag).",
    fields: [
      { id: "dstMac", name: "Destination MAC", bits: 48, color: "#8a6cef" },
      { id: "srcMac", name: "Source MAC", bits: 48, color: "#6c8eef" },
      { id: "etherType", name: "EtherType", bits: 16, color: "#6cefb5",
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
