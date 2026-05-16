# Packet View

Interactive packet diagrams for teaching and learning network protocols.

Packet View renders the headers of common network protocols as live, clickable
SVG diagrams. Pick a protocol from the picker, hover or click any field for an
inline explanation, drag the variable-length sliders to see how IHL or Data
Offset reshape the header, and export the result as JSON, RFC-style ASCII art,
or a printable classroom worksheet. Everything runs in the browser from static
files — no build step, no server-side code, no tracking.

## For teachers

- One-click **worksheet export**: opens a printable HTML page with the diagram
  and a numbered fill-in table. Add `?answers=1` to the URL of the worksheet
  tab to flip it into an answer key for grading.
- Print CSS is tuned for A4 / Letter with `@page { margin: 1cm }`.

## For learners

- Click any field in the diagram to see its size, role, and (where available)
  RFC reference.
- Hover compact acronyms (DSCP, ECN, MF, RA, ...) for an expanded explanation.
- Slide the length controllers to watch IPv4 Options or TCP Options grow and
  shrink in real time.

## For protocol authors

- **Import / Export** modal supports JSON (round-trip), RFC ASCII art (export),
  and Augmented ASCII Diagrams / AAD (import) so you can paste a draft from an
  Internet-Draft or hand-written sketch and see it rendered immediately.

## Run locally

No dependencies. From the project root:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000/> in a browser.

## Supported protocols

Twelve built-in presets, grouped by OSI layer:

- **Layer 2 — Link**: Ethernet II, Ethernet II + 802.1Q VLAN tag
- **Layer 3 — Network**: IPv4, IPv6, ARP, ICMP (echo), ICMPv6 (echo)
- **Layer 4 — Transport**: TCP, UDP
- **Application**: DNS, TLS Record Layer, QUIC short header (1-RTT)

## Roadmap

- TLV / option expansion inside variable-length fields (TCP Options, IPv4
  Options, TLS extensions).
- More presets: SCTP, GRE, VXLAN, HTTP/2 frame, BGP UPDATE.
- In-page custom packet editor backed by the existing JSON schema.

## License

MIT.
