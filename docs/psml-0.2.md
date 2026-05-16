# PSML 0.2 — Packet Schema Markup Language

PSML is a small declarative schema for describing the bit-level layout of
network protocol headers. A PSML packet is a tree of typed fields and
composition primitives; expressions are evaluated against a per-packet
environment to drive variable-length structures and bidirectional
constraints. PSML is the canonical wire format for Packet View — every
import / export format converts to or from PSML, and the renderer consumes
PSML via a thin runtime adapter.

This document describes PSML 0.2. The JSON serialization is normative;
the in-memory TypeScript shape lives at
`web/lib/psml/types.ts` and the JSON Schema at
`schemas/psml.schema.json`.

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

`int` is conventionally network-byte-order; the explicit per-packet
`byteOrder` field documents the protocol's policy.

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
type Container = Field | Repeat | Switch | Group;
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
  "version": "0.2",
  "name": "...",
  "rowBits": 32,
  "byteOrder": "BE",
  "description": "...",
  "body": [...],
  "constraints": [...],
  "env": { "ihl": 5 }
}
```

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

---

## Format hub

The renderer consumes PSML via `web/lib/psml/runtime-from-psml.ts`,
which lowers PSML's recursive Container tree to a flat `Field[]` with
TLV/subfield/chain extras populated for the editor components. The
inverse `web/lib/psml/runtime-to-psml.ts` lifts the renderer's runtime
model back to PSML for export. The format hub itself is three files:

- `web/lib/formats/json.ts` — `toJson(psmlPacket, env)` /
  `fromJson(text)`.
- `web/lib/formats/rfc-ascii.ts` — `toAscii(psmlPacket, env)` (uses
  PSML's normalize internally).
- `web/lib/formats/aug-ascii.ts` — `fromAad(text)` (Augmented Packet
  Header Diagrams — best-effort import).

The Typst worksheet generator in `web/lib/worksheet-typst.ts` also
takes a PSML packet.

## Out of scope

- Kaitai .ksy import/export (Round 4).
- `encrypted_envelope` and varint primitives for QUIC and TLS 1.3
  (Round 5).
- Surface syntax change — Typst dict literals continue to be the
  on-disk authoring format for Packet View's preset library.
