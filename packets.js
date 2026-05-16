// Packet templates.
//
// A packet is { name, rowBits, fields, byteOrder? }.
// Each field is { id, name, bits, color?, category?, description?, controlsLength? }.
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
//
// Semantic categories: each field also carries a `category` token that drives
// the legend and a category->color mapping in the renderer. Categories are:
//   addressing, identifier, length, type, flags, reserved, checksum, variable,
//   payload-marker. The legacy `color` value is preserved as a fallback.
//
// `byteOrder` (optional, packet-level): displayed as a small note above the
// diagram. Defaults to "Network byte order (big-endian, MSB-first)".

export const PACKETS = {
  ipv4: {
    name: "IPv4 Header",
    rowBits: 32,
    byteOrder: "Network byte order (big-endian, MSB-first). Multi-byte fields like Total Length are sent high-byte first.",
    description: "Internet Protocol version 4 header (RFC 791). IHL controls the size of the Options field.",
    fields: [
      { id: "version", name: "Version", bits: 4, color: "blue", category: "type",
        description: "IP version field — tells the receiver which IP layout to parse. Always 4 for IPv4 (6 means an IPv6 header should follow this layout instead). [RFC 791]" },
      { id: "ihl", name: "IHL", bits: 4, color: "indigo", category: "length",
        description: "Internet Header Length in 32-bit words — lets the receiver skip past variable Options to reach the payload. e.g. IHL=5 means a 20-byte header (no options); IHL=6 means 24 bytes (4 bytes of options). Min 5, max 15. [RFC 791]",
        controlsLength: "ihl", defaultValue: 5, min: 5, max: 15 },
      { id: "dscp", name: "DSCP", bits: 6, color: "orange", category: "type",
        description: "6-bit priority tag — routers use it to prioritise latency-sensitive traffic over bulk traffic. e.g. AF11 (001010) for video, EF (101110) for voice, 0 for default best-effort. [RFC 2474]" },
      { id: "ecn", name: "ECN", bits: 2, color: "amber", category: "flags",
        description: "Explicit Congestion Notification — lets routers signal congestion without dropping packets. e.g. 00 = Not-ECT, 11 = CE (Congestion Experienced); the receiver echoes CE back via the TCP ECE flag. [RFC 3168]" },
      { id: "totalLength", name: "Total Length", bits: 16, color: "teal", category: "length",
        description: "Total datagram size in bytes (header + payload) — receiver uses this to know where the IPv4 datagram ends. e.g. 1500 for a typical Ethernet-MTU packet; max 65535. [RFC 791]" },
      { id: "identification", name: "Identification", bits: 16, color: "blue", category: "identifier",
        description: "Per-datagram ID — fragments of the same original datagram share this value so the receiver can reassemble them. e.g. all fragments of one 4000-byte UDP packet might carry ID 0xAB12. [RFC 791]" },
      { id: "flags", name: "Flags", bits: 3, color: "rose", category: "flags",
        description: "3-bit control flags governing fragmentation: Reserved, DF (Don't Fragment), MF (More Fragments). [RFC 791]",
        subfields: [
          { id: "reserved", name: "R", bits: 1,
            description: "Reserved bit — must be zero on the wire. Jokingly proposed as the 'evil bit' in RFC 3514 (April Fools). [RFC 791]" },
          { id: "df", name: "DF", bits: 1,
            description: "Don't Fragment — if set, routers must not split this datagram. Used by Path MTU Discovery: an oversized DF=1 packet is dropped and the router returns an ICMP 'Fragmentation Needed' so the sender can shrink its MSS. [RFC 1191]" },
          { id: "mf", name: "MF", bits: 1,
            description: "More Fragments — set on every fragment except the last so the receiver knows it has them all. e.g. a 4000-byte payload split into three pieces has MF=1, MF=1, MF=0. [RFC 791]" },
        ] },
      { id: "fragOffset", name: "Fragment Offset", bits: 13, color: "green", category: "identifier",
        description: "Where this fragment's data sits in the original datagram, measured in 8-byte units — the receiver uses it to slot fragments back into place. e.g. a fragment carrying bytes 1480–2959 has Fragment Offset = 185. [RFC 791]" },
      { id: "ttl", name: "TTL", bits: 8, color: "amber", category: "identifier",
        description: "Time To Live — hop counter decremented by every router; the packet is dropped when it reaches 0 to stop routing loops. e.g. Linux defaults to 64; traceroute exploits TTL by sending probes with TTL=1, 2, 3, ... [RFC 791]" },
      { id: "protocol", name: "Protocol", bits: 8, color: "teal", category: "type",
        description: "Identifies the next-layer protocol so the OS knows which parser to hand the payload to. e.g. 1=ICMP, 6=TCP, 17=UDP, 47=GRE, 50=ESP. [RFC 790, IANA]" },
      { id: "headerChecksum", name: "Header Checksum", bits: 16, color: "orange", category: "checksum",
        description: "16-bit one's-complement checksum over the IPv4 header only — every router recomputes it because TTL changes each hop. Detects bit flips in the header but not in the payload (TCP/UDP carry their own checksums). [RFC 1071]" },
      { id: "srcAddr", name: "Source Address", bits: 32, color: "blue", category: "addressing",
        description: "Sender's IPv4 address — where replies should be returned. e.g. 192.168.1.42 (private) or 8.8.8.8 (Google DNS). [RFC 791]" },
      { id: "dstAddr", name: "Destination Address", bits: 32, color: "violet", category: "addressing",
        description: "Receiver's IPv4 address — routers forward toward this address. e.g. 8.8.8.8 to send a query to Google's public DNS. [RFC 791]" },
      { id: "options", name: "Options", color: "amber", category: "variable",
        variable: true, lengthFrom: "ihl",
        // (IHL - 5) 32-bit words = (IHL - 5) * 32 bits
        toBits: (ihl) => Math.max(0, (ihl - 5) * 32),
        description: "Variable-length IPv4 options (e.g. Record Route, Timestamp) — present only when IHL > 5. Rarely used in modern networks; many routers slow-path or drop packets that carry options. [RFC 791]" },
    ],
  },

  tcp: {
    name: "TCP Header",
    rowBits: 32,
    byteOrder: "Network byte order (big-endian, MSB-first). Sequence and Acknowledgment numbers are 32-bit big-endian counters.",
    description: "Transmission Control Protocol header (RFC 9293). Data Offset controls the Options size.",
    fields: [
      { id: "srcPort", name: "Source Port", bits: 16, color: "blue", category: "addressing",
        description: "Sender's port — combined with the source IP, identifies the local socket. Usually an ephemeral port (e.g. 49152–65535) chosen by the OS for outgoing connections." },
      { id: "dstPort", name: "Destination Port", bits: 16, color: "violet", category: "addressing",
        description: "Receiver's port — selects the listening service on the remote host. e.g. 80=HTTP, 443=HTTPS, 22=SSH, 25=SMTP." },
      { id: "seqNum", name: "Sequence Number", bits: 32, color: "teal", category: "identifier",
        description: "Byte position of the first data byte in this segment within the sender's stream — lets the receiver re-order and de-duplicate. Initial value is randomised at connection setup to avoid hijacking. [RFC 9293]" },
      { id: "ackNum", name: "Acknowledgment Number", bits: 32, color: "green", category: "identifier",
        description: "Next sequence number the sender is expecting from the peer — confirms everything below it has been received. Only meaningful when the ACK flag is set. [RFC 9293]" },
      { id: "dataOffset", name: "Data Offset", bits: 4, color: "indigo", category: "length",
        description: "TCP header length in 32-bit words — receiver uses it to skip past Options to the payload. e.g. 5 means a 20-byte header (no options); 8 means 32 bytes (12 bytes of options like MSS/SACK/Timestamps). Min 5, max 15.",
        controlsLength: "tcpDataOffset", defaultValue: 5, min: 5, max: 15 },
      { id: "reserved", name: "Rsvd", bits: 4, color: "slate", category: "reserved",
        description: "Reserved bits — must be zero on the wire (one of these has been re-used for the Nonce Sum experiment, but otherwise unused)." },
      { id: "flags", name: "Flags", bits: 8, color: "rose", category: "flags",
        description: "8-bit control bits driving connection state: CWR, ECE, URG, ACK, PSH, RST, SYN, FIN. [RFC 9293]",
        subfields: [
          { id: "cwr", name: "CWR", bits: 1,
            description: "Congestion Window Reduced — sender shrunk its CWND in response to a previous ECE; used with ECN to back off without packet loss. [RFC 3168]" },
          { id: "ece", name: "ECE", bits: 1,
            description: "ECN-Echo — receiver tells the sender that the network marked a packet with Congestion Experienced; sender should slow down. [RFC 3168]" },
          { id: "urg", name: "URG", bits: 1,
            description: "Urgent Pointer is significant — rare today; historically used for out-of-band signals like Telnet's Ctrl-C." },
          { id: "ack", name: "ACK", bits: 1,
            description: "Acknowledgment Number is significant — set on every segment after the initial SYN, including the SYN-ACK." },
          { id: "psh", name: "PSH", bits: 1,
            description: "Push — asks the receiver to deliver buffered bytes to the application immediately rather than waiting for more. e.g. set on the last segment of an HTTP request." },
          { id: "rst", name: "RST", bits: 1,
            description: "Reset — abruptly terminates a connection. Sent when packets arrive for a non-existent socket or to refuse a SYN (e.g. TCP RST when connecting to a closed port)." },
          { id: "syn", name: "SYN", bits: 1,
            description: "Synchronize — opens a connection by exchanging initial sequence numbers (the first two segments of the three-way handshake: SYN, then SYN+ACK)." },
          { id: "fin", name: "FIN", bits: 1,
            description: "Finish — sender has no more data; used in the four-way close handshake to gracefully shut the connection down in each direction." },
        ] },
      { id: "window", name: "Window", bits: 16, color: "amber", category: "flags",
        description: "Receive Window (RWND) — bytes of buffer space the sender of this segment is willing to accept beyond the Acknowledgment Number. Caps in-flight bytes for flow control; can be scaled up by the Window Scale option. [RFC 9293, RFC 7323]" },
      { id: "checksum", name: "Checksum", bits: 16, color: "orange", category: "checksum",
        description: "16-bit one's-complement checksum over the TCP header, payload, and an IP pseudo-header (src/dst IP + protocol + length). Catches in-transit corruption end-to-end. [RFC 9293, RFC 1071]" },
      { id: "urgent", name: "Urgent Pointer", bits: 16, color: "orange", category: "identifier",
        description: "Offset from the Sequence Number marking the end of urgent data — only meaningful when URG=1. Rarely used in modern stacks. [RFC 9293]" },
      { id: "options", name: "Options", color: "amber", category: "variable",
        variable: true, lengthFrom: "tcpDataOffset",
        toBits: (off) => Math.max(0, (off - 5) * 32),
        description: "TCP options carried in the header — MSS, Window Scale, SACK Permitted, SACK blocks, Timestamps, etc. Present when Data Offset > 5; up to 40 bytes. [RFC 9293, RFC 7323]" },
    ],
  },

  udp: {
    name: "UDP Header",
    rowBits: 32,
    byteOrder: "Network byte order (big-endian, MSB-first). All four 16-bit fields are sent high-byte first.",
    description: "User Datagram Protocol header (RFC 768). Fixed 8 bytes.",
    fields: [
      { id: "srcPort", name: "Source Port", bits: 16, color: "blue", category: "addressing",
        description: "Sender's port — combined with the source IP, identifies the local socket. May be 0 if no reply is expected. e.g. an ephemeral port for a DNS client query." },
      { id: "dstPort", name: "Destination Port", bits: 16, color: "violet", category: "addressing",
        description: "Receiver's port — selects the listening service. e.g. 53=DNS, 67/68=DHCP, 123=NTP, 443=QUIC." },
      { id: "length", name: "Length", bits: 16, color: "teal", category: "length",
        description: "Length of the UDP header plus payload in bytes — minimum 8 (header only). Lets the receiver find the end of the datagram inside an IP packet. [RFC 768]" },
      { id: "checksum", name: "Checksum", bits: 16, color: "orange", category: "checksum",
        description: "16-bit one's-complement checksum over header, payload, and IP pseudo-header. Optional in IPv4 (0 = not checked), mandatory in IPv6. [RFC 768, RFC 8200]" },
    ],
  },

  dns: {
    name: "DNS Header",
    rowBits: 16,
    byteOrder: "Network byte order (big-endian, MSB-first). All count fields are 16-bit big-endian.",
    description: "Domain Name System message header (RFC 1035). 12 bytes; the Flags field encodes QR/Opcode/AA/TC/RD/RA/Z/RCODE.",
    fields: [
      { id: "id", name: "Identification", bits: 16, color: "blue", category: "identifier",
        description: "Random 16-bit ID echoed in the response — lets the resolver match a reply to its outstanding query and helps mitigate spoofing. [RFC 1035, RFC 5452]" },
      { id: "flags", name: "Flags", bits: 16, color: "rose", category: "flags",
        description: "Control flags packed into 16 bits: QR, Opcode, AA, TC, RD, RA, Z, RCODE. [RFC 1035]",
        subfields: [
          { id: "qr", name: "QR", bits: 1,
            description: "Query/Response — 0 = the message is a query from a client, 1 = the message is a server's response." },
          { id: "opcode", name: "Opcode", bits: 4,
            description: "Kind of operation: 0=QUERY (the normal lookup), 1=IQUERY (obsolete inverse query), 2=STATUS, 4=NOTIFY (zone change), 5=UPDATE (dynamic DNS)." },
          { id: "aa", name: "AA", bits: 1,
            description: "Authoritative Answer — set when the responder is authoritative for the queried zone (e.g. an answer direct from ns1.example.com for example.com)." },
          { id: "tc", name: "TC", bits: 1,
            description: "TrunCation — set when the response was cut off because it didn't fit the transport (typically a 512-byte UDP limit). The client should retry over TCP." },
          { id: "rd", name: "RD", bits: 1,
            description: "Recursion Desired — client asks the server to chase the query through the DNS hierarchy on its behalf rather than just returning a referral." },
          { id: "ra", name: "RA", bits: 1,
            description: "Recursion Available — server advertises whether it supports recursive resolution. Public resolvers like 8.8.8.8 set this; authoritative-only servers do not." },
          { id: "z", name: "Z", bits: 3,
            description: "Reserved bits — must be zero in queries and responses. Two of these were later repurposed by DNSSEC as AD (Authentic Data) and CD (Checking Disabled). [RFC 4035]" },
          { id: "rcode", name: "RCODE", bits: 4,
            description: "Response Code — 0=NOERROR, 1=FORMERR (bad query), 2=SERVFAIL, 3=NXDOMAIN (name does not exist), 4=NOTIMP, 5=REFUSED." },
        ] },
      { id: "qdcount", name: "QDCOUNT", bits: 16, color: "teal", category: "length",
        description: "Number of question entries that follow the header — usually 1 (DNS supports more in theory but virtually nobody does in practice)." },
      { id: "ancount", name: "ANCOUNT", bits: 16, color: "green", category: "length",
        description: "Number of resource records in the Answer section — for an A query, the IP addresses returned for the name." },
      { id: "nscount", name: "NSCOUNT", bits: 16, color: "amber", category: "length",
        description: "Number of NS records in the Authority section — points the client at authoritative servers, often used in delegation responses." },
      { id: "arcount", name: "ARCOUNT", bits: 16, color: "orange", category: "length",
        description: "Number of records in the Additional section — typically glue (A/AAAA records for the NS hostnames in the Authority section) or an OPT pseudo-RR for EDNS0." },
    ],
  },

  ethernet: {
    name: "Ethernet II Frame Header",
    rowBits: 32,
    byteOrder: "Network byte order (big-endian, MSB-first). MAC addresses are transmitted left-to-right; EtherType is 16-bit big-endian.",
    description: "Ethernet II frame header. 14 bytes (no 802.1Q tag).",
    fields: [
      { id: "dstMac", name: "Destination MAC", bits: 48, color: "violet", category: "addressing",
        description: "48-bit destination MAC address — chooses which NIC on the local LAN should accept the frame. e.g. ff:ff:ff:ff:ff:ff for broadcast (used by ARP requests, DHCP DISCOVER)." },
      { id: "srcMac", name: "Source MAC", bits: 48, color: "blue", category: "addressing",
        description: "48-bit sender MAC address — switches learn it to populate their forwarding tables. The first 24 bits (the OUI) identify the NIC vendor." },
      { id: "etherType", name: "EtherType", bits: 16, color: "teal", category: "type",
        description: "16-bit identifier for the upper-layer protocol carried in the payload. e.g. 0x0800=IPv4, 0x86DD=IPv6, 0x0806=ARP, 0x8100=802.1Q VLAN tag." },
    ],
  },

  ipv6: {
    name: "IPv6 Header",
    rowBits: 32,
    byteOrder: "Network byte order (big-endian, MSB-first). Addresses are transmitted high-group first; e.g. 2001:db8::1 is sent as 0x2001 0x0db8 ... 0x0001.",
    description: "Internet Protocol version 6 header (RFC 8200 §3). Fixed 40 bytes; optional features such as fragmentation and routing live in chained extension headers selected by Next Header.",
    fields: [
      { id: "version", name: "Version", bits: 4, color: "blue", category: "type",
        description: "IP version field — always 6 for IPv6, distinguishing this header from an IPv4 header that begins with 4. [RFC 8200 §3]" },
      { id: "trafficClass", name: "Traffic Class", bits: 8, color: "orange", category: "type",
        description: "Equivalent of IPv4's DSCP+ECN packed into one byte: top 6 bits are DSCP for QoS classification, bottom 2 bits are ECN for congestion signalling. [RFC 8200, RFC 2474, RFC 3168]" },
      { id: "flowLabel", name: "Flow Label", bits: 20, color: "amber", category: "identifier",
        description: "20-bit label tagging packets that belong to the same flow (e.g. one TCP connection) so routers can keep them on the same path without parsing L4 headers. [RFC 6437]" },
      { id: "payloadLength", name: "Payload Length", bits: 16, color: "teal", category: "length",
        description: "Bytes of payload following this header, including any extension headers. 0 means a Jumbogram (length carried in a Hop-by-Hop option, allowing packets >65535 bytes). [RFC 8200, RFC 2675]" },
      { id: "nextHeader", name: "Next Header", bits: 8, color: "teal", category: "type",
        description: "Type of the immediately following header — uses the same numbering as IPv4 Protocol. e.g. 6=TCP, 17=UDP, 58=ICMPv6, 0=Hop-by-Hop, 43=Routing, 44=Fragment, 50=ESP, 51=AH." },
      { id: "hopLimit", name: "Hop Limit", bits: 8, color: "amber", category: "identifier",
        description: "Hop counter decremented by each forwarding router; the packet is dropped at 0. IPv6 equivalent of IPv4 TTL; default is typically 64. [RFC 8200]" },
      { id: "srcAddr", name: "Source Address", bits: 128, color: "blue", category: "addressing",
        description: "128-bit sender address — written as eight 16-bit hex groups, with :: collapsing one run of zero groups. e.g. 2001:db8::1, fe80::1 (link-local). [RFC 4291]" },
      { id: "dstAddr", name: "Destination Address", bits: 128, color: "violet", category: "addressing",
        description: "128-bit receiver address — also supports multicast (ff00::/8) and anycast. e.g. 2606:4700:4700::1111 is one of Cloudflare's public DNS resolvers. [RFC 4291]" },
    ],
  },

  icmp: {
    name: "ICMP Echo (IPv4)",
    rowBits: 32,
    byteOrder: "Network byte order (big-endian, MSB-first). The Identifier and Sequence Number are 16-bit big-endian.",
    description: "Internet Control Message Protocol echo request/reply layout (RFC 792). Carried directly inside IPv4 with Protocol=1.",
    fields: [
      { id: "type", name: "Type", bits: 8, color: "blue", category: "type",
        description: "ICMP message type — selects the kind of control/error message. e.g. 8=Echo Request (ping), 0=Echo Reply, 3=Destination Unreachable, 11=Time Exceeded (used by traceroute). [RFC 792]" },
      { id: "code", name: "Code", bits: 8, color: "violet", category: "type",
        description: "Sub-type within the Type — refines the meaning. e.g. for Type=3 (Destination Unreachable): 0=net unreachable, 1=host unreachable, 3=port unreachable, 4=fragmentation needed and DF set." },
      { id: "checksum", name: "Checksum", bits: 16, color: "orange", category: "checksum",
        description: "16-bit one's-complement checksum over the entire ICMP message (header + data). Detects in-transit corruption. [RFC 1071]" },
      { id: "identifier", name: "Identifier", bits: 16, color: "teal", category: "identifier",
        description: "Echo identifier — lets a sender match replies to its outstanding requests when many are in flight. Often the OS sets this to the ping process's PID." },
      { id: "sequence", name: "Sequence Number", bits: 16, color: "amber", category: "identifier",
        description: "Echo sequence number — incremented for each ping so you can spot dropped replies. e.g. ping shows 'icmp_seq=1, icmp_seq=2, ...'." },
    ],
  },

  icmpv6: {
    name: "ICMPv6 Echo",
    rowBits: 32,
    byteOrder: "Network byte order (big-endian, MSB-first). The Identifier and Sequence Number are 16-bit big-endian.",
    description: "ICMP for IPv6 echo request/reply layout (RFC 4443). Carried in IPv6 with Next Header=58.",
    fields: [
      { id: "type", name: "Type", bits: 8, color: "blue", category: "type",
        description: "ICMPv6 message type. e.g. 128=Echo Request, 129=Echo Reply, 1=Destination Unreachable, 3=Time Exceeded, 135/136=NDP Neighbor Solicitation/Advertisement (the IPv6 equivalent of ARP). [RFC 4443]" },
      { id: "code", name: "Code", bits: 8, color: "violet", category: "type",
        description: "Sub-type refining the Type. 0 for Echo Request/Reply; for Type=1 (Destination Unreachable): 0=no route, 3=address unreachable, 4=port unreachable." },
      { id: "checksum", name: "Checksum", bits: 16, color: "orange", category: "checksum",
        description: "16-bit one's-complement checksum over the ICMPv6 message plus an IPv6 pseudo-header (src/dst, length, next header). Mandatory in IPv6. [RFC 4443 §2.3]" },
      { id: "identifier", name: "Identifier", bits: 16, color: "teal", category: "identifier",
        description: "Echo identifier — lets the sender pair replies with outstanding requests; commonly the ping process's PID." },
      { id: "sequence", name: "Sequence Number", bits: 16, color: "amber", category: "identifier",
        description: "Echo sequence number — incremented per ping so dropped responses are visible." },
    ],
  },

  arp: {
    name: "ARP (IPv4 over Ethernet)",
    rowBits: 32,
    byteOrder: "Network byte order (big-endian, MSB-first). HLEN/PLEN are single-byte counts, so endianness only matters for the multi-byte fields.",
    description: "Address Resolution Protocol packet for IPv4-over-Ethernet (RFC 826). Address fields are technically variable; this preset shows the common HTYPE=1, PTYPE=0x0800, HLEN=6, PLEN=4 form (28 bytes total).",
    fields: [
      { id: "htype", name: "Hardware Type", bits: 16, color: "blue", category: "type",
        description: "Link-layer technology code — tells the receiver how to interpret the hardware address fields. 1 = Ethernet (the overwhelmingly common case). [RFC 826, IANA ARP parameters]" },
      { id: "ptype", name: "Protocol Type", bits: 16, color: "violet", category: "type",
        description: "Protocol whose address is being resolved — re-uses EtherType numbering. 0x0800 means IPv4 addresses. [RFC 826]" },
      { id: "hlen", name: "HLEN", bits: 8, color: "amber", category: "length",
        description: "Hardware address length in bytes — lets a parser walk past the SHA/THA fields. 6 for Ethernet MAC addresses. [RFC 826]" },
      { id: "plen", name: "PLEN", bits: 8, color: "amber", category: "length",
        description: "Protocol address length in bytes. 4 for IPv4 addresses; 16 would be used if ARP carried IPv6 (in practice IPv6 uses NDP instead). [RFC 826]" },
      { id: "oper", name: "Operation", bits: 16, color: "rose", category: "type",
        description: "What this packet is doing. 1=Request ('who has this IP?'), 2=Reply ('I do, here's my MAC'), 3/4=RARP request/reply (legacy). [RFC 826]" },
      { id: "sha", name: "Sender Hardware Address", bits: 48, color: "blue", category: "addressing",
        description: "Sender's MAC address. Receivers cache the (SPA, SHA) pair so future packets to the sender's IP can be addressed at L2. Length is HLEN bytes; fixed at 48 bits for Ethernet." },
      { id: "spa", name: "Sender Protocol Address", bits: 32, color: "teal", category: "addressing",
        description: "Sender's IPv4 address. Combined with SHA, it tells the LAN 'this IP lives at this MAC'. Gratuitous ARP uses SPA = TPA to announce or detect address conflicts." },
      { id: "tha", name: "Target Hardware Address", bits: 48, color: "violet", category: "addressing",
        description: "Target's MAC address — the value the requester wants to learn. Zero (00:00:00:00:00:00) in an ARP request; filled in on the reply." },
      { id: "tpa", name: "Target Protocol Address", bits: 32, color: "teal", category: "addressing",
        description: "Target's IPv4 address — the address being resolved. e.g. 'who has 192.168.1.1?' carries TPA = 192.168.1.1." },
    ],
  },

  tlsRecord: {
    name: "TLS Record Layer",
    rowBits: 8,
    byteOrder: "Network byte order (big-endian, MSB-first). The 16-bit Length is split here as high byte then low byte.",
    description: "TLS record layer header (RFC 8446 §5.1). 5-byte fixed header that frames every TLS record on the wire.",
    fields: [
      { id: "type", name: "Content Type", bits: 8, color: "blue", category: "type",
        description: "What kind of record this carries — drives demultiplexing inside the TLS stack. e.g. 20=ChangeCipherSpec, 21=Alert, 22=Handshake (ClientHello/ServerHello/...), 23=ApplicationData (encrypted HTTP traffic), 24=Heartbeat. [RFC 8446 §5.1]" },
      { id: "versionMajor", name: "Version (Major)", bits: 8, color: "violet", category: "type",
        description: "Legacy record-version major byte — always 0x03 from SSL 3.0 through TLS 1.3. The actual negotiated version lives in the Handshake messages, not here." },
      { id: "versionMinor", name: "Version (Minor)", bits: 8, color: "violet", category: "type",
        description: "Legacy record-version minor byte. 0x01=TLS 1.0, 0x03=TLS 1.2. TLS 1.3 still sends 0x0303 here so middleboxes that hard-code TLS 1.2 don't drop the packet. [RFC 8446 §5.1]" },
      { id: "lengthHi", name: "Length (high byte)", bits: 8, color: "teal", category: "length",
        description: "High byte of the 16-bit big-endian fragment length — receiver uses (Hi << 8) | Lo to know how many bytes follow this header. Max 2^14 + 256 bytes for a TLSCiphertext fragment." },
      { id: "lengthLo", name: "Length (low byte)", bits: 8, color: "teal", category: "length",
        description: "Low byte of the 16-bit big-endian fragment length. Combined with the high byte to give the total bytes of TLS fragment that follow." },
    ],
  },

  quicShort: {
    name: "QUIC Short Header (1-RTT)",
    rowBits: 32,
    byteOrder: "Network byte order (big-endian, MSB-first). The Connection ID and Packet Number bytes are transmitted in the order shown.",
    description: "QUIC v1 short-header (1-RTT) packet (RFC 9000 §17.3). Connection ID and Packet Number lengths are negotiated out-of-band; this preset assumes an 8-byte Destination CID and 1-byte Packet Number for illustration.",
    fields: [
      { id: "headerForm", name: "Header Form (0=Short)", bits: 1, color: "blue", category: "type",
        description: "0 = short header (1-RTT, used after the handshake), 1 = long header (Initial/Handshake/0-RTT/Retry, used during connection setup). [RFC 9000 §17.2/17.3]" },
      { id: "fixedBit", name: "Fixed Bit", bits: 1, color: "slate", category: "reserved",
        description: "Must be 1 in QUIC v1 — receivers drop packets where this bit is 0. Helps distinguish QUIC from random UDP traffic and reserved bit patterns. [RFC 9000 §17.2]" },
      { id: "spinBit", name: "Spin Bit", bits: 1, color: "amber", category: "flags",
        description: "Latency spin bit — toggled once per RTT, letting passive on-path observers measure RTT without breaking encryption. Endpoints may disable it for privacy. [RFC 9000 §17.4]" },
      { id: "reserved", name: "Reserved", bits: 2, color: "slate", category: "reserved",
        description: "Reserved bits — protected by header protection on the wire, but must decrypt to 0; otherwise the receiver MUST close the connection with a PROTOCOL_VIOLATION error. [RFC 9000 §17.3.1]" },
      { id: "keyPhase", name: "Key Phase", bits: 1, color: "rose", category: "flags",
        description: "Identifies which set of packet-protection keys is in use; the bit flips when a key update happens, so receivers know to switch to the new keys. [RFC 9000 §6]" },
      { id: "pnLen", name: "Packet Number Length", bits: 2, color: "violet", category: "length",
        description: "Encoded length of the Packet Number field minus 1 — values 0–3 mean 1–4 bytes of packet number. Protected by header protection so on-path observers can't read it. [RFC 9000 §17.3.1]" },
      { id: "dcid", name: "Destination Connection ID", bits: 64, color: "teal", category: "addressing",
        description: "Receiver-chosen Connection ID — lets QUIC survive NAT rebinding and IP address changes (a phone moving from Wi-Fi to LTE). Length is negotiated (0–20 bytes); shown here as 8 bytes." },
      { id: "packetNumber", name: "Packet Number", bits: 8, color: "amber", category: "identifier",
        description: "Truncated packet number — monotonically increasing per packet within an encryption level; used both for AEAD nonce construction and loss detection. 1–4 bytes wide per Packet Number Length. [RFC 9000 §17.1]" },
    ],
  },

  vlan: {
    name: "Ethernet II + 802.1Q VLAN Tag",
    rowBits: 32,
    byteOrder: "Network byte order (big-endian, MSB-first). The TCI (PCP/DEI/VID) is packed into a single 16-bit big-endian field after TPID.",
    description: "Ethernet II frame header with an inserted 802.1Q VLAN tag (IEEE 802.1Q-2018). 18-byte header: a 4-byte tag (TPID + TCI) sits between Source MAC and the original EtherType.",
    fields: [
      { id: "dstMac", name: "Destination MAC", bits: 48, color: "violet", category: "addressing",
        description: "48-bit destination MAC — same role as in a plain Ethernet frame. The VLAN tag does not change addressing, only the broadcast domain on the switch." },
      { id: "srcMac", name: "Source MAC", bits: 48, color: "blue", category: "addressing",
        description: "48-bit sender MAC. Switches learn it per-VLAN, so the same MAC can theoretically be reused in different VLANs." },
      { id: "tpid", name: "TPID", bits: 16, color: "orange", category: "type",
        description: "Tag Protocol Identifier — the magic value that announces a VLAN tag is present. 0x8100 for a single 802.1Q tag; 0x88A8 marks an outer 802.1ad (Q-in-Q / provider) tag." },
      { id: "pcp", name: "PCP", bits: 3, color: "rose", category: "type",
        description: "Priority Code Point — 3-bit IEEE 802.1p class-of-service (0–7) that switches use to pick output queues. e.g. 5 for voice, 6 for video, 0 for best-effort." },
      { id: "dei", name: "DEI", bits: 1, color: "slate", category: "flags",
        description: "Drop Eligible Indicator — when set, marks the frame as a candidate to drop first during congestion. Formerly CFI in legacy 802.1Q." },
      { id: "vid", name: "VLAN ID", bits: 12, color: "amber", category: "identifier",
        description: "12-bit VLAN identifier (0–4095) — selects the virtual LAN this frame belongs to. 0=priority-tagged only (no VLAN), 1=default VLAN, 4095=reserved." },
      { id: "etherType", name: "EtherType", bits: 16, color: "teal", category: "type",
        description: "EtherType of the payload after the VLAN tag — the same field that would have appeared in an untagged frame. e.g. 0x0800=IPv4, 0x86DD=IPv6, 0x0806=ARP." },
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

// Human-readable labels for the semantic categories used in the legend.
export const CATEGORY_LABELS = {
  addressing: "Addressing",
  identifier: "Identifier / sequencing",
  length: "Length / size",
  type: "Type / protocol selector",
  flags: "Flags / control bits",
  reserved: "Reserved / padding",
  checksum: "Checksum / integrity",
  variable: "Variable-length options",
  "payload-marker": "Payload marker",
};

// Default byte-order note shown above the diagram when a packet doesn't
// override it. Almost all IETF protocols use network byte order.
export const DEFAULT_BYTE_ORDER =
  "Network byte order (big-endian, MSB-first).";

// Collect the unique categories present in a packet, preserving the order
// they first appear in the field list. Used by the renderer/legend.
export function packetCategories(packet) {
  const seen = new Set();
  const out = [];
  for (const field of packet.fields) {
    if (field.category && !seen.has(field.category)) {
      seen.add(field.category);
      out.push(field.category);
    }
  }
  return out;
}
