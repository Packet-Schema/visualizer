// Packet presets, expressed as a Typst dict-literal subset.
//
// Build-time conversion: `npm run build:data` reads this file, parses it via
// lib/typst-parser.ts, and emits lib/presets.generated.ts which exports a
// typed `Packet` for each preset.
//
// Variable-length fields can't carry a JS function in Typst, so they declare
// `formula:` strings that are interpreted by the resolver / a small registry
// (see lib/packet-resolver.ts).

#let ipv4 = (
  name: "IPv4 Header",
  rowBits: 32,
  byteOrder: "Network byte order (big-endian, MSB-first). Multi-byte fields like Total Length are sent high-byte first.",
  description: "Internet Protocol version 4 header (RFC 791). IHL controls the size of the Options field.",
  fields: (
    (id: "version", name: "Version", bits: 4, category: "type",
      description: "IP version field — tells the receiver which IP layout to parse. Always 4 for IPv4. [RFC 791]"),
    (id: "ihl", name: "IHL", bits: 4, category: "length",
      controlsLength: "ihl", defaultValue: 5, min: 5, max: 15,
      description: "Internet Header Length in 32-bit words — lets the receiver skip past variable Options to reach the payload. IHL=5 means a 20-byte header (no options). [RFC 791]"),
    (id: "dscp", name: "DSCP", bits: 6, category: "type",
      description: "6-bit priority tag — routers use it to prioritise latency-sensitive traffic over bulk traffic. [RFC 2474]"),
    (id: "ecn", name: "ECN", bits: 2, category: "flags",
      description: "Explicit Congestion Notification — lets routers signal congestion without dropping packets. [RFC 3168]"),
    (id: "totalLength", name: "Total Length", bits: 16, category: "length",
      description: "Total datagram size in bytes (header + payload). [RFC 791]"),
    (id: "identification", name: "Identification", bits: 16, category: "identifier",
      description: "Per-datagram ID — fragments share this value so the receiver can reassemble them. [RFC 791]"),
    (id: "flags", name: "Flags", bits: 3, category: "flags",
      description: "3-bit control flags governing fragmentation: Reserved, DF (Don't Fragment), MF (More Fragments). [RFC 791]",
      subfields: (
        (id: "reserved", name: "R", bits: 1,
          description: "Reserved bit — must be zero on the wire. [RFC 791]"),
        (id: "df", name: "DF", bits: 1,
          description: "Don't Fragment — routers must not split this datagram. [RFC 1191]"),
        (id: "mf", name: "MF", bits: 1,
          description: "More Fragments — set on every fragment except the last. [RFC 791]"),
      )),
    (id: "fragOffset", name: "Fragment Offset", bits: 13, category: "identifier",
      description: "Where this fragment's data sits in the original datagram, in 8-byte units. [RFC 791]"),
    (id: "ttl", name: "TTL", bits: 8, category: "identifier",
      description: "Time To Live — hop counter decremented by every router; dropped at 0. [RFC 791]"),
    (id: "protocol", name: "Protocol", bits: 8, category: "type",
      description: "Identifies the next-layer protocol (1=ICMP, 6=TCP, 17=UDP). [RFC 790, IANA]"),
    (id: "headerChecksum", name: "Header Checksum", bits: 16, category: "checksum",
      description: "16-bit one's-complement checksum over the IPv4 header. [RFC 1071]"),
    (id: "srcAddr", name: "Source Address", bits: 32, category: "addressing",
      description: "Sender's IPv4 address — where replies should be returned. [RFC 791]"),
    (id: "dstAddr", name: "Destination Address", bits: 32, category: "addressing",
      description: "Receiver's IPv4 address — routers forward toward this address. [RFC 791]"),
    (id: "options", name: "Options", category: "variable",
      variable: true, lengthFrom: "ihl",
      formula: "ihl_options",
      description: "Variable-length IPv4 options. Present only when IHL > 5. [RFC 791]"),
  ),
)

#let tcp = (
  name: "TCP Header",
  rowBits: 32,
  byteOrder: "Network byte order (big-endian, MSB-first). Sequence and Acknowledgment numbers are 32-bit big-endian counters.",
  description: "Transmission Control Protocol header (RFC 9293). Data Offset controls the Options size.",
  fields: (
    (id: "srcPort", name: "Source Port", bits: 16, category: "addressing",
      description: "Sender's port — combined with the source IP, identifies the local socket."),
    (id: "dstPort", name: "Destination Port", bits: 16, category: "addressing",
      description: "Receiver's port — selects the listening service (80=HTTP, 443=HTTPS, 22=SSH)."),
    (id: "seqNum", name: "Sequence Number", bits: 32, category: "identifier",
      description: "Byte position of the first data byte in this segment within the sender's stream. [RFC 9293]"),
    (id: "ackNum", name: "Acknowledgment Number", bits: 32, category: "identifier",
      description: "Next sequence number the sender expects from the peer. Only meaningful when ACK is set. [RFC 9293]"),
    (id: "dataOffset", name: "Data Offset", bits: 4, category: "length",
      controlsLength: "tcpDataOffset", defaultValue: 5, min: 5, max: 15,
      description: "TCP header length in 32-bit words. 5 = 20-byte header. Min 5, max 15."),
    (id: "reserved", name: "Rsvd", bits: 4, category: "reserved",
      description: "Reserved bits — must be zero on the wire."),
    (id: "flags", name: "Flags", bits: 8, category: "flags",
      description: "8-bit control bits: CWR, ECE, URG, ACK, PSH, RST, SYN, FIN. [RFC 9293]",
      subfields: (
        (id: "cwr", name: "CWR", bits: 1, description: "Congestion Window Reduced. [RFC 3168]"),
        (id: "ece", name: "ECE", bits: 1, description: "ECN-Echo — receiver tells the sender to slow down. [RFC 3168]"),
        (id: "urg", name: "URG", bits: 1, description: "Urgent Pointer is significant — rare today."),
        (id: "ack", name: "ACK", bits: 1, description: "Acknowledgment Number is significant."),
        (id: "psh", name: "PSH", bits: 1, description: "Push — deliver buffered bytes immediately."),
        (id: "rst", name: "RST", bits: 1, description: "Reset — abruptly terminates a connection."),
        (id: "syn", name: "SYN", bits: 1, description: "Synchronize — opens a connection."),
        (id: "fin", name: "FIN", bits: 1, description: "Finish — sender has no more data."),
      )),
    (id: "window", name: "Window", bits: 16, category: "flags",
      description: "Receive Window (RWND) — bytes of buffer space the sender is willing to accept. [RFC 9293]"),
    (id: "checksum", name: "Checksum", bits: 16, category: "checksum",
      description: "16-bit one's-complement checksum over the TCP header, payload, and IP pseudo-header. [RFC 9293]"),
    (id: "urgent", name: "Urgent Pointer", bits: 16, category: "identifier",
      description: "Offset from Sequence Number marking end of urgent data. Only meaningful when URG=1."),
    (id: "options", name: "Options", category: "variable",
      variable: true, lengthFrom: "tcpDataOffset",
      formula: "tcp_options",
      description: "TCP options (MSS, Window Scale, SACK, Timestamps, etc.). Up to 40 bytes. [RFC 9293]"),
  ),
)

#let ethernet = (
  name: "Ethernet II Frame Header",
  rowBits: 32,
  byteOrder: "Network byte order (big-endian, MSB-first). MAC addresses are transmitted left-to-right; EtherType is 16-bit big-endian.",
  description: "Ethernet II frame header. 14 bytes (no 802.1Q tag).",
  fields: (
    (id: "dstMac", name: "Destination MAC", bits: 48, category: "addressing",
      description: "48-bit destination MAC address — chooses which NIC on the local LAN should accept the frame."),
    (id: "srcMac", name: "Source MAC", bits: 48, category: "addressing",
      description: "48-bit sender MAC address — switches learn it to populate forwarding tables."),
    (id: "etherType", name: "EtherType", bits: 16, category: "type",
      description: "16-bit identifier for the upper-layer protocol (0x0800=IPv4, 0x86DD=IPv6, 0x0806=ARP)."),
  ),
)

#let presets = (
  ipv4: ipv4,
  tcp: tcp,
  ethernet: ethernet,
)
