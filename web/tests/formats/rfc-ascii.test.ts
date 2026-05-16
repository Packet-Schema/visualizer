// PSML RFC-style ASCII exporter — well-formedness across every preset, the
// canonical IPv4 inline snapshot, the trailing-partial-row Ethernet
// regression, and label-truncation behaviour for the field-line printer.

import { describe, expect, it } from "vitest";
import { toAscii } from "../../lib/formats/rfc-ascii";
import { initialEnv, normalize } from "../../lib/psml/normalize";
import { GENERATED_PRESETS } from "../../lib/psml/presets.generated";
import { MANUAL_PRESETS } from "../../lib/psml/presets";
import type { Expr, Packet, PacketEnv } from "../../lib/psml/types";

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
