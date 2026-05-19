// Acronym glossary for the detail panel / popover.
//
// Ported from /workspaces/packet-view/glossary.js. The keys are uppercase
// canonical acronyms; the values are short, beginner-friendly one-line
// glosses. `annotateAcronyms()` walks an already-HTML-escaped string and
// wraps every whole-word occurrence of a known key in a `<dfn>` tag carrying
// the gloss in `data-gloss`.
//
// Source description text in the data files is authored content, so we treat
// it as trusted-but-still-escape: we always escape before string-substituting
// HTML to avoid accidental tag interpolation from preset text.

export const GLOSSARY: Record<string, string> = {
  DSCP: "Differentiated Services Code Point — 6-bit QoS priority tag in the IP header.",
  ECN: "Explicit Congestion Notification — 2-bit signal letting routers report congestion without dropping packets.",
  IHL: "Internet Header Length — IPv4 header size in 32-bit words; min 5, max 15.",
  MTU: "Maximum Transmission Unit — largest packet size (in bytes) a link can carry without fragmentation.",
  MSS: "Maximum Segment Size — largest TCP payload the receiver is willing to accept in one segment.",
  TTL: "Time To Live — IPv4 hop counter; decremented at each router and the packet is dropped at zero.",
  MAC: "Media Access Control address — 48-bit hardware address that identifies a network interface on a LAN.",
  ARP: "Address Resolution Protocol — maps an IPv4 address to a MAC address on the local link.",
  ICMP: "Internet Control Message Protocol — diagnostic/error messages such as ping (Echo) and Destination Unreachable.",
  DNS: "Domain Name System — translates names like example.com into IP addresses.",
  TLS: "Transport Layer Security — encrypts and authenticates traffic above TCP (used by HTTPS).",
  QUIC: "QUIC — UDP-based encrypted transport that replaces TCP+TLS for HTTP/3.",
  RTT: "Round-Trip Time — time for a packet to reach the peer and an ack to come back.",
  CWND: "Congestion Window — sender-side cap on bytes in flight, grown/shrunk by congestion control.",
  RWND: "Receive Window — receiver-advertised buffer space; flow-control cap on bytes in flight.",
  SACK: "Selective Acknowledgment — TCP option letting the receiver report which non-contiguous bytes arrived.",
  SYN: "Synchronize — TCP flag that opens a connection by exchanging initial sequence numbers.",
  ACK: "Acknowledgment — TCP flag indicating the Acknowledgment Number field is meaningful.",
  FIN: "Finish — TCP flag signalling the sender has no more data to send.",
  RST: "Reset — TCP flag that abruptly tears down a connection.",
  PSH: "Push — TCP flag asking the receiver to deliver buffered data to the application immediately.",
  URG: "Urgent — TCP flag indicating the Urgent Pointer field is significant (rarely used today).",
  CWR: "Congestion Window Reduced — TCP flag (RFC 3168) showing the sender shrunk its window in response to ECN.",
  ECE: "ECN-Echo — TCP flag (RFC 3168) echoing a Congestion Experienced mark received from the network.",
  DF: "Don't Fragment — IPv4 flag forbidding routers from fragmenting the datagram.",
  MF: "More Fragments — IPv4 flag set on every fragment except the last.",
  QR: "Query/Response — DNS header bit; 0 means query, 1 means response.",
  AA: "Authoritative Answer — DNS header bit set when the responder is authoritative for the queried name.",
  TC: "TrunCation — DNS header bit set when the response was truncated to fit transport limits.",
  RD: "Recursion Desired — DNS header bit asking the server to resolve the name on the client's behalf.",
  RA: "Recursion Available — DNS header bit indicating the server supports recursive queries.",
  Z: "Z — reserved DNS header bits; must be zero (parts later reused for DNSSEC AD/CD).",
  RCODE: "Response Code — 4-bit DNS result; 0=NOERROR, 3=NXDOMAIN, etc.",
  EtherType:
    "EtherType — 16-bit value in an Ethernet frame identifying the upper-layer protocol (e.g. 0x0800 = IPv4).",
  NLRI: "Network Layer Reachability Information — BGP term for the set of IP prefixes advertised in an UPDATE.",
  AS: "Autonomous System — a network under a single routing administration, identified by an AS Number.",
  AAD: "Augmented ASCII Diagram — text format (RFC 8792-style) used by IETF to draw packet headers.",
};

// Sort by descending length so multi-character keys win over shorter ones.
const SORTED_KEYS = Object.keys(GLOSSARY).sort((a, b) => b.length - a.length);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ACRONYM_REGEX = new RegExp(
  "\\b(" + SORTED_KEYS.map(escapeRegex).join("|") + ")\\b",
  "g",
);

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Wrap recognised acronyms in an already-HTML-escaped string with
 * `<dfn class="acronym" tabindex="0" data-gloss="...">` tags. Input must be
 * HTML-escaped; output is HTML.
 */
export function annotateAcronyms(escapedHtml: string): string {
  return escapedHtml.replace(ACRONYM_REGEX, (match) => {
    const gloss = GLOSSARY[match];
    if (!gloss) return match;
    return `<dfn class="acronym" tabindex="0" data-gloss="${escapeAttr(gloss)}">${match}</dfn>`;
  });
}
