// PSML Augmented ASCII (AAD) importer tests — covers the diagram parser
// (ruler inference, cell width math, row width validation, label
// continuations), the optional where-block, category guessing, and the
// unsupported-construct warning channel.

import { describe, expect, it } from "vitest";
import { fromAad } from "../../lib/formats/aug-ascii";

const IPV4_AAD = `
An IPv4 Header is formatted as follows:

 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|Version|  IHL  |    DSCP   |ECN|         Total Length          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|        Identification         | Flags |      Fragment Offset  |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

where:
  Version (Ver): 4 bits. IP version, always 4 here.
  IHL: 4 bits. Header length in 32-bit words.
  Total Length: 16 bits. Bytes including header and data.
`;

describe("fromAad — synthetic IPv4-shaped diagram", () => {
  it("returns the expected fields, widths, and names", () => {
    const { packet, warnings } = fromAad(IPV4_AAD);
    expect(warnings).toEqual([]);
    expect(packet.name).toBe("IPv4 Header");
    expect(packet.rowBits).toBe(32);
    const widths = packet.body.map((c) => {
      const t = (c as { type: { kind: string; n?: number; bits?: number } }).type;
      return t.kind === "bits" ? t.n : t.bits;
    });
    // Version=4, IHL=4, DSCP=6, ECN=2, TotalLen=16, Ident=16, Flags=7,
    // FragOffset=23 — the parser collapses Fragment Offset's continuation
    // segment back into a single field.
    expect(widths.slice(0, 6)).toEqual([4, 4, 6, 2, 16, 16]);
  });

  it("attaches descriptions from the where: block", () => {
    const { packet } = fromAad(IPV4_AAD);
    const ihl = packet.body.find(
      (c) => (c as { name: string }).name === "IHL",
    ) as { doc?: string };
    expect(ihl?.doc).toMatch(/Header length in 32-bit words/);
    const totalLen = packet.body.find(
      (c) => (c as { name: string }).name === "Total Length",
    ) as { doc?: string };
    expect(totalLen?.doc).toMatch(/Bytes/);
  });

  it("guesses category from common label hints", () => {
    const text = `
A Frame is formatted as follows:

 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|     Source Address            |          Checksum             |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
`;
    const { packet } = fromAad(text);
    const cats = packet.body.map(
      (c) => (c as { category?: string }).category,
    );
    expect(cats).toContain("addressing");
    expect(cats).toContain("checksum");
  });

  it("guesses additional category hints (length/type/flags/reserved)", () => {
    const text = `
Title is formatted as follows:

 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|   Length      |   Opcode      |    Flags      |     Rsvd      |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
`;
    const { packet } = fromAad(text);
    const cats = packet.body.map((c) => (c as { category?: string }).category);
    expect(cats).toEqual(["length", "type", "flags", "reserved"]);
  });
});

describe("fromAad — title detection", () => {
  it("falls back to the first non-numeric line when no 'is formatted as follows' marker", () => {
    const text = `
My Custom Packet:

 0
 0
+-+
|x|
+-+
`;
    const { packet } = fromAad(text);
    expect(packet.name).toBe("My Custom Packet");
  });

  it("uses 'Imported Packet' when no title is detectable above the ruler", () => {
    const text = `
 0
 0
+-+
|x|
+-+
`;
    const { packet } = fromAad(text);
    expect(packet.name).toBe("Imported Packet");
  });
});

describe("fromAad — malformed input", () => {
  it("throws when no diagram separator is present", () => {
    expect(() => fromAad("just some prose, no diagram")).toThrow(
      /Could not find a packet diagram/,
    );
  });

  it("throws when the bit ruler is missing", () => {
    expect(() =>
      fromAad(`
A Thing is formatted as follows:

+-+-+
| | |
+-+-+
`),
    ).toThrow(/bit ruler missing or malformed/);
  });

  it("throws when the bit ruler is present but contains no digit pattern", () => {
    expect(() =>
      fromAad(`
A Thing is formatted as follows:

aaaaaaaa
+-+-+
| | |
+-+-+
`),
    ).toThrow(/bit ruler missing or malformed/);
  });

  it("throws when there are no data rows after the separator", () => {
    expect(() =>
      fromAad(`
A Thing is formatted as follows:

 0
 0
+-+
`),
    ).toThrow(/no data rows/);
  });

  it("throws when row bit width doesn't match the ruler", () => {
    // Ruler claims 4 bits, row only fills 2 → no data rows accepted.
    expect(() =>
      fromAad(`
A Thing is formatted as follows:

 0
 0 1 2 3
+-+-+-+-+
|a|b|
+-+-+-+-+
`),
    ).toThrow(/no data rows|Row width mismatch|Malformed cell/);
  });
});

describe("fromAad — where block", () => {
  it("collects unsupported lines as warnings (constraint syntax doesn't crash)", () => {
    const text = `
Foo is formatted as follows:

 0
 0
+-+
|x|
+-+

where:
  total := length * 8
  Garbage line that is not a metadata entry
`;
    const { warnings } = fromAad(text);
    expect(warnings.some((w) => /Constraint expression/.test(w))).toBe(true);
    expect(warnings.some((w) => /Unrecognised/.test(w))).toBe(true);
  });

  it("ignores TODO/FIXME/### comment lines silently", () => {
    const text = `
Foo is formatted as follows:

 0
 0
+-+
|x|
+-+

where:
  ### a section header
  TODO: improve this
  FIXME: something
`;
    const { warnings } = fromAad(text);
    expect(warnings).toEqual([]);
  });

  it("accepts where entries that omit the description text", () => {
    const text = `
T is formatted as follows:

 0
 0 1 2 3 4 5 6 7
+-+-+-+-+-+-+-+-+
|     Big       |
+-+-+-+-+-+-+-+-+

where:
  Big: 8 bits.
`;
    const { packet } = fromAad(text);
    // The Where entry has no description — field doc should be absent.
    expect((packet.body[0] as { doc?: string }).doc).toBeUndefined();
  });

  it("matches a where entry by short alias", () => {
    const text = `
Foo is formatted as follows:

 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|     Source Address            |          Checksum             |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

where:
  Source Address (Source Address): 16 bits. Where the packet came from.
  Checksum (chk): 16 bits. The csum.
`;
    const { packet } = fromAad(text);
    const fields = packet.body as Array<{ name: string; doc?: string }>;
    expect(fields.find((f) => f.name === "Source Address")?.doc).toMatch(/came from/);
    // 'chk' alias should match Checksum
    expect(fields.find((f) => f.name === "Checksum")?.doc).toMatch(/csum/);
  });
});

describe("fromAad — diagram scan break paths", () => {
  it("stops the row scan when the next separator is missing", () => {
    // No closing separator after the data row — scanner sees row, then EOL,
    // and the broken-isSeparator check fires.
    const text = `
T is formatted as follows:

 0
 0 1 2 3
+-+-+-+-+
|A|B|C|D|
no closing separator here
trailing line
`;
    const { packet } = fromAad(text);
    expect(packet.body).toHaveLength(4);
  });

  it("stops the row scan when the data line is malformed", () => {
    const text = `
T is formatted as follows:

 0
 0 1 2 3
+-+-+-+-+
|A|B|C|D|
+-+-+-+-+
not-a-row-of-the-right-shape
+-+-+-+-+
`;
    const { packet } = fromAad(text);
    expect(packet.body).toHaveLength(4);
  });
});

describe("fromAad — cell continuation merging", () => {
  it("merges adjacent cells that repeat the same label", () => {
    // 16-bit row split as 4/4/8 — same "Lo" label twice to force a merge.
    const text = `
T is formatted as follows:

 0
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  Lo   |  Lo   |     Tail      |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
`;
    const { packet } = fromAad(text);
    const widths = packet.body.map((c) => {
      const t = (c as { type: { kind: string; n?: number } }).type;
      return t.kind === "bits" ? t.n : 0;
    });
    expect(widths).toEqual([8, 8]);
  });

  it("merges blank continuation cells into the previous field", () => {
    // 16-bit row, 4/4/8 split with the middle cell blank → merges into Big.
    const text = `
T is formatted as follows:

 0
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  Big  |       |     Tail      |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
`;
    const { packet } = fromAad(text);
    expect(packet.body).toHaveLength(2);
    const first = packet.body[0] as { type: { kind: string; n?: number } };
    expect(first.type.kind).toBe("bits");
    expect(first.type.n).toBe(8);
  });
});

describe("fromAad — id derivation", () => {
  it("normalises labels into snake_case ids", () => {
    const text = `
T is formatted as follows:

 0
 0 1 2 3 4 5 6 7
+-+-+-+-+-+-+-+-+
|  Field A!     |
+-+-+-+-+-+-+-+-+
`;
    const { packet } = fromAad(text);
    expect((packet.body[0] as { id: string }).id).toBe("field_a");
  });

  it("falls back to fieldN when the label is empty", () => {
    const text = `
T is formatted as follows:

 0
 0 1 2 3 4 5 6 7
+-+-+-+-+-+-+-+-+
|               |
+-+-+-+-+-+-+-+-+
`;
    const { packet } = fromAad(text);
    expect((packet.body[0] as { id: string }).id).toMatch(/^field/);
  });

  it("falls back to fieldN when the label contains only punctuation", () => {
    const text = `
T is formatted as follows:

 0
 0 1 2 3 4 5 6 7
+-+-+-+-+-+-+-+-+
|     -+-+!     |
+-+-+-+-+-+-+-+-+
`;
    const { packet } = fromAad(text);
    expect((packet.body[0] as { id: string }).id).toMatch(/^field/);
  });
});
