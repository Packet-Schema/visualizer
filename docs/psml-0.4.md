# PSML 0.4 — Packet Schema Markup Language

PSML is a small declarative schema for describing the bit-level layout of
network protocol headers. A PSML packet is a tree of typed fields and
composition primitives; expressions are evaluated against a per-packet
environment to drive variable-length structures and bidirectional
constraints. PSML is the canonical wire format for Packet View — every
import / export format converts to or from PSML, and the renderer consumes
PSML via a thin runtime adapter.

This document describes PSML 0.4. The JSON serialization is normative;
the in-memory TypeScript shape lives at
`web/lib/psml/types.ts` and the JSON Schema at
`schemas/psml.schema.json`.

> **What's new in 0.4.** Four additive primitives push PSML past
> fixed-shape protocols and into the "real wire" zone:
> an `optional` Container (a field that exists only when a predicate
> evaluates truthy — TLS extensions, IPv6 next-header options); a
> `berLength` Type for ASN.1 BER/DER short- and long-form length
> octets (X.509, SNMP, LDAP); a `peek` Expression that reads N bits
> from a forthcoming offset *without consuming them*, which lets
> `Switch` discriminate on a field that hasn't been parsed yet
> (TLS extension type, framed protocols); and a per-field
> `byteOrder` override so a single packet can mix endiannesses
> (PCIe TLP headers are BE wrapping LE payloads). These additions
> are upward-compatible with 0.2 and 0.3 — existing presets parse and
> render unchanged.

> **What's new in 0.3** (kept for reference). A `varint` Type for
> self-describing variable-length integers (QUIC / protobuf / CBOR),
> an `encrypted` Container for opaque-on-the-wire payloads whose
> plaintext shape is known once keys are applied, and a `viewMode`
> parameter (`'wire'` vs `'semantic'`) on `normalize` / `resolveLayout`
> to toggle between the two presentations.

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
| `berLength` *(0.4)* | `{ kind: "berLength" }` | runtime (1 / 2 / 3 / 5 / 9 bytes — see below) |

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

### BER/DER length (0.4)

A `berLength` Type describes an ASN.1 BER/DER length octet sequence as
specified in ITU-T X.690 §8.1.3. Like `varint`, the on-wire bit width is
data-dependent:

| First-byte form | Meaning | Total bytes |
| --- | --- | --- |
| `0x00..0x7F` | short form: low 7 bits *are* the length | 1 |
| `0x81` + 1 byte | long form, 1 follow-on byte (length 0..255) | 2 |
| `0x82` + 2 bytes | long form, 2 follow-on bytes (length 0..65535) | 3 |
| `0x84` + 4 bytes | long form, 4 follow-on bytes | 5 |
| `0x88` + 8 bytes | long form, 8 follow-on bytes | 9 |
| `0x80` | indefinite form (BER only; terminated by end-of-contents) | 1 + content |

Because the width is data-dependent, `normalize` and `resolveLayout`
treat a `berLength` field as 8 bits (the short form, the minimum) unless
the env supplies an override keyed by the field id, in which case the
override is the concrete bit count for that instance. This matches the
`varint` convention.

JSON form:

```json
{ "id": "sigLen", "name": "Signature Length",
  "type": { "kind": "berLength" },
  "category": "length" }
```

#### Worked example: X.509 SEQUENCE

An X.509 `Certificate` is a top-level `SEQUENCE` whose body fits in a
TLV — tag, length, value. The length is BER/DER-encoded. A real-world
2048-bit RSA cert weighs in around 1200 bytes, so its outer length is
the long-form `0x82 0xNN 0xNN` (3 bytes).

```ts
const x509Outer: Packet = {
  name: "X.509 Certificate (outer TLV)",
  rowBits: 8,
  byteOrder: "BE",
  body: [
    { id: "tag", name: "Tag=SEQUENCE (0x30)",
      type: int(8), category: "type", defaultValue: 0x30 },
    { id: "len", name: "Length",
      type: { kind: "berLength" }, category: "length" },
    { id: "value", name: "TBSCertificate + sig",
      type: { kind: "bytes", n: ref("len") }, category: "payload-marker" },
  ],
};
```

In design-time view the `len` field renders as a single byte (short
form). With `env: { len: 24 }` it stretches to three bytes (long form,
2 follow-on bytes), and the constraint `value.n == len` keeps the
value-bytes slot in sync. The same Type also covers SNMP SMI OIDs,
LDAP message lengths, and any other place ASN.1 BER hides in a wire
format.

## Expressions

Pure, side-effect-free integer expressions. Operators: `+ - * / % << >>`
(division floors, shifts are 32-bit, matching JavaScript's semantics).

```ts
type Expr =
  | { kind: "lit"; value: number }
  | { kind: "ref"; field: string }              // env lookup
  | { kind: "op"; op: BinOp; a: Expr; b: Expr }
  | { kind: "cond"; test: Expr; t: Expr; f: Expr }
  | { kind: "peek"; bits: number; offset?: Expr }; // 0.4 — lookahead
```

`ref` resolves against the packet env (`Map<string, number>`). Missing
refs throw `MissingRefError`; the constraint solver and normalizer
translate that into safe default behaviour where appropriate.

### Peek expression (0.4)

`peek` reads `bits` bits starting at byte `offset` (default `0`)
**without consuming them**. It exists so a `Switch` can dispatch on a
discriminator that lives *inside* one of the cases — the canonical
example is a TLS extension block, where the variant of each element is
selected by reading the first 16 bits of that element (the extension
type) before the element itself begins.

Evaluation reads from a synthetic env key
`__peek__<offset>__<bits>` (filled in by the importer or the runtime
when wire bytes are available). If the key is absent, `peek` evaluates
to `0` — this keeps design-time layout reproducible: every case in the
Switch is reachable from the editor, and a captured packet picks one.

`bits` must be between 1 and 64 inclusive; `offset` (if provided) is a
full `Expr`, so the offset itself can depend on earlier fields.

#### Worked example: TLS extension type dispatch

A TLS 1.2/1.3 ClientHello carries a length-prefixed sequence of
`(type:16, length:16, body:length-bytes)` extension records. Each
record's variant is selected by the *type* — but the type is the
extension's first 16 bits, so a plain `Switch on ref(...)` can't see
it. With `peek` the dispatch becomes natural:

```ts
{
  kind: "repeat",
  id: "extensions",
  name: "Extensions",
  category: "variable",
  count: { until: ref("__exts_eos__") },        // or "eos"
  element: struct("extRec", [
    { kind: "switch",
      id: "extByType",
      on: { kind: "peek", bits: 16, offset: lit(0) },
      cases: {
        "0":  struct("sni",                /* server_name */          [ ... ]),
        "43": struct("supported_versions",                            [ ... ]),
        "10": struct("supported_groups",                              [ ... ]),
        "51": struct("key_share",                                     [ ... ]),
      },
      default: struct("unknown_ext", [
        { id: "type",   name: "Type",   type: int(16), category: "type"   },
        { id: "length", name: "Length", type: int(16), category: "length" },
        { id: "data",   name: "Data",   type: { kind: "bytes", n: ref("length") },
          category: "payload-marker" },
      ]),
    },
  ]),
}
```

Each variant struct (e.g. `sni`) starts with its own concrete
`type:16` and `length:16` fields — the `peek` only chose the variant;
the cells themselves consume bytes the normal way.

## Containers

```ts
type Container = Field | Repeat | Switch | Group | Encrypted | Optional;
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
- **`Optional`** *(0.4)* — a single child `Field` that exists when a
  predicate `Expr` evaluates truthy. See below.

### Optional (0.4)

```ts
type Optional = {
  kind: "optional";
  when: Expr;
  field: Field;
};
```

When `eval(when, env)` is truthy, normalize emits the inner `field` as
if it were a sibling. When falsy, the optional is *erased* — it
contributes 0 bits to the wire layout and no row to the diagram. The
renderer surfaces a faint placeholder slot (a "~ Optional ~" row) in
RFC-ASCII output so readers can see where the conditional lives.

JSON form:

```json
{
  "kind": "optional",
  "when": { "kind": "ref", "field": "has_payload" },
  "field": {
    "id": "payload",
    "name": "Payload",
    "type": { "kind": "bytes", "n": { "kind": "ref", "field": "payloadLen" } },
    "category": "payload-marker"
  }
}
```

Typst dict authoring form:

```
(kind: "optional",
 when: (kind: "ref", field: "has_payload"),
 field: (id: "payload", name: "Payload",
         type: (kind: "bytes", n: (kind: "ref", field: "payloadLen")),
         category: "payload-marker"))
```

Three idiomatic `when` shapes cover most real-world uses:

- `when: lit(1)` — the field is always present (a no-op Optional;
  useful as a structural placeholder while editing a preset).
- `when: lit(0)` — the field is never present at design time (useful
  for "exists only when the parser sees a magic byte").
- `when: ref("flag")` — the common case: gate the field on a boolean
  flag that appears earlier in the packet. The IPv6 `Hop-by-Hop`
  options chain, the TCP `Urgent Pointer` (present iff URG=1), and
  the GRE optional `Checksum` / `Key` / `Sequence Number` fields all
  fit this shape.

The `when` Expr can be any of the four (now five, with `peek`) `Expr`
kinds — including `op` (e.g. `flag != 0`) and `cond` (e.g. tri-state
gating).

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
| `byteOrder` *(0.4)* | Optional `"BE"` \| `"LE"` override for **this field only**, taking precedence over the packet-level `byteOrder`. |

Doc-refs follow the convention `[RFC 9293 §4.1]` — anything that matches
`RFC \d+` is replaced by an anchor at runtime.

### Per-field byteOrder (0.4)

Most protocols are byte-order-homogeneous: IPv4, TCP, and TLS are all
big-endian; USB, MS-RPC, and almost all PCI-family formats are
little-endian. For these, the packet-level `byteOrder` is enough.

A small but important set of protocols mix endiannesses inside a single
packet. The canonical example is PCI Express: a TLP (Transaction Layer
Packet) header is **big-endian** (per the PCIe spec's byte numbering),
while many of the addresses and capability registers it points at are
**little-endian** when read by the host. ATA / NVMe command structures,
some Bluetooth HCI events, and bridged USB-over-network formats are
in the same family.

PSML 0.4 adds an optional `byteOrder` field on `Field` itself. When
present, it overrides the packet-level `byteOrder` for that one cell.
The renderer surfaces the override with a small `[LE]` (or `[BE]`)
suffix on the cell label, so a reader scanning the diagram can see at
a glance "this register is the odd one out".

#### When to use it

- The protocol spec is itself mixed (PCIe TLP header big-endian wrapper
  around a little-endian address payload).
- The packet is a bridge / encapsulation between two protocol families
  with different conventions (e.g. a network packet carrying a
  little-endian memory-mapped IO register dump).
- A single struct embeds a foreign-endian sub-field — for example, a
  big-endian outer frame whose `timestamp` field is documented as
  little-endian for compatibility with an older tool.

If the entire packet is one consistent endianness, use the
packet-level `byteOrder` only; don't sprinkle per-field overrides.

#### Example: PCIe TLP fragment (illustrative)

```ts
const pcieTlpFragment: Packet = {
  name: "PCIe TLP Header fragment (illustrative)",
  rowBits: 32,
  byteOrder: "BE",
  body: [
    { id: "fmt_type", name: "Fmt/Type",
      type: bits(8), category: "type" },
    { id: "tc", name: "TC", type: bits(3), category: "flags" },
    { id: "flags", name: "Flags", type: bits(13), category: "flags" },
    { id: "length", name: "Length",
      type: bits(10), category: "length" },
    // Address payload is little-endian in the host's view.
    { id: "address", name: "Address",
      type: int(32), category: "addressing",
      byteOrder: "LE" },
  ],
};
```

In the resolved layout, every cell except `address` honours the
packet-level BE. `address` is laid out LE; the renderer marks the cell
`Address [LE]`. This is illustrative — a real PCIe TLP has more fields
and stricter alignment, but the byte-order pattern is exactly this.

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
  "version": "0.4",
  "name": "...",
  "rowBits": 32,
  "byteOrder": "BE",
  "description": "...",
  "body": [...],
  "constraints": [...],
  "env": { "ihl": 5 }
}
```

`"0.2"`, `"0.3"`, and `"0.4"` are all accepted by the JSON Schema
validator; each version's additions are new `oneOf` branches, so a
0.2 or 0.3 document continues to validate unchanged. 0.4-only
documents (those that use `optional`, `berLength`, `peek`, or a
per-field `byteOrder`) must declare `"version": "0.4"`.

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
drawer). The format hub itself is three files:

- `web/lib/formats/json.ts` — `toJson(psmlPacket, env)` /
  `fromJson(text)`.
- `web/lib/formats/rfc-ascii.ts` — `toAscii(psmlPacket, env, opts?)`
  (uses PSML's normalize internally; `opts.viewMode` selects wire vs
  semantic rendering in 0.3).
- `web/lib/formats/aug-ascii.ts` — `fromAad(text)` (Augmented Packet
  Header Diagrams — best-effort import).

### 0.4 behaviour per format

- **JSON** — every 0.4 primitive (`optional` Container, `berLength`
  Type, `peek` Expression, per-field `byteOrder`) round-trips
  losslessly. All four are tagged objects (or, in `byteOrder`'s case,
  a plain string property on `Field`), so the standard JSON encoder
  handles them once the in-memory types are extended. The `version`
  field bumps to `"0.4"` when any 0.4-only primitive is emitted.
- **RFC ASCII** — renders Optional as a faint `~ Optional ~` row when
  the predicate is falsy and inline as the inner field when truthy;
  prints `BER len` with a tilde-bordered placeholder cell whose width
  reflects the env override (or 1 byte fallback); leaves `peek` *no
  visible artefact* (it's a dispatch helper, not a wire field); and
  appends `[LE]` (or `[BE]`) to any field carrying a per-field
  byteOrder override.
- **Augmented ASCII (AAD)** — *cannot* express any 0.4 primitive. The
  importer warns when it would have to invent one (e.g. a TLS
  extensions block in AAD source becomes a single opaque `bytes`
  field with a warning); the exporter has no inverse.
- **Kaitai (.ksy)** — Optional becomes `if: <kaitai-expr>` when the
  predicate is expressible (a single ref or simple comparison), else
  a `# psml-only: optional …` comment. `berLength` is emitted as a
  `u1` placeholder plus a `# psml-only: berLength` comment. `peek` is
  emitted as a comment only — Kaitai has no lookahead expression.
  Per-field `byteOrder` round-trips cleanly as the per-field
  `endian: be | le` attribute.

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

## Adding a preset (YAML authoring)

Built-in presets live as YAML in `data/presets/<key>.psml.yaml`. They are
validated against `schemas/psml.schema.json` and compiled to
`web/lib/psml/presets.generated.ts` by `web/scripts/build-presets.ts` at
build time (wired through the `prebuild` and `pretest` npm hooks).

To add a new preset:

1. Drop a file into `data/presets/`, e.g. `mything.psml.yaml`. The
   filename stem becomes the preset key (`mything`).
2. Start it with the schema pragma so editors with the
   `yaml-language-server` extension give you completion and validation:
   ```yaml
   # yaml-language-server: $schema=../../schemas/psml.schema.json
   name: My Thing
   rowBits: 32
   byteOrder: BE
   body:
     - { id: foo, name: Foo, type: { kind: int, bits: 8 }, category: type }
   ```
3. Run `npm run build:presets` from `web/` (or just `npm test` /
   `npm run build` — the hooks run it for you).
4. The new preset is now in `PRESETS` and available via the preset
   picker. No TS changes required.

Reusable sub-trees can be defined as YAML anchors (recommended for option
catalogs, extension TLV cases, IPv6 extension-header chains, etc.).
Top-level keys whose names start with `_` are treated as anchor-only and
are stripped from the generated registry. Example:

```yaml
_tcp_option_variants: &tcp_option_variants
  "0": { id: eol, fields: [ ... ] }
  "1": { id: nop, fields: [ ... ] }
  # ...

body:
  - kind: repeat
    id: options
    element:
      id: optionRecord
      fields:
        - kind: switch
          id: byKind
          on: { kind: ref, field: optKind }
          cases: *tcp_option_variants
    count: { kind: ref, field: tcpOptionsCount }
```

The generated file (`web/lib/psml/presets.generated.ts`) is gitignored;
do not edit it by hand and do not commit it.

## Renderer interpretation

PSML is intentionally semantic-only — the schema declares structure and
intent (`category`, Group / Repeat / Switch), the renderer decides how to
draw it. The first design principle ("Semantic, not presentational")
already calls this out for `category → CSS color`; the diagram-first UI
extends the same idea to layout.

### Group collapse → parent cell + sub-cells

A `Group` whose children are all leaf `Field`s renders as **one parent
cell with sub-cells** rather than N flat sibling cells:

| PSML | Renderer |
| --- | --- |
| `Group { children: [R, DF, MF] }` (IPv4 flags) | One `flagsBits` cell with three 1-bit sub-cells `R / DF / MF` |
| `Group { children: [Type, Length, Pointer, Addr 1, Addr 2, Addr 3] }` (Record Route option) | One `Record Route` cell with the variant's six sub-cells |

Groups containing compound children (nested `Repeat`/`Switch`/`Group`)
fall back to the splice behaviour PSML documents — those structurally
have to flatten. Other consumers (RFC ASCII / JSON / Kaitai) keep the
flat read of `NormalizedField[]`; only the layout pass interprets
adjacency.

### Slot-based TLV workflow

A TLV `Repeat<Switch>` rewrites to one of three diagram shapes depending
on the renderer mirror's `tlv.instances` and a caller-supplied slot
size (= the number of bytes the upstream length controller has reserved,
e.g. `(IHL − 5) × 4` for IPv4):

1. **Slot only** (no instances yet) — emit a single `bytes(slot)` cell
   labelled `Options`. Clicking it opens the full `TlvEditor` so the
   user can append the first record.
2. **Populated** — emit one `Group` per instance (= the variant's leaf
   fields). Each instance renders as a single cell whose sub-cells
   show the Type / Length / Value internals.
3. **Populated + remaining** — when instances total bytes are less than
   the slot, emit a trailing `bytes(remaining)` placeholder. The
   diagram visually closes on the controller boundary.

The rewrite happens in `web/lib/psml/psml-to-renderer/apply-tlv.ts`. It
runs only at layout time — `NormalizedField[]` and the on-disk PSML are
unchanged, so a roundtrip through JSON / share-URL stays canonical.

### Override surfaces

Editing affordances are derived from PSML primitives, not declared in
the schema:

| Primitive | Affordance |
| --- | --- |
| `Constraint` of `ref × lit = ref` (or `± lit`) | length-controller slider in `OverridePanel` |
| `Switch on ref(X)` (top-level / Group subfield) | dropdown that sets env[X] |
| `Switch on peek(...)` | synthetic case picker in panel extras |
| `Optional when ref(X)` | toggle that sets env[X] to 0/1 |
| `TypeVarint` / `TypeBerLength` | width radio (`8 / 16 / 32 / 64` bits etc.) |
| `TypeEnum` | dropdown of variants |
| Field-level `byteOrder: "BE" | "LE"` | BE/LE toggle (schema-edit via studio reducer) |
| `Repeat<Switch>` (TLV catalog) | `TlvEditor` (append + per-row variant + reorder + remove) |
| `Repeat<Switch>` (chain catalog) | `ChainEditor` (IPv6 extension headers) |
| `Repeat { count: until / eos / ref(X) }` (non-TLV / non-chain) | stepper in the panel extras |

This list IS the surface area of `OverridePanel` and the matching
widgets. PSML doesn't need a `ui:` field — the renderer picks an
affordance based on the structure alone.

## Out of scope

- Actual decryption — PSML 0.3 models the *shape* of an encrypted
  payload but does not handle keys, AEAD, or SSLKEYLOGFILE-style flows.
  The renderer renders structure, not bytes.
- Generating parser code (that's Kaitai's job; we don't try to replace
  `ksc`).
- Surface syntax change — Typst dict literals continue to be the
  on-disk authoring format for Packet View's preset library.
