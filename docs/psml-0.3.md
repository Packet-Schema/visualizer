# PSML 0.3 — Packet Schema Markup Language

PSML is a small declarative schema for describing the bit-level layout of
network protocol headers. A PSML packet is a tree of typed fields and
composition primitives; expressions are evaluated against a per-packet
environment to drive variable-length structures and bidirectional
constraints. PSML is the canonical wire format for Packet View — every
import / export format converts to or from PSML, and the renderer consumes
PSML via a thin runtime adapter.

This document describes PSML 0.3. The JSON serialization is normative;
the in-memory TypeScript shape lives at
`web/lib/psml/types.ts` and the JSON Schema at
`schemas/psml.schema.json`.

> **What's new in 0.3.** A `varint` Type for self-describing
> variable-length integers (QUIC / protobuf / CBOR), an `encrypted`
> Container for opaque-on-the-wire payloads whose plaintext shape is
> known once keys are applied, and a `viewMode` parameter (`'wire'` vs
> `'semantic'`) on `normalize` / `resolveLayout` to toggle between the
> two presentations. These additions are upward-compatible with 0.2:
> existing presets parse and render unchanged.

## Design principles

- **Semantic, not presentational.** Fields carry a `category` (addressing,
  length, flags, …). The renderer maps each category to a CSS variable;
  the schema does not encode color, padding, or any other styling intent.
- **Three composition primitives.** Repeat, Switch, Group. Anything that
  isn't a leaf Field is one of those three.
- **Expressions, not closures.** Variable-length and conditional layout
  are driven by a small expression algebra (`lit`, `ref`, `op`, `cond`).
  No JavaScript closures cross the wire; PSML is reproducible across
  toolchains.
- **Bidirectional constraints.** Equality between two expressions; a
  light-weight solver propagates user edits in either direction.
- **N+M, not N×M.** Every format converts only to/from PSML; pairwise
  glue between formats disappears.

## Types

| Kind | Shape | Bits |
| --- | --- | --- |
| `int` | `{ kind: "int", bits, signed? }` | fixed |
| `bits` | `{ kind: "bits", n }` | fixed |
| `bytes` | `{ kind: "bytes", n: Expr }` | `evalExpr(n) * 8` |
| `enum` | `{ kind: "enum", bits, variants: { [n]: label } }` | fixed |
| `varint` *(0.3)* | `{ kind: "varint", encoding: "quic" \| "protobuf" \| "cbor" }` | runtime (see below) |

`int` is conventionally network-byte-order; the explicit per-packet
`byteOrder` field documents the protocol's policy.

### Varint (0.3)

A `varint` Type describes a self-describing variable-length integer whose
on-wire bit width is determined by reading a prefix from the value bytes,
not by the schema. PSML 0.3 names three encodings:

| Encoding | Length determined by | Possible widths |
| --- | --- | --- |
| `quic` | first 2 bits of the first byte select 1 / 2 / 4 / 8 bytes (RFC 9000 §16) | 6, 14, 30, or 62 value bits (1 / 2 / 4 / 8 bytes total) |
| `protobuf` | continuation-bit (MSB) on every byte | multiple of 7 value bits per byte, until MSB is clear |
| `cbor` | initial-byte additional-info (RFC 8949 §3) | 0 / 1 / 2 / 4 / 8 follow-on bytes |

Because the width is data-dependent, `normalize` and `resolveLayout`
treat a `varint` field as design-time-empty (0 bits) unless the env
contains an override keyed by the field id, in which case the override
is consumed as the concrete bit count. This keeps PSML reproducible:
the schema is fixed, but a captured packet (or a slider in the UI) can
supply a concrete width for layout.

JSON form:

```json
{ "id": "pktnum_len", "name": "Packet Number Length",
  "type": { "kind": "varint", "encoding": "quic" },
  "category": "length" }
```

Typst dict form (preset-library authoring shape):

```
(id: "pktnum_len", name: "Packet Number Length",
 type: (kind: "varint", encoding: "quic"),
 category: "length")
```

Worked use: a QUIC packet's Packet Number Length is encoded in the low 2
bits of the (header-protected) first byte and ranges 1–4 bytes. A
`varint` field with `encoding: "quic"` captures that intent without
hard-coding a width — the runtime supplies the actual width once header
protection is peeled.

## Expressions

Pure, side-effect-free integer expressions. Operators: `+ - * / % << >>`
(division floors, shifts are 32-bit, matching JavaScript's semantics).

```ts
type Expr =
  | { kind: "lit"; value: number }
  | { kind: "ref"; field: string }              // env lookup
  | { kind: "op"; op: BinOp; a: Expr; b: Expr }
  | { kind: "cond"; test: Expr; t: Expr; f: Expr };
```

`ref` resolves against the packet env (`Map<string, number>`). Missing
refs throw `MissingRefError`; the constraint solver and normalizer
translate that into safe default behaviour where appropriate.

## Containers

```ts
type Container = Field | Repeat | Switch | Group | Encrypted;
```

- **`Field`** — a leaf with a `Type` and optional `category`, `doc`,
  `defaultValue`. The discriminator `kind` is optional on fields (anything
  without a `kind` property is implicitly a Field).
- **`Group`** — splice glue. Children are emitted inline in order.
  Common use: laying out the eight TCP flag bits as siblings.
- **`Repeat`** — N copies of an `element` Struct. `count` is one of:
  - an `Expr` evaluated against the env;
  - the literal string `"eos"`, meaning "consume the rest of the parent";
  - `{ until: Expr }`, a predicate that terminates expansion.
  Each copy gets `repeatIndex` in the normalized output.
- **`Switch`** — pick one of several variant Structs by evaluating `on`
  and matching against the case key (stringified). Optional `default`.
- **`Encrypted`** *(0.3)* — an opaque blob on the wire whose interior
  fields are knowable only after decryption. See below.

### Encrypted (0.3)

```ts
type Encrypted = {
  kind: "encrypted";
  id: string;
  name?: string;
  /** Substructure that exists when 'decrypted'. */
  plaintext: Struct;
  /** Bit width of the encrypted blob on the wire (when known). */
  wireBits?: Expr;
  /** Plain-English note about key/context (e.g. 'TLS 1.3 handshake keys'). */
  contextNote: string;
  /** Field ids INSIDE plaintext that are header-protected. */
  headerProtected?: string[];
  category?: CategoryToken;
  doc?: string;
};
```

The same Encrypted node is normalized in two distinct ways depending on
the active `viewMode`:

- **Wire mode** — emits **one** virtual `NormalizedField` with
  `bits = evalExpr(wireBits)` if `wireBits` is given, otherwise the sum
  of the plaintext fields' bit widths (a recursive wire-mode pass, so
  nested Encrypted blocks also collapse). The emitted field has
  `encrypted: true` and carries `encryptedContextNote`.
- **Semantic mode** — recurses into `plaintext.fields`. Every emitted
  leaf is tagged `encryptedParentId = <this encrypted.id>` and inherits
  the `encryptedContextNote`. Leaves whose id appears in
  `headerProtected` additionally get `headerProtected: true`. Nested
  Encrypted nodes apply the innermost frame for `parentId` /
  `contextNote`, but `headerProtected` matches if **any** ancestor frame
  lists the source field id.

`contextNote` is plain English describing the key material or protocol
state needed to decrypt — e.g. `"TLS 1.3 handshake keys"` or
`"QUIC 1-RTT keys + packet number space"`. The renderer surfaces it as
a tooltip on the encrypted block.

#### Worked example: a tiny encrypted packet

```ts
const tiny: Packet = {
  name: "Tiny Encrypted",
  rowBits: 32,
  byteOrder: "BE",
  body: [
    { id: "magic", name: "Magic", type: int(16), category: "type",
      defaultValue: 0xABCD },
    {
      kind: "encrypted",
      id: "payload",
      name: "Encrypted Payload",
      contextNote: "Demo session keys",
      wireBits: lit(32),
      headerProtected: ["seq"],
      plaintext: struct("payloadPt", [
        { id: "seq", name: "Seq",  type: bits(8),  category: "identifier" },
        { id: "msg", name: "Msg",  type: bits(24), category: "variable"   },
      ]),
    },
  ],
};
```

Normalized in **wire** mode (`{ viewMode: 'wire' }`):

| id | name | bits | encrypted |
| --- | --- | --- | --- |
| `magic`   | Magic              | 16 | — |
| `payload` | Encrypted Payload  | 32 | `true` |

Total bits: 48.

Normalized in **semantic** mode (`{ viewMode: 'semantic' }`):

| id | name | bits | encryptedParentId | headerProtected |
| --- | --- | --- | --- | --- |
| `magic` | Magic | 16 | — | — |
| `seq`   | Seq   |  8 | `payload` | `true` |
| `msg`   | Msg   | 24 | `payload` | — |

Total bits: 48. Each semantic-mode leaf also carries
`encryptedContextNote = "Demo session keys"`.

## Two-layer view: viewMode (0.3)

```ts
type ViewMode = "wire" | "semantic";
```

Most protocols have exactly one layout. QUIC and TLS 1.3 do not: the
**bytes on the wire** and the **semantic structure** diverge whenever
encryption is in play. PSML 0.3 models this with a `viewMode` parameter
on the two entry points:

```ts
normalize(packet, env, { viewMode });
resolveLayout(packet, { env, viewMode });
```

- `viewMode: 'wire'` (default) — the diagram matches what you'd see in
  a packet capture before any keys are applied. Encrypted containers
  collapse to a single opaque field of their `wireBits` width (or the
  sum of plaintext bits as a fallback). This is the right view for
  teaching "what does the byte stream look like".
- `viewMode: 'semantic'` — the diagram matches the post-decryption
  picture. Encrypted containers are erased; their `plaintext.fields`
  flatten into the surrounding layout, each tagged with
  `encryptedParentId` so the renderer can decorate (lock badge, thin
  accent border). This is the right view for teaching "what does the
  data *mean*".

`viewMode` is **not** part of the on-disk PSML schema. It's UI state.
A serialised packet round-trips unchanged regardless of the view it was
exported from; only the in-memory normalized layout differs.

### UI affordance: Decrypted view toggle

The Packet Viewer toolbar exposes a "Decrypted view" toggle (forward
reference — implemented in `web/components/PacketViewer.tsx` as part of
Phase 2C). Toggling it flips the active `viewMode` and re-runs
`resolveLayout`. Encrypted blocks in wire view render with a lock icon,
diagonal-stripe pattern, and reduced opacity; in semantic view, their
plaintext children render with a thin accent border and a corner lock
badge. Hovering an encrypted region always surfaces the `contextNote`
("Requires TLS 1.3 handshake keys to decrypt") regardless of mode.

### When to use which

| Protocol | wire | semantic |
| --- | --- | --- |
| Ethernet, IPv4, TCP, UDP, ICMP, ARP | identical | identical |
| TLS Record Layer (1.2) | identical | identical |
| TLS 1.3 (post-ServerHello) | record + opaque AEAD ciphertext | record + handshake messages |
| QUIC short header | header + encrypted payload + auth tag | header + STREAM / ACK / CRYPTO frames |
| QUIC long header (Initial / Handshake / 0-RTT) | header + length + encrypted payload | header + length + CRYPTO frames |

For protocols that don't carry an `Encrypted` container, both view modes
produce the same normalized output — the toggle is a no-op.

## Constraints

```ts
type Constraint = { lhs: Expr; rhs: Expr; doc?: string };
```

A bidirectional equality. The solver handles the simple shape where at
least one side reduces to a single `ref`; it can also peel one operator
from a `ref op lit` (or `lit op ref`) form to invert single-operator
arithmetic. The canonical example is `IHL × 4 = headerBytes`.

## Field metadata

| Field | Notes |
| --- | --- |
| `id` | Unique within the containing struct; allowed characters are alphanumerics and underscore. |
| `name` | Human-readable label shown in the diagram. |
| `type` | One of the four Type kinds above. |
| `category` | Optional semantic tag (drives renderer color via `web/lib/render-tokens.ts`). |
| `doc` | Free-form description. RFC references like `RFC 791` get auto-linked by the runtime enrichment pass. |
| `defaultValue` | Seeded into the env on initial layout. |

Doc-refs follow the convention `[RFC 9293 §4.1]` — anything that matches
`RFC \d+` is replaced by an anchor at runtime.

## Packet

```ts
type Packet = {
  name: string;
  rowBits: number;             // visual row width (e.g. 32 for IPv4)
  body: Container[];
  constraints?: Constraint[];
  byteOrder?: "BE" | "LE" | string;
  description?: string;
};
```

## JSON serialization

The on-disk JSON wraps the `Packet` shape with a discriminator:

```json
{
  "format": "psml",
  "version": "0.3",
  "name": "...",
  "rowBits": 32,
  "byteOrder": "BE",
  "description": "...",
  "body": [...],
  "constraints": [...],
  "env": { "ihl": 5 }
}
```

Both `"0.2"` and `"0.3"` are accepted by the JSON Schema validator; the
0.3 additions (`varint` Type, `encrypted` Container) are simply new
`oneOf` branches and a 0.2 document continues to validate.

The full schema lives at `schemas/psml.schema.json`.

---

## Worked example: IPv4

The IPv4 header is the canonical PSML example because it exercises
every primitive: bit-fields (`Version`, `IHL`), an inline `Group` for
the three Flag bits, bytes-typed addresses, a `Repeat<Switch>` for the
optional Options trailer, and a bidirectional constraint linking `IHL`
to total header bytes.

### Top-level shape

```ts
const ipv4: Packet = {
  name: "IPv4 Header",
  rowBits: 32,
  byteOrder: "BE",
  description: "IPv4 header (RFC 791) — IHL drives the Options length.",
  body: [ /* fields */ ],
  constraints: [ /* IHL ⇔ headerBytes */ ],
};
```

`rowBits: 32` means the renderer wraps at every 32-bit boundary —
matching the four-cell grid every IPv4 RFC diagram uses.

### Fixed prefix

```ts
{ id: "version", name: "Version", type: bits(4),
  category: "type", defaultValue: 4 },
{ id: "ihl", name: "IHL", type: bits(4),
  category: "length", defaultValue: 5 },
```

`Version` and `IHL` share row 0. They're both 4-bit `bits()` because the
nibble is an opaque numeric (PSML's `int` works just as well; `bits`
emphasises "no sign or overflow semantics here"). `defaultValue: 5` for
IHL means "fresh packets compute layout as if the user has set IHL=5",
which is what makes the constraint solver sensible on first load.

### Inline group: Flags

```ts
group("flagsBits", [
  { id: "flags_reserved", name: "R", type: bits(1), category: "flags" },
  { id: "flags_df",       name: "DF", type: bits(1), category: "flags" },
  { id: "flags_mf",       name: "MF", type: bits(1), category: "flags" },
]),
```

A `Group` is just splice glue — its children are emitted as siblings in
the normalized output, with the absolute bit offset incrementing per
child. The renderer doesn't see the group at all; it sees three 1-bit
sibling fields. We use a Group rather than a 3-bit field with subfields
because PSML's runtime model is "everything is a field tree", and this
keeps the model uniform.

### Variable-length tail: Options

```ts
{
  kind: "repeat",
  id: "options",
  name: "Options",
  category: "variable",
  element: struct("optionRecord", [
    { kind: "switch",
      id: "byType",
      on: ref("optType"),
      cases: ipv4OptionVariants },
  ]),
  count: ref("ipv4OptionsCount"),
}
```

This is the model in microcosm: a `Repeat` whose count is read from the
env (`ipv4OptionsCount`), an `element` that's a one-field Struct, and
that single field is a `Switch` that picks the variant Struct based on
the value of `optType`. Each pass adds one option record to the
normalized output; `repeatIndex` lets the renderer disambiguate "the
second copy of `addr0`" from the first.

The variant Structs themselves spell out each well-known IPv4 option:

```ts
"7": struct("recordRoute", [
  { id: "type",    name: "Type=7",  type: bits(8), category: "type" },
  { id: "length",  name: "Len=15",  type: bits(8), category: "length" },
  { id: "pointer", name: "Ptr",     type: bits(8), category: "identifier" },
  { id: "addr0",   name: "Addr 1",  type: int(32), category: "addressing" },
  { id: "addr1",   name: "Addr 2",  type: int(32), category: "addressing" },
  { id: "addr2",   name: "Addr 3",  type: int(32), category: "addressing" },
]),
```

There's no PSML magic for "TLV"; a TLV is just `Repeat<Switch>` with a
discriminator `ref` and a few well-known cases.

### Constraint: IHL ⇔ headerBytes

```ts
constraints: [
  { lhs: op("*", ref("ihl"), lit(4)),
    rhs: ref("headerBytes"),
    doc: "IHL counts 32-bit words; total header bytes = IHL × 4." },
],
```

The solver treats this as "given a user mutation of either side,
recompute the other". When IHL goes from 5 → 6, the solver writes
`headerBytes = 24`. When the user adds an IPv4 Option that pushes
`headerBytes` to 28, the solver inverts the multiplication and writes
`IHL = 7`. The `* 4` is the only operator the inverter needs to peel —
the constraint solver only handles one operator at a time, which is
sufficient for every preset Packet View ships.

> IPv4 is intentionally a 0.2-only example — it uses none of 0.3's new
> primitives. The wire layout *is* the semantic layout, so `viewMode`
> is a no-op for IPv4. For a 0.3-flavoured worked example, see the QUIC
> sketch below.

### Sketch: QUIC short header (0.3 primitives)

A QUIC 1-RTT packet exercises both 0.3 additions. In rough form:

```ts
const quicShort: Packet = {
  name: "QUIC Short Header (1-RTT)",
  rowBits: 32,
  byteOrder: "BE",
  body: [
    // Header byte (bottom 5 bits are header-protected — see Encrypted below).
    { id: "header_form", name: "Header Form=0", type: bits(1), category: "type" },
    { id: "fixed_bit",   name: "Fixed=1",       type: bits(1), category: "reserved" },
    { id: "spin_bit",    name: "Spin",          type: bits(1), category: "flags" },
    // Reserved (R), Key-phase (K), and Packet Number Length live in an
    // Encrypted block because they're recovered from header protection.
    {
      kind: "encrypted",
      id: "hp",
      name: "Header-protected bits",
      contextNote: "QUIC header protection (HP key)",
      wireBits: lit(5),
      headerProtected: ["hp_r", "hp_kp", "pn_len"],
      plaintext: struct("hpPt", [
        { id: "hp_r",   name: "R",   type: bits(2), category: "reserved" },
        { id: "hp_kp",  name: "K",   type: bits(1), category: "flags" },
        { id: "pn_len", name: "PNL", type: bits(2), category: "length" },
      ]),
    },
    { id: "dcid",  name: "Dest Conn ID",
      type: { kind: "bytes", n: ref("dcidLen") }, category: "addressing" },
    { id: "pn",    name: "Packet Number",
      type: { kind: "varint", encoding: "quic" }, category: "identifier" },
    {
      kind: "encrypted",
      id: "payload",
      name: "Encrypted Payload",
      contextNote: "QUIC 1-RTT keys + packet number space",
      // wireBits omitted — falls back to sum of plaintext bit widths.
      plaintext: struct("frames", [
        // ... STREAM / ACK / CRYPTO frames go here, modelled as Switch.
      ]),
    },
  ],
};
```

In wire view, `hp` collapses to 5 opaque bits and `payload` collapses to
one striped block. In semantic view, `hp` expands to its three named
flags (each tagged `headerProtected: true`) and `payload` expands to the
QUIC frame layout. Same schema, two diagrams.

---

## Format hub

After Round 6 the diagram layout is computed by `resolveLayout` directly
from PSML — there is no separate runtime resolver. For the React editing
components (TLV editor, chain editor, detail panel) PSML is lowered to a
renderer-shaped Packet by `web/lib/psml/psml-to-renderer.ts`, which
collapses Group nodes to subfields and promotes Repeat<Switch> bodies into
a TLV catalog / chain catalog the editors can mutate. The same module
exposes `rendererToPsml` for the inverse lift (used by the import/export
drawer and the worksheet generator). The format hub itself is three
files:

- `web/lib/formats/json.ts` — `toJson(psmlPacket, env)` /
  `fromJson(text)`.
- `web/lib/formats/rfc-ascii.ts` — `toAscii(psmlPacket, env, opts?)`
  (uses PSML's normalize internally; `opts.viewMode` selects wire vs
  semantic rendering in 0.3).
- `web/lib/formats/aug-ascii.ts` — `fromAad(text)` (Augmented Packet
  Header Diagrams — best-effort import).

The Typst worksheet generator in `web/lib/worksheet-typst.ts` also
takes a PSML packet.

### 0.3 behaviour per format

- **JSON** — `Varint` Types and `Encrypted` Containers round-trip
  losslessly. The on-disk shapes are exactly the JSON forms given in
  the [Varint](#varint-0-3) and [Encrypted](#encrypted-0-3) sections
  above (with a `kind` discriminator on each). The `version` field
  bumps from `"0.2"` to `"0.3"` when any 0.3-only primitive is emitted;
  documents that use only 0.2 primitives may keep the `"0.2"` version.
- **RFC ASCII** — gains a `viewMode` parameter. In wire mode an
  Encrypted block renders as a single ASCII row with the body
  `~Encrypted Payload~` (a `~` border marks "opaque to wire view"). In
  semantic mode the same block expands inline; expanded child rows are
  prefixed with `>>>` to mark "only visible after decryption". A
  `varint` field always renders with its maximum-encoding width and a
  `~` corner mark, with a note clarifying the runtime-determined width.
- **Kaitai (.ksy)** — Kaitai has no native notion of either Encrypted
  or Varint. The exporter emits both as YAML comments
  (`# psml-only: encrypted block …` and `# psml-only: varint …`) and
  the importer recognises no inverse construct; round-tripping a 0.3
  packet through `.ksy` is lossy by design.
- **Worksheet (Typst)** — an Encrypted block renders as a single blank
  fill-in row labelled `Encrypted (N bytes — requires <contextNote>)`,
  regardless of viewMode. Varint fields render as a single row with the
  width-prefix bits highlighted and a hint line "QUIC varint: 1/2/4/8
  bytes".

## Kaitai interop

PSML ships a light import/export bridge to [Kaitai Struct](https://kaitai.io/)
`.ksy` YAML files in `web/lib/formats/ksy.ts`. The bridge is read-mostly:
the importer prioritises producing a useful PSML packet from real-world
`.ksy` files (the [kaitai_struct_formats](https://github.com/kaitai-io/kaitai_struct_formats)
library has ~200+), even when that means dropping computed fields or
collapsing complex expressions. The exporter is best-effort and surfaces
anything PSML-specific as YAML comments prefixed `# psml-only:`.

### Supported (import)

| Kaitai construct | PSML mapping |
| --- | --- |
| `meta.id` / `meta.title` | `Packet.name` |
| `meta.endian: be \| le` | `Packet.byteOrder = "BE" \| "LE"` |
| `seq[]` | top-level `body: Container[]` |
| `type: u1 \| u2 \| u4 \| u8` | `TypeInt { bits: 8/16/32/64 }` |
| `type: s1 \| s2 \| s4 \| s8` | `TypeInt { signed: true }` |
| `type: b1..b64` | `TypeBits { n }` |
| `type: str \| strz` + `size: N` | `TypeBytes { n: lit(N) }` |
| `size: N` (no type) or `size: <ref>` | `TypeBytes` |
| `contents: "..."` | `TypeBytes` of magic byte length |
| `type: <userTypeName>` | `Group` whose children are the resolved seq |
| `types:` (nested) | recursive walk, merged into a child registry |
| `if: <simple-ref>` | `Switch` with cases `"1"` (present) / `"0"` (absent) |
| `repeat: expr` + `repeat-expr` | `Repeat { count: ref \| lit }` |
| `repeat: until` | `Repeat { count: { until: env-ref } }` |
| `repeat: eos` | `Repeat { count: "eos" }` |
| `doc` / `doc-ref` | concatenated into `Field.doc` (refs prefixed `See:`) |
| `enums:` (integer keys → labels) | `TypeEnum.variants` when the field cites the enum |

### Unsupported / lossy

| Construct | Status | Behaviour |
| --- | --- | --- |
| `instances:` (computed) | won't-fix | every instance emits a warning and is dropped |
| `process: zlib \| xor \| rotate` | won't-fix | warned and dropped (PSML has no transform pipeline) |
| Parametric types (`type(args)`) | planned | parameters dropped; bare type name resolved |
| `switch-on` type with complex cases | planned | non-`string` cases skipped with warnings |
| Kaitai expression language | planned | only bare `<identifier>` refs and integer literals are modelled; anything richer (arithmetic, `_io.eof`, ternaries) collapses to a placeholder ref and a warning |
| `valid:`, `terminator:`, `eos-error:` | planned | warned and dropped |
| `-webide-` / `-orig-id` extension keys | n/a | ignored silently |

### Export (PSML → .ksy)

`toKsy(packet)` produces a `.ksy` document with `meta`, `seq`, and (when
needed) `types:`. PSML-only features survive as comments at the top of
the file: `# psml-only: ...` lines tag dropped `category` tokens, dropped
`Constraint`s, any `Switch` whose cases can't be mapped to a Kaitai
`switch-on type`, and (new in 0.3) `Encrypted` containers and `Varint`
fields. Round-trip through `fromKsy(toKsy(p))` is not structurally
identical and is not the goal — the exporter exists so users can take a
Packet View definition into the Kaitai compiler (`ksc`) without
rebuilding it by hand.

## Out of scope

- Actual decryption — PSML 0.3 models the *shape* of an encrypted
  payload but does not handle keys, AEAD, or SSLKEYLOGFILE-style flows.
  The renderer renders structure, not bytes.
- Generating parser code (that's Kaitai's job; we don't try to replace
  `ksc`).
- Surface syntax change — Typst dict literals continue to be the
  on-disk authoring format for Packet View's preset library.
