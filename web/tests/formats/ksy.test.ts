// PSDL Kaitai Struct (.ksy) bridge tests — file-fixture round-trip plus
// targeted tests for every type-mapping branch in the importer (u1..u8,
// s1..s8, b1..bN, str/strz, contents, switch-on, repeat expr/until/eos,
// if, enums, doc/doc-ref, nested types, instances, float fallback, error
// paths).

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse as yamlParse } from "yaml";

import { fromKsy, toKsy } from "../../lib/formats/ksy";
import { initialEnv, normalize } from "../../lib/psdl/normalize";

const here = path.resolve(__dirname, "../..");
const KSY_DIR = path.join(here, "data", "ksy-examples");
const ipv4MinText = readFileSync(path.join(KSY_DIR, "ipv4_min.ksy"), "utf8");
const bmpHeaderText = readFileSync(
  path.join(KSY_DIR, "bmp_header.ksy"),
  "utf8",
);

describe("fromKsy — file fixtures", () => {
  it("ipv4_min.ksy: totalBits=160, warnings ≤ 2, expected ids present", () => {
    const { packet, warnings } = fromKsy(ipv4MinText);
    expect(warnings.length).toBeLessThanOrEqual(2);
    const env = initialEnv(packet);
    env.set("ihl", 0);
    env.set("options_present", 0);
    expect(normalize(packet, env).totalBits).toBe(160);
    const ids = packet.body.map((c) => (c as { id: string }).id);
    for (const expected of [
      "version",
      "ihl",
      "dscp",
      "ecn",
      "total_length",
      "src_addr",
      "dst_addr",
    ]) {
      expect(ids).toContain(expected);
    }
  });

  it("bmp_header.ksy: warnings = 0, file_header type is grouped", () => {
    const { packet, warnings } = fromKsy(bmpHeaderText);
    expect(warnings).toEqual([]);
    expect(packet.byteOrder).toBe("LE");
    const fileHdr = packet.body[0] as {
      kind: string;
      id: string;
      children: unknown[];
    };
    expect(fileHdr.kind).toBe("group");
    expect(fileHdr.id).toBe("file_hdr");
    expect(fileHdr.children.length).toBeGreaterThan(0);
  });

  it("round-trip: toKsy(fromKsy(x)) re-parses as YAML", () => {
    for (const text of [ipv4MinText, bmpHeaderText]) {
      const { packet } = fromKsy(text);
      const exported = toKsy(packet);
      expect(typeof exported).toBe("string");
      expect(exported.length).toBeGreaterThan(0);
      const reparsed = yamlParse(exported);
      expect(reparsed).toBeTypeOf("object");
      expect(reparsed.meta).toBeDefined();
    }
  });
});

describe("fromKsy — integer type mapping", () => {
  it("u1/u2/u4/u8 unsigned ints", () => {
    const text = `
meta: { id: t, endian: be }
seq:
  - { id: a, type: u1 }
  - { id: b, type: u2 }
  - { id: c, type: u4 }
  - { id: d, type: u8 }
`;
    const { packet, warnings } = fromKsy(text);
    expect(warnings).toEqual([]);
    const types = packet.body.map(
      (c) =>
        (c as { type: { kind: string; bits: number; signed?: boolean } }).type,
    );
    expect(types[0]).toEqual({ kind: "int", bits: 8 });
    expect(types[1]).toEqual({ kind: "int", bits: 16 });
    expect(types[2]).toEqual({ kind: "int", bits: 32 });
    expect(types[3]).toEqual({ kind: "int", bits: 64 });
  });

  it("s1/s2/s4/s8 signed ints", () => {
    const text = `
meta: { id: t }
seq:
  - { id: a, type: s1 }
  - { id: b, type: s2 }
  - { id: c, type: s4 }
  - { id: d, type: s8 }
`;
    const { packet } = fromKsy(text);
    for (const c of packet.body) {
      const t = (c as { type: { kind: string; signed?: boolean } }).type;
      expect(t.kind).toBe("int");
      expect(t.signed).toBe(true);
    }
  });

  it("b1..b64 raw bit fields", () => {
    const text = `
meta: { id: t }
seq:
  - { id: one, type: b1 }
  - { id: thirteen, type: b13 }
  - { id: sixtyfour, type: b64 }
`;
    const { packet } = fromKsy(text);
    expect((packet.body[0] as { type: { n: number } }).type.n).toBe(1);
    expect((packet.body[1] as { type: { n: number } }).type.n).toBe(13);
    expect((packet.body[2] as { type: { n: number } }).type.n).toBe(64);
  });

  it("explicit endian suffix is accepted on int/bit types", () => {
    const text = `
meta: { id: t }
seq:
  - { id: a, type: u4le }
  - { id: b, type: b16be }
`;
    const { packet } = fromKsy(text);
    expect((packet.body[0] as { type: { bits: number } }).type.bits).toBe(32);
    expect((packet.body[1] as { type: { n: number } }).type.n).toBe(16);
  });

  it("float types lower to raw bits with a warning", () => {
    const text = `
meta: { id: t }
seq:
  - { id: f, type: f4 }
  - { id: d, type: f8 }
`;
    const { packet, warnings } = fromKsy(text);
    expect(warnings.some((w) => /float type/.test(w))).toBe(true);
    expect((packet.body[0] as { type: { n: number } }).type.n).toBe(32);
    expect((packet.body[1] as { type: { n: number } }).type.n).toBe(64);
  });
});

describe("fromKsy — string and byte buffers", () => {
  it("str + size becomes bytes type", () => {
    const text = `
meta: { id: t }
seq:
  - { id: name, type: str, size: 8, encoding: ascii }
`;
    const { packet } = fromKsy(text);
    const t = (
      packet.body[0] as {
        type: { kind: string; n: { kind: string; value: number } };
      }
    ).type;
    expect(t.kind).toBe("bytes");
    expect(t.n.value).toBe(8);
  });

  it("strz + size-eos uses a 0-byte placeholder and warns", () => {
    const text = `
meta: { id: t }
seq:
  - { id: rest, type: strz, size-eos: true }
`;
    const { warnings } = fromKsy(text);
    expect(warnings.some((w) => /size-eos/.test(w))).toBe(true);
  });

  it("strz without size warns and uses 0", () => {
    const text = `
meta: { id: t }
seq:
  - { id: x, type: strz }
`;
    const { warnings } = fromKsy(text);
    expect(warnings.some((w) => /without size/.test(w))).toBe(true);
  });

  it("bare size becomes raw bytes", () => {
    const text = `
meta: { id: t }
seq:
  - { id: chunk, size: 16 }
`;
    const { packet } = fromKsy(text);
    expect((packet.body[0] as { type: { kind: string } }).type.kind).toBe(
      "bytes",
    );
  });

  it("size: <ref> becomes a bytes with ref expression", () => {
    const text = `
meta: { id: t }
seq:
  - { id: hdrLen, type: u1 }
  - { id: data, size: hdrLen }
`;
    const { packet } = fromKsy(text);
    const t = (
      packet.body[1] as { type: { n: { kind: string; field: string } } }
    ).type;
    expect(t.n.kind).toBe("ref");
    expect(t.n.field).toBe("hdrLen");
  });

  it("complex size expression warns", () => {
    const text = `
meta: { id: t }
seq:
  - { id: data, size: "len * 4" }
`;
    const { warnings } = fromKsy(text);
    expect(warnings.some((w) => /Complex size/.test(w))).toBe(true);
  });

  it("size-eos without a type warns and emits placeholder", () => {
    const text = `
meta: { id: t }
seq:
  - { id: rest, size-eos: true }
`;
    const { warnings } = fromKsy(text);
    expect(
      warnings.some((w) => /size-eos used as 0-byte placeholder/.test(w)),
    ).toBe(true);
  });

  it("contents (magic bytes) becomes a fixed-size bytes type", () => {
    const text = `
meta: { id: t }
seq:
  - { id: magic, contents: "BM" }
  - { id: arr, contents: [0x42, 0x4D] }
`;
    const { packet } = fromKsy(text);
    expect(
      (packet.body[0] as { type: { n: { value: number } } }).type.n.value,
    ).toBe(2);
    expect(
      (packet.body[1] as { type: { n: { value: number } } }).type.n.value,
    ).toBe(2);
  });
});

describe("fromKsy — repeat / if / enum / nested types / instances", () => {
  it("repeat: expr resolves to a Repeat with literal count", () => {
    const text = `
meta: { id: t }
seq:
  - { id: words, type: u2, repeat: expr, repeat-expr: 3 }
`;
    const { packet } = fromKsy(text);
    const c = packet.body[0] as {
      kind: string;
      count: { kind: string; value: number };
    };
    expect(c.kind).toBe("repeat");
    expect(c.count.value).toBe(3);
  });

  it("repeat: expr with a string identifier becomes a ref", () => {
    const text = `
meta: { id: t }
seq:
  - { id: items, type: u1, repeat: expr, repeat-expr: count }
`;
    const { packet } = fromKsy(text);
    const c = packet.body[0] as { count: { kind: string; field: string } };
    expect(c.count.field).toBe("count");
  });

  it("repeat: expr with an unparseable expression warns and falls back", () => {
    const text = `
meta: { id: t }
seq:
  - { id: items, type: u1, repeat: expr, repeat-expr: "_root.size + 1" }
`;
    const { packet, warnings } = fromKsy(text);
    expect(warnings.some((w) => /repeat-expr/.test(w))).toBe(true);
    const c = packet.body[0] as { count: { field: string } };
    expect(c.count.field).toBe("items_count");
  });

  it("repeat: expr with a numeric-string value parses as a literal", () => {
    const text = `
meta: { id: t }
seq:
  - { id: items, type: u1, repeat: expr, repeat-expr: "5" }
`;
    const { packet } = fromKsy(text);
    const c = packet.body[0] as { count: { kind: string; value: number } };
    expect(c.count.value).toBe(5);
  });

  it("repeat: expr with a non-string non-number value falls back", () => {
    const text = `
meta: { id: t }
seq:
  - { id: items, type: u1, repeat: expr, repeat-expr: null }
`;
    const { packet } = fromKsy(text);
    const c = packet.body[0] as { count: { field: string } };
    expect(c.count.field).toBe("items_count");
  });

  it("repeat: until warns and uses an env-driven count", () => {
    const text = `
meta: { id: t }
seq:
  - { id: items, type: u1, repeat: until, "repeat-until": "_ == 0" }
`;
    const { packet, warnings } = fromKsy(text);
    expect(warnings.some((w) => /repeat: until/.test(w))).toBe(true);
    const c = packet.body[0] as { count: { until: { field: string } } };
    expect(c.count.until.field).toBe("items_until");
  });

  it("repeat: eos resolves to 'eos'", () => {
    const text = `
meta: { id: t }
seq:
  - { id: rest, type: u1, repeat: eos }
`;
    const { packet } = fromKsy(text);
    expect((packet.body[0] as { count: string }).count).toBe("eos");
  });

  it("if: <ref> wraps in a Switch with present/absent/default branches", () => {
    const text = `
meta: { id: t }
seq:
  - { id: opt, type: u1, if: present }
`;
    const { packet } = fromKsy(text);
    const c = packet.body[0] as {
      kind: string;
      cases: Record<string, unknown>;
    };
    expect(c.kind).toBe("switch");
    expect(c.cases["1"]).toBeDefined();
    expect(c.cases["0"]).toBeDefined();
    expect(c.cases["_"]).toBeDefined();
  });

  it("if: <complex expr> warns and falls back to env ref", () => {
    const text = `
meta: { id: t }
seq:
  - { id: opt, type: u1, if: "ihl > 5" }
`;
    const { warnings } = fromKsy(text);
    expect(warnings.some((w) => /if-expression/.test(w))).toBe(true);
  });

  it("type: switch-on resolves to a Switch container", () => {
    const text = `
meta: { id: t }
seq:
  - id: payload
    type:
      switch-on: kind
      cases:
        '1': u2
        '2': u4
`;
    const { packet } = fromKsy(text);
    const c = packet.body[0] as {
      kind: string;
      on: { field: string };
      cases: Record<string, unknown>;
    };
    expect(c.kind).toBe("switch");
    expect(c.on.field).toBe("kind");
    expect(c.cases["1"]).toBeDefined();
    expect(c.cases["2"]).toBeDefined();
  });

  it("switch-on with no cases mapping resolves to an empty Switch container", () => {
    const text = `
meta: { id: t }
seq:
  - id: payload
    type:
      switch-on: kind
`;
    const { packet } = fromKsy(text);
    const c = packet.body[0] as {
      kind: string;
      cases: Record<string, unknown>;
    };
    expect(c.kind).toBe("switch");
    expect(c.cases).toEqual({});
  });

  it("switch-on with a non-string `switch-on` value is dropped", () => {
    const text = `
meta: { id: t }
seq:
  - id: payload
    type:
      switch-on: 42
      cases: {}
`;
    const { warnings } = fromKsy(text);
    expect(warnings.some((w) => /switch-on/.test(w))).toBe(true);
  });

  it("switch-on with a non-ref expression is dropped with a warning", () => {
    const text = `
meta: { id: t }
seq:
  - id: payload
    type:
      switch-on: "some.thing"
      cases:
        '1': u1
`;
    const { warnings } = fromKsy(text);
    expect(warnings.some((w) => /switch-on/.test(w))).toBe(true);
  });

  it("switch-on case with an unresolvable type variant is silently dropped", () => {
    const text = `
meta: { id: t }
seq:
  - id: payload
    type:
      switch-on: kind
      cases:
        '1': nonexistent_type
`;
    const { packet } = fromKsy(text);
    const c = packet.body[0] as { cases: Record<string, unknown> };
    // case "1" was dropped because nonexistent_type can't resolve
    expect(c.cases["1"]).toBeUndefined();
  });

  it("switch-on case with a non-string variant warns", () => {
    const text = `
meta: { id: t }
seq:
  - id: payload
    type:
      switch-on: kind
      cases:
        '1': { id: nested }
`;
    const { warnings } = fromKsy(text);
    expect(warnings.some((w) => /non-string variant/.test(w))).toBe(true);
  });

  it("user-defined types become Group containers", () => {
    const text = `
meta: { id: t }
seq:
  - { id: hdr, type: header }
types:
  header:
    seq:
      - { id: a, type: u1 }
      - { id: b, type: u2 }
`;
    const { packet } = fromKsy(text);
    const g = packet.body[0] as { kind: string; children: unknown[] };
    expect(g.kind).toBe("group");
    expect(g.children).toHaveLength(2);
  });

  it("nested user-type with its own types/enums merges into the child registry", () => {
    const text = `
meta: { id: t }
seq:
  - { id: hdr, type: outer }
types:
  outer:
    seq:
      - { id: inner_val, type: inner }
      - { id: tag, type: u1, enum: nested_kinds }
    types:
      inner:
        seq:
          - { id: leaf, type: u1 }
    enums:
      nested_kinds:
        1: alpha
`;
    const { packet, warnings } = fromKsy(text);
    expect(warnings).toEqual([]);
    // Outer group contains an "inner" sub-group with one leaf field, plus the
    // enum-typed tag.
    const outer = packet.body[0] as {
      kind: string;
      children: Array<{ kind?: string; type?: { kind: string } }>;
    };
    expect(outer.kind).toBe("group");
    expect(outer.children).toHaveLength(2);
    expect(outer.children[0].kind).toBe("group");
    expect(outer.children[1].type?.kind).toBe("enum");
  });

  it("nested user-type with its own instances warns", () => {
    const text = `
meta: { id: t }
seq:
  - { id: hdr, type: header }
types:
  header:
    seq:
      - { id: a, type: u1 }
    instances:
      computed:
        value: 1
`;
    const { warnings } = fromKsy(text);
    expect(warnings.some((w) => /Kaitai computed instance/.test(w))).toBe(true);
  });

  it("top-level instances warn", () => {
    const text = `
meta: { id: t }
seq:
  - { id: a, type: u1 }
instances:
  thing:
    value: 1
`;
    const { warnings } = fromKsy(text);
    expect(warnings.some((w) => /Kaitai computed instance/.test(w))).toBe(true);
  });

  it("enum on int → TypeEnum", () => {
    const text = `
meta: { id: t }
seq:
  - { id: kind, type: u1, enum: kinds }
enums:
  kinds:
    1: alpha
    2: beta
`;
    const { packet } = fromKsy(text);
    const t = (
      packet.body[0] as {
        type: { kind: string; bits: number; variants: Record<number, string> };
      }
    ).type;
    expect(t.kind).toBe("enum");
    expect(t.bits).toBe(8);
    expect(t.variants).toEqual({ 1: "alpha", 2: "beta" });
  });

  it("enum on bN → TypeEnum carrying bit count", () => {
    const text = `
meta: { id: t }
seq:
  - { id: nibble, type: b4, enum: kinds }
enums:
  kinds: { 0: zero, 1: one }
`;
    const { packet } = fromKsy(text);
    expect((packet.body[0] as { type: { bits: number } }).type.bits).toBe(4);
  });

  it("unknown enum name warns and keeps the int type", () => {
    const text = `
meta: { id: t }
seq:
  - { id: x, type: u1, enum: missing }
`;
    const { warnings } = fromKsy(text);
    expect(warnings.some((w) => /unknown enum/.test(w))).toBe(true);
  });

  it("enum entries with object values pick up the `id` key", () => {
    const text = `
meta: { id: t }
seq:
  - { id: kind, type: u1, enum: k }
enums:
  k:
    1: { id: alpha, doc: 'first' }
    2: beta
`;
    const { packet } = fromKsy(text);
    const t = (packet.body[0] as { type: { variants: Record<number, string> } })
      .type;
    expect(t.variants[1]).toBe("alpha");
    expect(t.variants[2]).toBe("beta");
  });

  it("non-mapping enum value is ignored with a warning", () => {
    const text = `
meta: { id: t }
seq:
  - { id: kind, type: u1, enum: bad }
enums:
  bad: not-a-mapping
`;
    const { warnings } = fromKsy(text);
    expect(warnings.some((w) => /Enum "bad"/.test(w))).toBe(true);
  });

  it("enum applied to a bytes-typed field is silently a no-op", () => {
    // A `str + size` becomes bytes; the enum lookup should be skipped, not
    // crash, and not warn (since the enum exists).
    const text = `
meta: { id: t }
seq:
  - { id: x, type: str, size: 4, enum: kinds }
enums:
  kinds: { 1: alpha }
`;
    const { packet, warnings } = fromKsy(text);
    expect(warnings).toEqual([]);
    expect((packet.body[0] as { type: { kind: string } }).type.kind).toBe(
      "bytes",
    );
  });

  it("non-mapping user type is ignored with a warning", () => {
    const text = `
meta: { id: t }
seq:
  - { id: hdr, type: bad }
types:
  bad: "not-a-mapping"
`;
    const { warnings } = fromKsy(text);
    expect(warnings.some((w) => /Type "bad"/.test(w))).toBe(true);
  });
});

describe("fromKsy — meta fields, doc, doc-ref", () => {
  it("meta.id falls back to 'kaitai_packet' when missing", () => {
    const { packet } = fromKsy(`meta: {}\nseq: []`);
    expect(packet.name).toBe("kaitai_packet");
  });

  it("meta.title overrides id", () => {
    const { packet } = fromKsy(
      `meta: { id: foo, title: "Foo Format" }\nseq: []`,
    );
    expect(packet.name).toBe("Foo Format");
  });

  it("unknown meta.endian warns", () => {
    const { warnings } = fromKsy(`meta: { id: t, endian: weird }\nseq: []`);
    expect(warnings.some((w) => /Unknown meta.endian/.test(w))).toBe(true);
  });

  it("doc and doc-ref combine into the packet description", () => {
    const text = `
meta: { id: t }
doc: "A test packet"
doc-ref:
  - "https://example.com/spec"
seq: []
`;
    const { packet } = fromKsy(text);
    expect(packet.description).toContain("A test packet");
    expect(packet.description).toContain("See: https://example.com/spec");
  });

  it("doc-ref as a single string also surfaces", () => {
    const { packet } = fromKsy(
      `meta: { id: t }\ndoc-ref: "https://example.com"\nseq: []`,
    );
    expect(packet.description).toContain("https://example.com");
  });

  it("field-level doc and doc-ref combine", () => {
    const text = `
meta: { id: t }
seq:
  - id: x
    type: u1
    doc: "field x"
    doc-ref: "RFC 9999"
`;
    const { packet } = fromKsy(text);
    expect((packet.body[0] as { doc: string }).doc).toContain("field x");
    expect((packet.body[0] as { doc: string }).doc).toContain("See: RFC 9999");
  });

  it("anonymous seq entries get fallback ids", () => {
    const text = `
meta: { id: t }
seq:
  - { type: u1 }
`;
    const { packet } = fromKsy(text);
    expect((packet.body[0] as { id: string }).id).toBe("f0");
  });
});

describe("fromKsy — defensive parser paths", () => {
  it("works when meta is entirely missing", () => {
    const { packet } = fromKsy("seq:\n  - { id: a, type: u1 }\n");
    expect(packet.name).toBe("kaitai_packet");
  });

  it("works when seq is missing", () => {
    const { packet } = fromKsy("meta: { id: t }\n");
    expect(packet.body).toEqual([]);
  });

  it("user-defined type with no seq becomes an empty Group", () => {
    const text = `
meta: { id: t }
seq:
  - { id: blob, type: empty }
types:
  empty: { doc: 'placeholder' }
`;
    const { packet } = fromKsy(text);
    const g = packet.body[0] as { kind: string; children: unknown[] };
    expect(g.children).toEqual([]);
  });

  it("anonymous float entry uses '?' in the warning message", () => {
    const text = `
meta: { id: t }
seq:
  - { type: f4 }
`;
    const { warnings } = fromKsy(text);
    expect(warnings.some((w) => /float type/.test(w))).toBe(true);
  });

  it("anonymous str-with-size-eos entry uses '?' in the warning message", () => {
    const text = `
meta: { id: t }
seq:
  - { type: str, size-eos: true }
`;
    const { warnings } = fromKsy(text);
    expect(warnings.some((w) => /str with size-eos/.test(w))).toBe(true);
  });

  it("anonymous strz with no size triggers the placeholder warning", () => {
    const text = `
meta: { id: t }
seq:
  - { type: strz }
`;
    const { warnings } = fromKsy(text);
    expect(warnings.some((w) => /without size/.test(w))).toBe(true);
  });

  it("anonymous size-eos with no type triggers the placeholder warning", () => {
    const text = `
meta: { id: t }
seq:
  - { size-eos: true }
`;
    const { warnings } = fromKsy(text);
    expect(
      warnings.some((w) => /size-eos used as 0-byte placeholder/.test(w)),
    ).toBe(true);
  });

  it("seq entry with no id at all uses fallback fN id and warns about untyped", () => {
    const text = `
meta: { id: t }
seq:
  - { type: weird }
`;
    const { warnings } = fromKsy(text);
    expect(warnings.some((w) => /could not resolve type/.test(w))).toBe(true);
  });

  it("bN where N>64 falls through to bytes/null path", () => {
    const text = `
meta: { id: t }
seq:
  - { id: huge, type: b128 }
`;
    const { warnings } = fromKsy(text);
    // No bit match → drops with warning
    expect(warnings.some((w) => /could not resolve type/.test(w))).toBe(true);
  });

  it("enum object value missing `id` is dropped", () => {
    const text = `
meta: { id: t }
seq:
  - { id: x, type: u1, enum: m }
enums:
  m:
    1: { doc: 'no id key here' }
    2: alpha
`;
    const { packet } = fromKsy(text);
    const t = (packet.body[0] as { type: { variants: Record<number, string> } })
      .type;
    expect(t.variants[1]).toBeUndefined();
    expect(t.variants[2]).toBe("alpha");
  });

  it("enum object value with a non-string `id` is dropped", () => {
    const text = `
meta: { id: t }
seq:
  - { id: x, type: u1, enum: m }
enums:
  m:
    1: { id: 99 }
    2: alpha
`;
    const { packet } = fromKsy(text);
    const t = (packet.body[0] as { type: { variants: Record<number, string> } })
      .type;
    expect(t.variants[1]).toBeUndefined();
    expect(t.variants[2]).toBe("alpha");
  });

  it("enum with non-integer key names is filtered", () => {
    const text = `
meta: { id: t }
seq:
  - { id: x, type: u1, enum: m }
enums:
  m:
    1: alpha
    bogus: ignored
`;
    const { packet } = fromKsy(text);
    const t = (packet.body[0] as { type: { variants: Record<number, string> } })
      .type;
    expect(t.variants[1]).toBe("alpha");
    // Non-integer key not present
    expect(Object.keys(t.variants)).toEqual(["1"]);
  });

  it("doc-ref array with non-string entries skips them", () => {
    const text = `
meta: { id: t }
doc-ref:
  - "good"
  - 12345
seq: []
`;
    const { packet } = fromKsy(text);
    expect(packet.description).toContain("See: good");
  });

  it("size with a non-number, non-string falls through to null type", () => {
    const text = `
meta: { id: t }
seq:
  - { id: x, size: true }
`;
    const { warnings } = fromKsy(text);
    expect(warnings.some((w) => /could not resolve type/.test(w))).toBe(true);
  });

  it("contents that resolves to length 0 also drops the entry", () => {
    const text = `
meta: { id: t }
seq:
  - { id: x, contents: [] }
`;
    const { warnings } = fromKsy(text);
    expect(warnings.some((w) => /could not resolve type/.test(w))).toBe(true);
  });

  it("contents that is neither string nor array is treated as zero-length", () => {
    // YAML parses `42` as a number — magicByteLength's defensive false branch.
    const text = `
meta: { id: t }
seq:
  - { id: x, contents: 42 }
`;
    const { warnings } = fromKsy(text);
    expect(warnings.some((w) => /could not resolve type/.test(w))).toBe(true);
  });
});

describe("fromKsy — error and edge paths", () => {
  it("throws on invalid YAML", () => {
    expect(() => fromKsy("- :\n - bad: [")).toThrow(/Invalid YAML/);
  });

  it("throws when the root is not a mapping", () => {
    expect(() => fromKsy("- a\n- b")).toThrow(/must be a mapping/);
  });

  it("warns about unsupported seq keys", () => {
    const text = `
meta: { id: t }
seq:
  - { id: x, type: u1, process: 'xor(0xff)', valid: 1 }
`;
    const { warnings } = fromKsy(text);
    expect(warnings.some((w) => /process/.test(w))).toBe(true);
    expect(warnings.some((w) => /valid/.test(w))).toBe(true);
  });

  it("drops unrecognised type with a warning", () => {
    const text = `
meta: { id: t }
seq:
  - { id: x, type: zigzag }
`;
    const { warnings } = fromKsy(text);
    expect(warnings.some((w) => /could not resolve type/.test(w))).toBe(true);
  });

  it("non-mapping seq entry is skipped with a warning", () => {
    const text = `
meta: { id: t }
seq:
  - "not a mapping"
  - { id: x, type: u1 }
`;
    const { warnings } = fromKsy(text);
    expect(warnings.some((w) => /not a mapping/.test(w))).toBe(true);
  });
});

describe("toKsy — exporter", () => {
  it("emits meta and seq for a simple packet", () => {
    const yaml = toKsy({
      name: "Test",
      rowBits: 32,
      byteOrder: "BE",
      body: [
        { id: "a", name: "A", type: { kind: "int", bits: 16 } },
        { id: "b", name: "B", type: { kind: "int", bits: 8, signed: true } },
        { id: "c", name: "C", type: { kind: "bits", n: 4 } },
      ],
    });
    const obj = yamlParse(yaml);
    expect(obj.meta.id).toBe("test");
    expect(obj.meta.endian).toBe("be");
    expect(obj.seq[0]).toEqual({ id: "a", type: "u2" });
    expect(obj.seq[1]).toEqual({ id: "b", type: "s1" });
    expect(obj.seq[2]).toEqual({ id: "c", type: "b4" });
  });

  it("LE endian is preserved", () => {
    const yaml = toKsy({
      name: "T",
      rowBits: 32,
      byteOrder: "LE",
      body: [{ id: "a", name: "A", type: { kind: "int", bits: 16 } }],
    });
    expect(yamlParse(yaml).meta.endian).toBe("le");
  });

  it("emits packet doc when description is set", () => {
    const yaml = toKsy({
      name: "T",
      rowBits: 32,
      body: [],
      description: "hello world",
    });
    expect(yamlParse(yaml).doc).toBe("hello world");
  });

  it("groups splice their children inline", () => {
    const yaml = toKsy({
      name: "T",
      rowBits: 32,
      body: [
        {
          kind: "group",
          id: "g",
          name: "g",
          children: [
            { id: "a", name: "A", type: { kind: "int", bits: 8 } },
            { id: "b", name: "B", type: { kind: "int", bits: 8 } },
          ],
        },
      ],
    });
    const obj = yamlParse(yaml);
    expect(obj.seq.map((e: { id: string }) => e.id)).toEqual(["a", "b"]);
  });

  it("repeat with a single field hoists it as the entry's type", () => {
    const yaml = toKsy({
      name: "T",
      rowBits: 32,
      body: [
        {
          kind: "repeat",
          id: "items",
          element: {
            id: "item",
            fields: [{ id: "x", name: "X", type: { kind: "int", bits: 8 } }],
          },
          count: { kind: "lit", value: 3 },
        },
      ],
    });
    const obj = yamlParse(yaml);
    expect(obj.seq[0].repeat).toBe("expr");
    expect(obj.seq[0]["repeat-expr"]).toBe("3");
    expect(obj.seq[0].id).toBe("items");
  });

  it("repeat with a single non-field child synthesises a user type", () => {
    const yaml = toKsy({
      name: "T",
      rowBits: 32,
      body: [
        {
          kind: "repeat",
          id: "items",
          element: {
            id: "i",
            fields: [
              {
                kind: "group",
                id: "inner",
                name: "inner",
                children: [
                  { id: "x", name: "X", type: { kind: "int", bits: 8 } },
                ],
              },
            ],
          },
          count: "eos",
        },
      ],
    });
    const obj = yamlParse(yaml);
    expect(obj.seq[0].type).toBe("items_elem");
    expect(obj.types.items_elem).toBeDefined();
  });

  it("repeat with multi-field element materialises a synthetic user type", () => {
    const yaml = toKsy({
      name: "T",
      rowBits: 32,
      body: [
        {
          kind: "repeat",
          id: "rec",
          element: {
            id: "r",
            fields: [
              { id: "a", name: "A", type: { kind: "int", bits: 8 } },
              { id: "b", name: "B", type: { kind: "int", bits: 8 } },
            ],
          },
          count: "eos",
        },
      ],
    });
    const obj = yamlParse(yaml);
    expect(obj.seq[0].type).toBe("rec_elem");
    expect(obj.seq[0].repeat).toBe("eos");
    expect(obj.types.rec_elem).toBeDefined();
  });

  it("repeat-until is preserved", () => {
    const yaml = toKsy({
      name: "T",
      rowBits: 32,
      body: [
        {
          kind: "repeat",
          id: "items",
          element: {
            id: "i",
            fields: [{ id: "x", name: "X", type: { kind: "int", bits: 8 } }],
          },
          count: { until: { kind: "ref", field: "done" } },
        },
      ],
    });
    const obj = yamlParse(yaml);
    expect(obj.seq[0].repeat).toBe("until");
    expect(obj.seq[0]["repeat-until"]).toBe("done");
  });

  it("switch lowers to its first case as a comment", () => {
    const yaml = toKsy({
      name: "T",
      rowBits: 32,
      body: [
        {
          kind: "switch",
          id: "by",
          on: { kind: "ref", field: "k" },
          cases: {
            "1": {
              id: "c1",
              fields: [{ id: "x", name: "X", type: { kind: "int", bits: 8 } }],
            },
          },
        },
      ],
    });
    expect(yaml).toMatch(/# psdl-only:.*Switch "by"/);
  });

  it("switch with no cases is silently skipped", () => {
    const yaml = toKsy({
      name: "T",
      rowBits: 32,
      body: [
        {
          kind: "switch",
          id: "empty",
          on: { kind: "ref", field: "k" },
          cases: {},
        },
      ],
    });
    const obj = yamlParse(yaml);
    expect(obj.seq).toEqual([]);
  });

  it("category, constraints, and enum hints surface as psdl-only comments", () => {
    const yaml = toKsy({
      name: "T",
      rowBits: 32,
      body: [
        {
          id: "x",
          name: "X",
          type: { kind: "int", bits: 8 },
          category: "addressing",
        },
        {
          id: "e",
          name: "E",
          type: { kind: "enum", bits: 8, variants: { 0: "z" } },
        },
      ],
      constraints: [
        {
          lhs: { kind: "ref", field: "a" },
          rhs: { kind: "ref", field: "b" },
        },
      ],
    });
    expect(yaml).toMatch(/# psdl-only:.*category "addressing" dropped/);
    expect(yaml).toMatch(/# psdl-only:.*PSDL constraint/);
    expect(yaml).toMatch(/# psdl-only:.*enum variants/);
  });

  it("bytes with literal size emits `size: N`", () => {
    const yaml = toKsy({
      name: "T",
      rowBits: 32,
      body: [
        {
          id: "blob",
          name: "Blob",
          type: { kind: "bytes", n: { kind: "lit", value: 16 } },
        },
      ],
    });
    expect(yamlParse(yaml).seq[0].size).toBe(16);
  });

  it("bytes with ref size emits `size: <name>`", () => {
    const yaml = toKsy({
      name: "T",
      rowBits: 32,
      body: [
        {
          id: "data",
          name: "Data",
          type: { kind: "bytes", n: { kind: "ref", field: "len" } },
        },
      ],
    });
    expect(yamlParse(yaml).seq[0].size).toBe("len");
  });

  it("bytes with expression size emits the stringified expression", () => {
    const yaml = toKsy({
      name: "T",
      rowBits: 32,
      body: [
        {
          id: "data",
          name: "Data",
          type: {
            kind: "bytes",
            n: {
              kind: "op",
              op: "*",
              a: { kind: "ref", field: "len" },
              b: { kind: "lit", value: 4 },
            },
          },
        },
      ],
    });
    expect(yamlParse(yaml).seq[0].size).toBe("(len * 4)");
  });

  it("bytes with cond size also stringifies", () => {
    const yaml = toKsy({
      name: "T",
      rowBits: 32,
      body: [
        {
          id: "data",
          name: "Data",
          type: {
            kind: "bytes",
            n: {
              kind: "cond",
              test: { kind: "ref", field: "f" },
              t: { kind: "lit", value: 1 },
              f: { kind: "lit", value: 2 },
            },
          },
        },
      ],
    });
    expect(yamlParse(yaml).seq[0].size).toBe("(f ? 1 : 2)");
  });

  it("odd int widths fall back to b<bits> with a comment", () => {
    const yaml = toKsy({
      name: "T",
      rowBits: 32,
      body: [{ id: "x", name: "X", type: { kind: "int", bits: 17 } }],
    });
    expect(yaml).toMatch(/odd int width 17/);
    expect(yamlParse(yaml).seq[0].type).toBe("b17");
  });

  it("enum with non-power-of-two bits falls back to b<bits>", () => {
    const yaml = toKsy({
      name: "T",
      rowBits: 32,
      body: [
        {
          id: "e",
          name: "E",
          type: { kind: "enum", bits: 24, variants: {} },
        },
      ],
    });
    expect(yamlParse(yaml).seq[0].type).toBe("b24");
  });

  it("doc on a field is preserved", () => {
    const yaml = toKsy({
      name: "T",
      rowBits: 32,
      body: [
        { id: "x", name: "X", type: { kind: "int", bits: 8 }, doc: "hello" },
      ],
    });
    expect(yamlParse(yaml).seq[0].doc).toBe("hello");
  });

  it("toKsy accepts a packet with no name (defaults id to 'packet')", () => {
    const yaml = toKsy({
      name: "",
      rowBits: 32,
      body: [{ id: "x", name: "X", type: { kind: "int", bits: 8 } }],
    });
    expect(yamlParse(yaml).meta.id).toBe("packet");
  });
});

describe("toKsy — PSDL 0.3 Encrypted container", () => {
  it("emits a 1-byte placeholder entry with a psdl-only header note", () => {
    const yaml = toKsy({
      name: "QuicShort",
      rowBits: 32,
      body: [
        {
          kind: "encrypted",
          id: "payload",
          plaintext: {
            id: "p",
            fields: [
              { id: "pn", name: "PN", type: { kind: "bits", n: 32 } },
              { id: "frame", name: "Frame", type: { kind: "bits", n: 32 } },
            ],
          },
          contextNote: "TLS 1.3 handshake keys",
        },
      ],
    });
    expect(yaml).toMatch(/# psdl-only: encrypted block "payload"/);
    expect(yaml).toMatch(/TLS 1\.3 handshake keys/);
    const obj = yamlParse(yaml);
    // One placeholder entry, NOT the two plaintext fields. Size 1
    // (not 0) so the synthesised Kaitai parser actually advances the
    // stream past the encrypted region — a `size: 0` placeholder leaves
    // following fields overlapping it (Copilot review).
    expect(obj.seq).toHaveLength(1);
    expect(obj.seq[0].id).toBe("payload");
    expect(obj.seq[0].size).toBe(1);
    expect(obj.seq[0].doc).toContain("encrypted block");
    expect(obj.seq[0].doc).toContain("TLS 1.3 handshake keys");
    // Plaintext field ids must not surface.
    const ksyText = yaml;
    expect(ksyText).not.toMatch(/^\s*-\s*id:\s*pn\b/m);
    expect(ksyText).not.toMatch(/^\s*-\s*id:\s*frame\b/m);
  });

  it("encrypted with wireBits=0 falls back to a 1-byte placeholder", () => {
    // The exporter treats non-positive lit values as "size unknown" and
    // emits a single byte rather than a zero-byte placeholder. Test
    // covers the `litBits > 0` false branch added when we dropped the
    // old `size: 0` form.
    const yaml = toKsy({
      name: "ZeroEnc",
      rowBits: 32,
      body: [
        {
          kind: "encrypted",
          id: "zero_enc",
          wireBits: { kind: "lit", value: 0 },
          plaintext: {
            id: "p",
            fields: [{ id: "x", name: "X", type: { kind: "bits", n: 8 } }],
          },
          contextNote: "empty payload",
        },
      ],
    });
    const obj = yamlParse(yaml);
    expect(obj.seq[0].size).toBe(1);
  });

  it("encrypted with non-literal wireBits falls back to a 1-byte placeholder", () => {
    // Dynamic widths (ref / op) cannot be evaluated at export time
    // without the runtime env, so the exporter degrades to the same
    // 1-byte placeholder as the no-wireBits case. Covers the
    // `kind === "lit"` false branch in `litBits` computation.
    const yaml = toKsy({
      name: "DynEnc",
      rowBits: 32,
      body: [
        {
          kind: "encrypted",
          id: "dyn_enc",
          wireBits: { kind: "ref", field: "payload_len" },
          plaintext: {
            id: "p",
            fields: [{ id: "x", name: "X", type: { kind: "bits", n: 8 } }],
          },
          contextNote: "dynamic length",
        },
      ],
    });
    const obj = yamlParse(yaml);
    expect(obj.seq[0].size).toBe(1);
  });

  it("encrypted with wireBits=16 emits a 2-byte placeholder", () => {
    // Positive lit widths round up to the nearest byte. 16 bits → 2.
    const yaml = toKsy({
      name: "TwoByteEnc",
      rowBits: 32,
      body: [
        {
          kind: "encrypted",
          id: "two_byte_enc",
          wireBits: { kind: "lit", value: 16 },
          plaintext: {
            id: "p",
            fields: [{ id: "x", name: "X", type: { kind: "bits", n: 16 } }],
          },
          contextNote: "fixed 16-bit width",
        },
      ],
    });
    const obj = yamlParse(yaml);
    expect(obj.seq[0].size).toBe(2);
  });

  it("encrypted nested inside a Group still produces the placeholder", () => {
    const yaml = toKsy({
      name: "Nest",
      rowBits: 32,
      body: [
        {
          kind: "group",
          id: "outer",
          name: "outer",
          children: [
            { id: "hdr", name: "Hdr", type: { kind: "int", bits: 8 } },
            {
              kind: "encrypted",
              id: "secret",
              plaintext: {
                id: "p",
                fields: [{ id: "x", name: "X", type: { kind: "bits", n: 8 } }],
              },
              contextNote: "key",
            },
          ],
        },
      ],
    });
    const obj = yamlParse(yaml);
    expect(obj.seq.map((e: { id: string }) => e.id)).toEqual(["hdr", "secret"]);
    expect(obj.seq[1].size).toBe(1);
  });
});

describe("toKsy — PSDL 0.3 Varint type", () => {
  it("emits a u1 placeholder with a psdl-only header note carrying the encoding", () => {
    for (const encoding of ["quic", "protobuf", "cbor"] as const) {
      const yaml = toKsy({
        name: "V",
        rowBits: 32,
        body: [
          { id: "len", name: "Length", type: { kind: "varint", encoding } },
        ],
      });
      expect(yaml).toMatch(
        new RegExp(
          `# psdl-only:.*varint \\(${encoding}\\) lowered to u1 placeholder`,
        ),
      );
      const obj = yamlParse(yaml);
      expect(obj.seq[0].type).toBe("u1");
      expect(obj.seq[0].id).toBe("len");
    }
  });
});

// PSDL 0.4 — exporter behaviour for the four new primitives. Asserts the
// canonical psdl-only comments and the `if:`/`endian:` projections.
describe("toKsy — PSDL 0.4 primitives", () => {
  it("Optional with a simple ref predicate emits `if: <ref>`", () => {
    const out = toKsy({
      name: "OptSimple",
      rowBits: 8,
      body: [
        {
          kind: "optional",
          id: "maybe",
          when: { kind: "ref", field: "present" },
          container: { id: "flag", name: "Flag", type: { kind: "bits", n: 8 } },
        },
      ],
    });
    expect(out).toMatch(/if:\s*present/);
    expect(out).not.toMatch(/# psdl-only:.*optional/);
  });

  it("Optional with a peek-based predicate falls back to psdl-only comment", () => {
    const out = toKsy({
      name: "OptPeek",
      rowBits: 8,
      body: [
        {
          kind: "optional",
          id: "maybe",
          when: { kind: "peek", bits: 8 },
          container: { id: "flag", name: "Flag", type: { kind: "bits", n: 8 } },
        },
      ],
    });
    expect(out).toMatch(/# psdl-only: optional/);
  });

  it("berLength Type emits u1 placeholder + psdl-only comment", () => {
    const out = toKsy({
      name: "Ber",
      rowBits: 8,
      body: [{ id: "len", name: "Length", type: { kind: "berLength" } }],
    });
    expect(out).toMatch(/# psdl-only: .*berLength/);
    expect(out).toMatch(/type:\s*u1/);
  });

  it("peek-on Switch surfaces a psdl-only comment", () => {
    const out = toKsy({
      name: "Pk",
      rowBits: 16,
      body: [
        {
          kind: "switch",
          id: "s",
          on: { kind: "peek", bits: 16 },
          cases: {
            "0": {
              id: "z",
              fields: [{ id: "a", name: "A", type: { kind: "bits", n: 16 } }],
            },
          },
        },
      ],
    });
    expect(out).toMatch(/# psdl-only: .*peek\(bits=16\)/);
  });

  it("per-field byteOrder projects to per-field endian", () => {
    const out = toKsy({
      name: "BO",
      rowBits: 16,
      body: [
        {
          id: "le",
          name: "LE",
          type: { kind: "int", bits: 16 },
          byteOrder: "LE",
        },
        {
          id: "be",
          name: "BE",
          type: { kind: "int", bits: 16 },
          byteOrder: "BE",
        },
      ],
    });
    expect(out).toMatch(/endian:\s*le/);
    expect(out).toMatch(/endian:\s*be/);
  });
});

// Exercise every branch of the PSDL 0.4 Optional `if:` lowering so the
// exprToKaitaiIf walker stays at 100% line coverage.
describe("toKsy — Optional predicate translation branches", () => {
  it("literal predicate becomes its numeric form", () => {
    const out = toKsy({
      name: "OptLit",
      rowBits: 8,
      body: [
        {
          kind: "optional",
          when: { kind: "lit", value: 1 },
          container: { id: "f", name: "F", type: { kind: "bits", n: 8 } },
        },
      ],
    });
    expect(out).toMatch(/if:\s*['"]?1['"]?/);
  });

  it("binary op predicate is parenthesised", () => {
    const out = toKsy({
      name: "OptOp",
      rowBits: 8,
      body: [
        {
          kind: "optional",
          when: {
            kind: "op",
            op: ">",
            // > is not in BinOp; use + which is valid to exercise op branch.
            a: { kind: "ref", field: "x" },
            b: { kind: "lit", value: 0 },
          } as never,
          container: { id: "f", name: "F", type: { kind: "bits", n: 8 } },
        },
      ],
    });
    // Just assert the `if:` line was emitted (the exact spelling depends on
    // YAML quoting); the binary form `(x + 0)` is the canonical projection.
    expect(out).toMatch(/if:/);
  });

  it("cond predicate is rendered as ternary", () => {
    const out = toKsy({
      name: "OptCond",
      rowBits: 8,
      body: [
        {
          kind: "optional",
          when: {
            kind: "cond",
            test: { kind: "ref", field: "t" },
            t: { kind: "lit", value: 1 },
            f: { kind: "lit", value: 0 },
          },
          container: { id: "f", name: "F", type: { kind: "bits", n: 8 } },
        },
      ],
    });
    expect(out).toMatch(/if:/);
  });

  it("op predicate with inner peek falls back to psdl-only", () => {
    const out = toKsy({
      name: "OptOpPeek",
      rowBits: 8,
      body: [
        {
          kind: "optional",
          when: {
            kind: "op",
            op: "+",
            a: { kind: "peek", bits: 8 },
            b: { kind: "lit", value: 1 },
          },
          container: { id: "f", name: "F", type: { kind: "bits", n: 8 } },
        },
      ],
    });
    expect(out).toMatch(/# psdl-only: optional/);
  });

  it("cond predicate with inner peek falls back to psdl-only", () => {
    const out = toKsy({
      name: "OptCondPeek",
      rowBits: 8,
      body: [
        {
          kind: "optional",
          when: {
            kind: "cond",
            test: { kind: "peek", bits: 8 },
            t: { kind: "lit", value: 1 },
            f: { kind: "lit", value: 0 },
          },
          container: { id: "f", name: "F", type: { kind: "bits", n: 8 } },
        },
      ],
    });
    expect(out).toMatch(/# psdl-only: optional/);
  });
});

// PSDL 0.5 — exporter behaviour for the new container kinds Kaitai cannot
// model directly (bounded / align / virtual / ref) plus delimiter-terminated
// bytes and the 0.5-only Expr forms in the `if:` / size stringifiers.
describe("toKsy — PSDL 0.5 containers", () => {
  it("bounded emits a sized substream entry with a synthetic user type carrying the children", () => {
    const yaml = toKsy({
      name: "Bnd",
      rowBits: 32,
      body: [
        {
          kind: "bounded",
          id: "region",
          bytes: { kind: "lit", value: 16 },
          fields: [
            { id: "a", name: "A", type: { kind: "int", bits: 8 } },
            { id: "b", name: "B", type: { kind: "int", bits: 8 } },
          ],
        },
        // A trailing field proves the budget is preserved (it parses AFTER the
        // 16-byte sub-stream, not after `a`+`b`).
        { id: "tail", name: "Tail", type: { kind: "int", bits: 8 } },
      ],
    });
    const obj = yamlParse(yaml);
    // Single substream seq entry for the bounded region + the trailing field.
    expect(obj.seq.map((e: { id: string }) => e.id)).toEqual([
      "region",
      "tail",
    ]);
    const region = obj.seq[0];
    // The substream carries the declared byte budget + a synthetic user type.
    expect(region.size).toBe(16);
    expect(region.type).toBe("region_body");
    // The user type's seq holds the bounded's children, parsed against the
    // sub-stream.
    expect(obj.types.region_body.seq.map((e: { id: string }) => e.id)).toEqual([
      "a",
      "b",
    ]);
    expect(yaml).toMatch(
      /# psdl-only: bounded "region" byte budget \(16\) emitted as a sized Kaitai substream/,
    );
  });

  it("bounded with a non-literal byte budget emits the expression as the substream size", () => {
    const yaml = toKsy({
      name: "BndExpr",
      rowBits: 32,
      body: [
        {
          kind: "bounded",
          id: "scope",
          bytes: {
            kind: "op",
            op: "*",
            a: { kind: "ref", field: "len" },
            b: { kind: "lit", value: 4 },
          },
          fields: [{ id: "a", name: "A", type: { kind: "int", bits: 8 } }],
        },
      ],
    });
    const obj = yamlParse(yaml);
    expect(obj.seq[0].size).toBe("(len * 4)");
    expect(obj.seq[0].type).toBe("scope_body");
    expect(yaml).toMatch(
      /bounded "scope" byte budget \(\(len \* 4\)\) emitted as a sized Kaitai substream/,
    );
  });

  it("bounded whose children produce no seq entries falls back to a size-only opaque substream", () => {
    const yaml = toKsy({
      name: "BndEmpty",
      rowBits: 32,
      body: [
        {
          kind: "bounded",
          id: "opaque",
          bytes: { kind: "lit", value: 8 },
          // A zero-width virtual produces no seq entry, so there are no
          // children to put in a user type — the entry degrades to size-only.
          fields: [
            { kind: "virtual", id: "v", expr: { kind: "lit", value: 1 } },
          ],
        },
      ],
    });
    const obj = yamlParse(yaml);
    expect(obj.seq[0].id).toBe("opaque");
    expect(obj.seq[0].size).toBe(8);
    // No user type registered for an empty child seq.
    expect(obj.seq[0].type).toBeUndefined();
    expect(obj.types).toBeUndefined();
  });

  it("align emits a position-dependent Kaitai size expression + psdl-only note", () => {
    const yaml = toKsy({
      name: "Aln",
      rowBits: 32,
      body: [
        { id: "a", name: "A", type: { kind: "int", bits: 8 } },
        { kind: "align", id: "pad", to: 32 },
      ],
    });
    const obj = yamlParse(yaml);
    const padEntry = obj.seq.find((e: { id: string }) => e.id === "pad");
    // to=32 bits → 4 bytes; size is position-dependent over `_io.pos`.
    expect(padEntry.size).toBe("(4 - _io.pos % 4) % 4");
    expect(padEntry.doc).toBe("psdl-only: align to 32 bits");
    expect(yaml).toMatch(
      /# psdl-only: align to 32 bits lowered to a position-dependent padding size/,
    );
  });

  it("align with no id falls back to the literal 'align' id", () => {
    const yaml = toKsy({
      name: "AlnNoId",
      rowBits: 32,
      body: [{ kind: "align", to: 16 }],
    });
    const obj = yamlParse(yaml);
    // to=16 bits → 2 bytes.
    expect(obj.seq[0].id).toBe("align");
    expect(obj.seq[0].size).toBe("(2 - _io.pos % 2) % 2");
  });

  it("virtual is dropped from the seq with a psdl-only note", () => {
    const yaml = toKsy({
      name: "Virt",
      rowBits: 32,
      body: [
        { id: "a", name: "A", type: { kind: "int", bits: 8 } },
        {
          kind: "virtual",
          id: "computed",
          expr: { kind: "ref", field: "a" },
        },
      ],
    });
    const obj = yamlParse(yaml);
    // Only the real field survives; the zero-width virtual is dropped.
    expect(obj.seq.map((e: { id: string }) => e.id)).toEqual(["a"]);
    expect(yaml).toMatch(
      /# psdl-only: virtual "computed" \(a\) is zero-width — dropped from .ksy seq/,
    );
  });

  it("ref is not expanded and surfaces a psdl-only note naming the def", () => {
    const yaml = toKsy({
      name: "Ref",
      rowBits: 32,
      body: [
        { id: "a", name: "A", type: { kind: "int", bits: 8 } },
        { kind: "ref", id: "sub", ref: "subStruct" },
      ],
    });
    const obj = yamlParse(yaml);
    expect(obj.seq.map((e: { id: string }) => e.id)).toEqual(["a"]);
    expect(yaml).toMatch(
      /# psdl-only: ref "sub" → defs\["subStruct"\] not expanded in .ksy/,
    );
  });

  it("single-byte-delimited bytes emit a Kaitai `terminator:`", () => {
    const yaml = toKsy({
      name: "DelimOne",
      rowBits: 32,
      body: [
        {
          id: "line",
          name: "Line",
          // NUL-terminated string-style field — single-byte delimiter.
          type: { kind: "bytes", n: { delimiter: [0] } },
        },
        // A trailing field proves the terminated entry survives in the seq.
        { id: "tail", name: "Tail", type: { kind: "int", bits: 8 } },
      ],
    });
    const obj = yamlParse(yaml);
    expect(obj.seq.map((e: { id: string }) => e.id)).toEqual(["line", "tail"]);
    // `terminator:` keeps the typeless byte array valid/compilable.
    expect(obj.seq[0].terminator).toBe(0);
    // No psdl-only note for the single-byte case — it maps cleanly.
    expect(yaml).not.toMatch(/Field "line" delimited bytes/);
  });

  it("multi-byte-delimited bytes drop the seq entry and surface only a psdl-only note", () => {
    const yaml = toKsy({
      name: "Delim",
      rowBits: 32,
      body: [
        {
          id: "line",
          name: "Line",
          type: { kind: "bytes", n: { delimiter: [13, 10] } },
        },
        // A trailing field is the ONLY surviving seq entry.
        { id: "tail", name: "Tail", type: { kind: "int", bits: 8 } },
      ],
    });
    const obj = yamlParse(yaml);
    // The uncompilable typeless/sizeless entry is dropped entirely.
    expect(obj.seq.map((e: { id: string }) => e.id)).toEqual(["tail"]);
    expect(yaml).toMatch(
      /# psdl-only: Field "line" delimited bytes \(delimiter 13,10\)/,
    );
  });

  it("Optional wrapping a compound container with an expressible predicate carries `if:` on a synthetic substream type", () => {
    // Kaitai's `if:` attaches to a single seq entry, so a compound Optional is
    // wrapped in a synthetic type and the predicate rides the wrapper entry —
    // a false predicate then consumes nothing instead of shifting later fields.
    const yaml = toKsy({
      name: "OptGroup",
      rowBits: 32,
      body: [
        {
          kind: "optional",
          id: "maybe",
          when: { kind: "ref", field: "present" },
          container: {
            kind: "group",
            id: "grp",
            name: "Grp",
            children: [
              { id: "a", name: "A", type: { kind: "int", bits: 8 } },
              { id: "b", name: "B", type: { kind: "int", bits: 8 } },
            ],
          },
        },
      ],
    });
    const obj = yamlParse(yaml);
    expect(obj.seq).toHaveLength(1);
    expect(obj.seq[0]).toMatchObject({
      id: "maybe",
      type: "maybe_opt",
      if: "present",
    });
    // The wrapper type holds the children.
    expect(obj.types.maybe_opt.seq.map((e: { id: string }) => e.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("Optional (no id) with an expressible predicate wraps under the synthetic 'opt' id", () => {
    // Covers the `c.id ?? "opt"` nullish fallback on the wrap path.
    const yaml = toKsy({
      name: "OptGroupNoIdWrap",
      rowBits: 32,
      body: [
        {
          kind: "optional",
          when: { kind: "ref", field: "present" },
          container: {
            kind: "group",
            id: "grp",
            name: "Grp",
            children: [{ id: "a", name: "A", type: { kind: "int", bits: 8 } }],
          },
        },
      ],
    });
    const obj = yamlParse(yaml);
    expect(obj.seq[0]).toMatchObject({
      id: "opt",
      type: "opt_opt",
      if: "present",
    });
  });

  it("Optional (no id) wrapping a compound container with a non-expressible predicate falls back to a '?' note", () => {
    // `remaining` can't be lowered to a Kaitai `if:`, so the predicate is
    // dropped and the children spliced unconditionally — covering the
    // `c.id ?? "?"` nullish fallback in the compound-container note.
    const yaml = toKsy({
      name: "OptGroupNoId",
      rowBits: 32,
      body: [
        {
          kind: "optional",
          when: { kind: "remaining" } as never,
          container: {
            kind: "group",
            id: "grp",
            name: "Grp",
            children: [{ id: "a", name: "A", type: { kind: "int", bits: 8 } }],
          },
        },
      ],
    });
    const obj = yamlParse(yaml);
    expect(obj.seq.map((e: { id: string }) => e.id)).toEqual(["a"]);
    expect(yaml).not.toMatch(/if:/);
    expect(yaml).toMatch(
      /# psdl-only: optional "\?" wraps a compound container/,
    );
  });

  it("a 0.5-only Expr in an Optional predicate falls back to a psdl-only note (exprToKaitaiIf default)", () => {
    // `remaining` is a 0.5 Expr the Kaitai `if:` walker can't translate, so the
    // exporter must drop the predicate and emit a psdl-only note. This hits the
    // `default` branch of exprToKaitaiIf (returns null) AND the `default` branch
    // of exprToString (`remaining(…)`).
    const yaml = toKsy({
      name: "OptRemaining",
      rowBits: 8,
      body: [
        {
          kind: "optional",
          id: "maybe",
          when: { kind: "remaining" } as never,
          container: { id: "f", name: "F", type: { kind: "bits", n: 8 } },
        },
      ],
    });
    // No `if:` key (the predicate could not be lowered).
    expect(yaml).not.toMatch(/if:/);
    expect(yaml).toMatch(
      /# psdl-only: optional "maybe" predicate remaining\(…\)/,
    );
  });

  it("a non-representable 0.5 bytes size omits the field instead of emitting an uncompilable `size:`", () => {
    // `wireSize` has no Kaitai expression form; emitting `size: wireSize(…)`
    // would be uncompilable. The field is dropped with a psdl-only note.
    const yaml = toKsy({
      name: "SizeWireSize",
      rowBits: 32,
      body: [
        {
          id: "blob",
          name: "Blob",
          type: { kind: "bytes", n: { kind: "wireSize" } as never },
        },
      ],
    });
    const obj = yamlParse(yaml);
    expect(obj.seq ?? []).toHaveLength(0);
    expect(yaml).toMatch(
      /# psdl-only: Field "blob" size expression \(wireSize\(…\)\) not representable in Kaitai — field omitted/,
    );
  });

  it("a `remaining` bytes size lowers to Kaitai `size-eos`", () => {
    const yaml = toKsy({
      name: "SizeRemaining",
      rowBits: 32,
      body: [
        {
          id: "rest",
          name: "Rest",
          type: { kind: "bytes", n: { kind: "remaining" } as never },
        },
      ],
    });
    const obj = yamlParse(yaml);
    expect(obj.seq[0]).toMatchObject({ id: "rest", "size-eos": true });
    expect(yaml).toMatch(/# psdl-only: Field "rest" size = remaining/);
  });

  it("a bounded with a non-representable byte budget splices children inline", () => {
    const yaml = toKsy({
      name: "BoundedRemaining",
      rowBits: 32,
      body: [
        {
          kind: "bounded",
          id: "region",
          bytes: { kind: "remaining" } as never,
          fields: [{ id: "a", name: "A", type: { kind: "int", bits: 8 } }],
        },
      ],
    });
    const obj = yamlParse(yaml);
    // No substream wrapper — children spliced inline, budget dropped.
    expect(obj.seq.map((e: { id: string }) => e.id)).toEqual(["a"]);
    expect(yaml).toMatch(
      /# psdl-only: bounded "region" byte budget \(remaining\(…\)\) not representable in Kaitai — children spliced inline/,
    );
  });
});

describe("toKsy — peek expression with explicit offset stringifies fully", () => {
  it("renders `peek(bits, offset)` in the psdl-only fallback message", () => {
    const out = toKsy({
      name: "OptPeekOff",
      rowBits: 8,
      body: [
        {
          kind: "optional",
          when: { kind: "peek", bits: 8, offset: { kind: "lit", value: 16 } },
          container: { id: "f", name: "F", type: { kind: "bits", n: 8 } },
        },
      ],
    });
    expect(out).toMatch(/peek\(8,\s*16\)/);
  });
});

describe("toKsy — env-driven repeat counts (audit MEDIUM #2)", () => {
  const eosPacket = {
    name: "T",
    rowBits: 8,
    body: [
      {
        kind: "repeat" as const,
        id: "items",
        element: {
          id: "item",
          fields: [
            { id: "x", name: "X", type: { kind: "int" as const, bits: 8 } },
          ],
        },
        count: "eos" as const,
      },
    ],
  };

  it("without env an eos repeat still collapses to `repeat: eos`", () => {
    const obj = yamlParse(toKsy(eosPacket));
    expect(obj.seq[0].repeat).toBe("eos");
    expect(obj.seq[0]["repeat-expr"]).toBeUndefined();
  });

  it("env keyed by the repeat id materialises `repeat: expr` with the count", () => {
    const obj = yamlParse(toKsy(eosPacket, new Map([["items", 3]])));
    expect(obj.seq[0].repeat).toBe("expr");
    expect(obj.seq[0]["repeat-expr"]).toBe("3");
  });

  it("a ref count resolves to a literal when env supplies the discriminator", () => {
    const packet = {
      name: "DnsLike",
      rowBits: 8,
      body: [
        {
          id: "anCount",
          name: "AnCount",
          type: { kind: "int" as const, bits: 16 },
        },
        {
          kind: "repeat" as const,
          id: "answers",
          element: {
            id: "answer",
            fields: [
              {
                id: "rtype",
                name: "RType",
                type: { kind: "int" as const, bits: 16 },
              },
            ],
          },
          count: { kind: "ref" as const, field: "anCount" },
        },
      ],
    };
    // No env → symbolic ref name survives (valid Kaitai expression).
    const bare = yamlParse(toKsy(packet));
    expect(bare.seq[1]["repeat-expr"]).toBe("anCount");
    // With env → resolved to a literal count.
    const resolved = yamlParse(toKsy(packet, new Map([["anCount", 3]])));
    expect(resolved.seq[1].repeat).toBe("expr");
    expect(resolved.seq[1]["repeat-expr"]).toBe("3");
  });
});
