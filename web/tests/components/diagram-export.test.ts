import { describe, expect, it } from "vitest";

import { buildDiagramSvg } from "../../lib/diagram-export";
import type { Packet, ResolvedLayout } from "../../lib/psml/renderer";

const packet: Packet = {
  name: "Demo & Packet",
  rowBits: 8,
  fields: [
    { id: "a", name: "Type", bits: 4, category: "type" },
    { id: "b", name: "Body", bits: 4, category: "payload-marker" },
  ],
};

function layoutForMode(mode: "wire" | "semantic"): ResolvedLayout {
  return {
    totalBits: mode === "wire" ? 8 : 16,
    cells:
      mode === "wire"
        ? [
            {
              field: packet.fields[0],
              bitsTotal: 4,
              row: 0,
              startBit: 0,
              endBit: 3,
              segmentIndex: 0,
              totalSegments: 1,
              isFirst: true,
              isLast: true,
              fieldStartOffset: 0,
              fieldEndOffset: 3,
            },
            {
              field: packet.fields[1],
              bitsTotal: 4,
              row: 0,
              startBit: 4,
              endBit: 7,
              segmentIndex: 0,
              totalSegments: 1,
              isFirst: true,
              isLast: true,
              fieldStartOffset: 4,
              fieldEndOffset: 7,
              encrypted: true,
            },
          ]
        : [
            {
              field: packet.fields[0],
              bitsTotal: 4,
              row: 0,
              startBit: 0,
              endBit: 3,
              segmentIndex: 0,
              totalSegments: 1,
              isFirst: true,
              isLast: true,
              fieldStartOffset: 0,
              fieldEndOffset: 3,
            },
            {
              field: { id: "plain", name: "Plaintext", bits: 12, category: "payload-marker" },
              bitsTotal: 12,
              row: 0,
              startBit: 4,
              endBit: 7,
              segmentIndex: 0,
              totalSegments: 2,
              isFirst: true,
              isLast: false,
              fieldStartOffset: 4,
              fieldEndOffset: 7,
            },
            {
              field: { id: "plain", name: "Plaintext", bits: 12, category: "payload-marker" },
              bitsTotal: 12,
              row: 1,
              startBit: 0,
              endBit: 7,
              segmentIndex: 1,
              totalSegments: 2,
              isFirst: false,
              isLast: true,
              fieldStartOffset: 8,
              fieldEndOffset: 15,
            },
          ],
  };
}

describe("buildDiagramSvg", () => {
  it("renders a standalone SVG with escaped metadata", () => {
    const svg = buildDiagramSvg(packet, layoutForMode("wire"));
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('aria-label="Demo &amp; Packet diagram"');
    expect(svg).toContain("Type");
    expect(svg).toContain("Body");
    expect(svg).toContain('stroke-dasharray="5 3"');
  });

  it("reflects the supplied layout shape, so callers can export the current view mode", () => {
    const wire = buildDiagramSvg(packet, layoutForMode("wire"));
    const semantic = buildDiagramSvg(packet, layoutForMode("semantic"));
    expect(wire).not.toContain("Plaintext");
    expect(semantic).toContain("Plaintext");
    expect(semantic).toContain("… Plaintext");
    expect(semantic).not.toBe(wire);
  });

  it("preserves bit ratios while allowing the whole exported diagram to become wider", () => {
    const standard = buildDiagramSvg(packet, layoutForMode("wire"), {
      bitWidth: 24,
    });
    const wide = buildDiagramSvg(packet, layoutForMode("wire"), {
      bitWidth: 40,
    });
    expect(standard).toContain('width="224"');
    expect(wide).toContain('width="352"');
    expect(wide).toContain('x="178"');
  });

  it("can emit transparent background when requested", () => {
    const normal = buildDiagramSvg(packet, layoutForMode("wire"));
    const transparent = buildDiagramSvg(packet, layoutForMode("wire"), {
      transparentBackground: true,
    });
    expect(normal).toContain("<rect width=");
    expect(transparent).not.toContain("<rect width=");
  });

});
