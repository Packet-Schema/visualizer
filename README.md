# Packet View

[![tests](https://github.com/HackU-5/packet-view/actions/workflows/test.yml/badge.svg)](https://github.com/HackU-5/packet-view/actions/workflows/test.yml)

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
- Imports Kaitai Struct (.ksy) files for ~200+ existing formats.
- **PSML 0.3** — adds a `varint` Type and `encrypted` Container so QUIC
  and TLS 1.3 can be modelled at full fidelity (RFC 9000 §16
  variable-length integers, header-protected fields, encrypted payloads).
- **Two-layer view** — toggle "Decrypted view" in the toolbar to switch
  between the on-the-wire byte stream and the post-decryption semantic
  structure. Same schema, two diagrams.

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

## PSML 0.3

PSML — Packet Schema Markup Language — is the canonical wire format
behind every Packet View import, export, and built-in preset.

- Three composition primitives: **Repeat** (N copies of a struct),
  **Switch** (variant struct by discriminator), **Group** (splice glue),
  plus the 0.3 **Encrypted** container for opaque-on-the-wire payloads.
- Pure expressions (`lit`, `ref`, `op`, `cond`) drive variable-length
  layout — no JavaScript closures cross the wire.
- Bidirectional **constraints** propagate user edits in either
  direction (e.g. `IHL × 4 == headerBytes`).
- **Semantic, not presentational**: fields carry a `category`; the
  renderer maps category to a CSS variable in `web/lib/render-tokens.ts`.
- N+M format hub: every format converts to/from PSML, not pairwise.
- 0.3 additions: a `varint` Type (QUIC / protobuf / CBOR self-describing
  integers) and an `encrypted` Container with a `viewMode` toggle
  (`'wire'` vs `'semantic'`) on `normalize` / `resolveLayout`.

Spec: [`docs/psml-0.3.md`](./docs/psml-0.3.md).
JSON Schema: [`schemas/psml.schema.json`](./schemas/psml.schema.json).

## Tests

```
cd web
npm install
npm test               # run the Vitest suite (~265 tests)
npm run test:watch     # iterate in watch mode
npm run test:coverage  # generate coverage report (100% on lib/formats/)
```

CI runs lint + build + coverage on every push and pull request.

## Roadmap

- TLV / option expansion inside variable-length fields (TCP Options, IPv4
  Options, TLS extensions).
- More presets: SCTP, GRE, VXLAN, HTTP/2 frame, BGP UPDATE.
- In-page custom packet editor backed by the existing JSON schema.

## License

MIT.
