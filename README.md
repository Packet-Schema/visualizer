# Packet View

[![tests](https://github.com/HackU-5/packet-view/actions/workflows/test.yml/badge.svg)](https://github.com/HackU-5/packet-view/actions/workflows/test.yml)

Interactive packet diagrams for teaching and learning network protocols.

Packet View renders the headers of common network protocols as live, clickable
SVG diagrams. Pick a protocol from the picker, hover or click any field for an
inline explanation, drag the variable-length sliders to see how IHL or Data
Offset reshape the header, and export the result as JSON or RFC-style ASCII
art. Everything runs in the browser from static files — no build step, no
server-side code, no tracking.

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
- **PSML 0.4** — Optional fields, BER/DER length, lookahead Switch via
  peek expressions, per-field byteOrder for mixed-endian formats, on
  top of 0.3's `varint` Type and `encrypted` Container (QUIC and
  TLS 1.3 modelling at full fidelity).
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

## PSML 0.4

PSML — Packet Schema Markup Language — is the canonical wire format
behind every Packet View import, export, and built-in preset.

- Composition primitives: **Repeat** (N copies of a struct), **Switch**
  (variant struct by discriminator), **Group** (splice glue), the 0.3
  **Encrypted** container for opaque-on-the-wire payloads, and the 0.4
  **Optional** container for predicate-gated fields.
- Pure expressions (`lit`, `ref`, `op`, `cond`, and 0.4's `peek`) drive
  variable-length layout — no JavaScript closures cross the wire.
- Bidirectional **constraints** propagate user edits in either
  direction (e.g. `IHL × 4 == headerBytes`).
- **Semantic, not presentational**: fields carry a `category`; the
  renderer maps category to a CSS variable in `web/lib/render-tokens.ts`.
- N+M format hub: every format converts to/from PSML, not pairwise.
- 0.4 additions: **Optional fields, BER/DER length, lookahead Switch
  via peek expressions, per-field byteOrder for mixed-endian formats**
  (PCIe-style wrappers around foreign-endian payloads).
- 0.3 additions (kept): a `varint` Type (QUIC / protobuf / CBOR
  self-describing integers) and an `encrypted` Container with a
  `viewMode` toggle (`'wire'` vs `'semantic'`) on `normalize` /
  `resolveLayout`.

Spec: [`docs/psml-0.4.md`](./docs/psml-0.4.md).
JSON Schema: [`schemas/psml.schema.json`](./schemas/psml.schema.json).

### Adding a preset

Built-in presets live as YAML in [`data/presets/*.psml.yaml`](./data/presets/).
Each file is validated against the schema above and compiled to
`web/lib/psml/presets.generated.ts` by `web/scripts/build-presets.ts` (run
automatically before `npm test` and `npm run build`). To add one, drop a new
`<key>.psml.yaml` into `data/presets/` and run `npm run build:presets` —
no TypeScript edits required. See
[`docs/psml-0.4.md`](./docs/psml-0.4.md#adding-a-preset-yaml-authoring)
for the YAML authoring guide.

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

- Beyond 0.4: **layered packets** (an outer packet whose payload is
  itself a typed PSML packet — Ethernet/IP/TCP/TLS as one composed
  diagram instead of four siblings), and **type unions on byte-prefix
  discriminators** (a richer Switch that dispatches on a contents-match
  rather than a single integer value, for magic-byte-style framing).
- TLV / option expansion inside variable-length fields (TCP Options, IPv4
  Options, TLS extensions) — partially unlocked by 0.4's peek expression.
- More presets: SCTP, GRE, VXLAN, HTTP/2 frame, BGP UPDATE, X.509
  certificate, full PCIe TLP header.
- In-page custom packet editor backed by the existing JSON schema.

## License

MIT.
