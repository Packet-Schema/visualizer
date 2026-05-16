// PSML RFC-style ASCII exporter — well-formedness across every preset, the
// canonical IPv4 inline snapshot, the trailing-partial-row Ethernet
// regression, and label-truncation behaviour for the field-line printer.

import { describe, expect, it } from "vitest";
import { toAscii } from "../../lib/formats/rfc-ascii";
import { initialEnv, normalize } from "../../lib/psml/normalize";
import { GENERATED_PRESETS } from "../../lib/psml/presets.generated";
import { MANUAL_PRESETS } from "../../lib/psml/presets";
import type { Encrypted, Expr, Packet, PacketEnv } from "../../lib/psml/types";

const ALL_PRESETS: Record<string, Packet> = {
  ...MANUAL_PRESETS,
  ...GENERATED_PRESETS,
};

function envWithRefs(p: Packet): PacketEnv {
  const env = initialEnv(p);
  // Seed every referenced field to 0 so every Repeat/Switch resolves.
  const visit = (e: Expr) => {
    if (e.kind === "ref" && !env.has(e.field)) env.set(e.field, 0);
    if (e.kind === "op") {
      visit(e.a);
      visit(e.b);
    }
    if (e.kind === "cond") {
      visit(e.test);
      visit(e.t);
      visit(e.f);
    }
  };
  type AnyNode = {
    kind?: string;
    type?: { kind: string; n?: Expr };
    element?: { fields: AnyNode[] };
    children?: AnyNode[];
    cases?: Record<string, { fields: AnyNode[] }>;
    default?: { fields: AnyNode[] };
    on?: Expr;
    count?: Expr | string | { until: Expr };
  };
  const walk = (containers: AnyNode[]) => {
    for (const c of containers) {
      if (!c.kind || c.kind === "field") {
        if (c.type?.kind === "bytes" && c.type.n) visit(c.type.n);
        continue;
      }
      if (c.kind === "group" && c.children) walk(c.children);
      if (c.kind === "switch") {
        if (c.on) visit(c.on);
        for (const v of Object.values(c.cases ?? {})) walk(v.fields);
        if (c.default) walk(c.default.fields);
      }
      if (c.kind === "repeat") {
        if (c.count && typeof c.count === "object" && "kind" in c.count) {
          visit(c.count as Expr);
        }
        if (c.element) walk(c.element.fields);
      }
    }
  };
  walk(p.body as AnyNode[]);
  return env;
}

describe("toAscii — every preset is well-formed", () => {
  for (const [key, pkt] of Object.entries(ALL_PRESETS)) {
    it(`${key}: ruler width matches rowBits, every field-line ends with "|"`, () => {
      const env = envWithRefs(pkt);
      const text = toAscii(pkt, env);
      const lines = text.split("\n");
      // headerLine2 (per-bit ruler) is " 0 1 2 ..." — width = 2*rowBits.
      const sepWidth = 1 + 2 * pkt.rowBits;
      const ruler = lines[1];
      expect(ruler.length).toBe(2 * pkt.rowBits);
      // headerLine1 (group labels) has trailing whitespace stripped.
      expect(lines[0].length).toBeLessThanOrEqual(sepWidth);
      expect(lines[2]).toBe("+" + "-+".repeat(pkt.rowBits));
      // Every odd-numbered line at index >= 3 (field lines) ends with "|".
      for (let i = 3; i < lines.length; i += 2) {
        expect(lines[i].endsWith("|"), `field line ${i}: "${lines[i]}"`).toBe(true);
      }
    });
  }
});

describe("toAscii — canonical IPv4 snapshot", () => {
  it("emits the canonical IPv4 diagram for default IHL", () => {
    const env = envWithRefs(MANUAL_PRESETS.ipv4);
    const text = toAscii(MANUAL_PRESETS.ipv4, env);
    expect(text).toBe(
      [
        " 0               1               2               3",
        " 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1",
        "+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+",
        "|Version|  IHL  |   DSCP    |ECN|         Total Length          |",
        "+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+",
        "|        Identification         |R|D|M|     Fragment Offset     |",
        "+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+",
        "|      TTL      |   Protocol    |        Header Checksum        |",
        "+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+",
        "|                        Source Address                         |",
        "+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+",
        "|                      Destination Address                      |",
        "+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+",
      ].join("\n"),
    );
  });
});

describe("toAscii — Ethernet trailing partial row", () => {
  it("final separator width matches the EtherType row (16 bits, not 32)", () => {
    const text = toAscii(MANUAL_PRESETS.ethernet, envWithRefs(MANUAL_PRESETS.ethernet));
    const lines = text.split("\n");
    // Last separator line spans only the EtherType row.
    const last = lines[lines.length - 1];
    expect(last).toBe("+" + "-+".repeat(16));
    // The row above it is the EtherType field line — same length.
    const fieldLine = lines[lines.length - 2];
    expect(fieldLine.length).toBe(last.length);
    expect(fieldLine).toContain("EtherType");
  });
});

describe("toAscii — subfield expansion", () => {
  it("flag subfields appear when the preset uses a Group of 1-bit fields", () => {
    const text = toAscii(MANUAL_PRESETS.ipv4, envWithRefs(MANUAL_PRESETS.ipv4));
    // The IPv4 flagsBits group expands into R/DF/MF — abbreviated to single
    // letters by the truncating label printer.
    expect(text).toMatch(/\|R\|D\|M\|/);
  });
});

describe("toAscii — label truncation", () => {
  it("truncates labels longer than the cell width with a trailing dot", () => {
    const pkt: Packet = {
      name: "Tiny",
      rowBits: 8,
      body: [
        {
          id: "wide",
          name: "ThisLabelIsTooWide",
          type: { kind: "bits", n: 4 },
        },
        { id: "rest", name: "X", type: { kind: "bits", n: 4 } },
      ],
    };
    const text = toAscii(pkt);
    // First cell is 4 bits → cell width 7 chars; label gets truncated with "."
    expect(text).toMatch(/\|ThisLa\.\|/);
  });

  it("renders a 1-bit cell with a single character label", () => {
    const pkt: Packet = {
      name: "Bits",
      rowBits: 8,
      body: [
        ...Array.from({ length: 8 }, (_, i) => ({
          id: `b${i}`,
          name: `${i}`,
          type: { kind: "bits" as const, n: 1 },
        })),
      ],
    };
    const text = toAscii(pkt);
    const fieldLine = text.split("\n")[3];
    expect(fieldLine).toBe("|0|1|2|3|4|5|6|7|");
  });
});

describe("toAscii — UDP layout (sanity)", () => {
  it("UDP fields use the right widths", () => {
    const text = toAscii(MANUAL_PRESETS.udp, envWithRefs(MANUAL_PRESETS.udp));
    expect(text).toContain("Source Port");
    expect(text).toContain("Destination Port");
    expect(text).toContain("Length");
    expect(text).toContain("Checksum");
    // Only 64 bits → 4 lines after header.
    const lines = text.split("\n");
    // 3 header lines + 2 field lines + 2 separators = 7 lines (each row = 2)
    expect(lines.length).toBe(3 + 4);
  });
});

describe("toAscii — PSML 0.3 Encrypted container", () => {
  const enc: Encrypted = {
    kind: "encrypted",
    id: "enc",
    name: "Protected Payload",
    plaintext: {
      id: "p",
      fields: [
        { id: "pn", name: "Packet Number", type: { kind: "bits", n: 32 } },
        { id: "body", name: "Body", type: { kind: "bits", n: 32 } },
      ],
    },
    wireBits: { kind: "lit", value: 64 },
    contextNote: "TLS 1.3 keys",
    headerProtected: ["pn"],
  };
  const pkt: Packet = { name: "Q", rowBits: 32, body: [enc] };

  it("wire mode (default): renders a single ~Encrypted Payload~ row of wireBits width", () => {
    const text = toAscii(pkt);
    // The cell name should be the dedicated marker, NOT the user-set name.
    expect(text).toContain("~Encrypte");
    expect(text).not.toContain("Protected Payload");
    // The plaintext field labels must not appear in wire mode.
    expect(text).not.toContain("Packet Number");
    // No `>>>` indent in wire mode.
    expect(text).not.toMatch(/^>>> /m);
  });

  it("semantic mode: expands plaintext fields and prefixes them with >>>", () => {
    const text = toAscii(pkt, undefined, { viewMode: "semantic" });
    expect(text).toContain("Packet Number");
    expect(text).toContain("Body");
    // Each plaintext row should be indented with the semantic marker.
    const lines = text.split("\n");
    const fieldLines = lines.filter((l) => l.includes("|"));
    expect(fieldLines.some((l) => l.startsWith(">>> "))).toBe(true);
    // Wire-mode marker is NOT present in semantic.
    expect(text).not.toContain("~Encrypte");
  });

  it("wire-mode and semantic-mode outputs differ for a packet with an encrypted block", () => {
    const wire = toAscii(pkt);
    const semantic = toAscii(pkt, undefined, { viewMode: "semantic" });
    expect(wire).not.toBe(semantic);
  });

  it("wireBits absent: falls back to summing plaintext bits", () => {
    const enc2: Encrypted = { ...enc, wireBits: undefined };
    const pkt2: Packet = { name: "Q2", rowBits: 32, body: [enc2] };
    const text = toAscii(pkt2);
    // 32 + 32 = 64 bits → 2 rows. Header is 3 lines; each row adds 2 lines.
    expect(text.split("\n").length).toBe(3 + 4);
  });
});

describe("toAscii — PSML 0.3 Varint type", () => {
  it("auto-seeds worst-case width (64 bits for QUIC) when env omits it", () => {
    const pkt: Packet = {
      name: "V",
      rowBits: 32,
      body: [
        { id: "vlen", name: "VLen", type: { kind: "varint", encoding: "quic" } },
      ],
    };
    const text = toAscii(pkt);
    // 64 bits → 2 full 32-bit rows. Header trio + 4 lines for two rows.
    const lines = text.split("\n");
    expect(lines.length).toBe(3 + 4);
    // The field name should be annotated with the (varint) marker.
    expect(text).toContain("varint");
  });

  it("worst-case widths differ by encoding: protobuf=80, cbor=72, quic=64", () => {
    const pkt = (encoding: "quic" | "protobuf" | "cbor"): Packet => ({
      name: "V",
      rowBits: 8,
      body: [{ id: "v", name: "V", type: { kind: "varint", encoding } }],
    });
    // Each row covers 8 bits → row count = bits / 8.
    const rowsOf = (text: string) =>
      text.split("\n").slice(3).filter((_, i) => i % 2 === 0).length;
    expect(rowsOf(toAscii(pkt("quic")))).toBe(64 / 8);
    expect(rowsOf(toAscii(pkt("protobuf")))).toBe(80 / 8);
    expect(rowsOf(toAscii(pkt("cbor")))).toBe(72 / 8);
  });

  it("env override wins over worst-case fallback", () => {
    const pkt: Packet = {
      name: "V",
      rowBits: 8,
      body: [{ id: "v", name: "V", type: { kind: "varint", encoding: "quic" } }],
    };
    const env: PacketEnv = new Map([["v", 16]]);
    const text = toAscii(pkt, env);
    // 16 bits → 2 rows.
    const rows = text.split("\n").slice(3).filter((_, i) => i % 2 === 0).length;
    expect(rows).toBe(2);
  });

  it("finds varints reachable via Group/Repeat/Switch/Encrypted in collectVarintIds", () => {
    // Build a packet where a varint hides under each container kind so the
    // recursive collector + encoding lookup exercise every branch.
    const pkt: Packet = {
      name: "DeepV",
      rowBits: 8,
      body: [
        {
          kind: "group",
          id: "g",
          children: [
            { id: "vg", name: "VG", type: { kind: "varint", encoding: "quic" } },
          ],
        },
        {
          kind: "repeat",
          id: "rep",
          element: {
            id: "elem",
            fields: [
              { id: "vr", name: "VR", type: { kind: "varint", encoding: "protobuf" } },
            ],
          },
          count: { kind: "lit", value: 0 },
        },
        {
          kind: "switch",
          id: "sw",
          on: { kind: "lit", value: 1 },
          cases: {
            "1": {
              id: "s1",
              fields: [
                { id: "vs", name: "VS", type: { kind: "varint", encoding: "cbor" } },
              ],
            },
          },
          default: {
            id: "sd",
            fields: [
              { id: "vd", name: "VD", type: { kind: "varint", encoding: "quic" } },
            ],
          },
        },
        {
          kind: "encrypted",
          id: "enc",
          plaintext: {
            id: "ep",
            fields: [
              { id: "ve", name: "VE", type: { kind: "varint", encoding: "quic" } },
            ],
          },
          contextNote: "k",
        },
      ],
    };
    // Should not throw and should render varint labels.
    const text = toAscii(pkt);
    expect(text).toContain("varint");
  });

  it("collectVarintIds traverses Switch.default branch when no cases match", () => {
    // Empty cases map; default branch must still be walked.
    const pkt: Packet = {
      name: "SD",
      rowBits: 8,
      body: [
        {
          kind: "switch",
          id: "sw",
          on: { kind: "lit", value: 1 },
          cases: {},
          default: {
            id: "sd",
            fields: [
              { id: "vd", name: "VD", type: { kind: "varint", encoding: "quic" } },
            ],
          },
        },
      ],
    };
    // No throw; render produces a varint cell.
    const env: PacketEnv = new Map([["vd", 8]]);
    const text = toAscii(pkt, env);
    expect(text).toContain("varint");
  });
});

describe("toAscii — invariants vs normalize", () => {
  it("the rendered total bit count equals normalize().totalBits", () => {
    for (const [key, pkt] of Object.entries(ALL_PRESETS)) {
      const env = envWithRefs(pkt);
      const total = normalize(pkt, env).totalBits;
      const text = toAscii(pkt, env);
      // Cheap sanity: count the field lines (one per row excluding the
      // header trio) and compare against ceil(total/rowBits) row count.
      const rowCount = Math.ceil(total / pkt.rowBits);
      const fieldLines = text.split("\n").slice(3).filter((_, i) => i % 2 === 0);
      expect(fieldLines.length, key).toBe(rowCount);
    }
  });
});
