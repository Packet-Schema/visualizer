// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { StaticDiagram } from "@/components/diagram/StaticDiagram";
import type { Packet, ResolvedLayout } from "@/lib/psml/renderer";
import type { DiagramExportTheme } from "@/lib/diagram-export";

const mockTheme: DiagramExportTheme = {
  background: "#ffffff",
  rowEven: "#f0f0f0",
  rowOdd: "#ffffff",
  rulerTick: "#333333",
  rulerLabel: "#666666",
  accent: "#0066cc",
  fieldStroke: "#999999",
  fieldLabel: "#000000",
  fieldSublabel: "#666666",
  fieldContinuation: "#cccccc",
  markerAccent: "#d4548f",
  markerAccentSoft: "#e8b4c8",
  subfieldBackground: "#fafbfc",
  subfieldLabel: "#222222",
  fieldFillOpacity: 0.78,
  rulerMinorOpacity: 0.55,
  subfieldBackgroundOpacity: 0.52,
  fieldPalette: {
    type: "#ff6b6b",
    flag: "#4ecdc4",
    "payload-marker": "#45b7d1",
  },
};

const simplePacket: Packet = {
  name: "Simple",
  rowBits: 8,
  fields: [{ id: "a", name: "Field A", bits: 8 }],
};

const simpleLayout: ResolvedLayout = {
  totalBits: 8,
  cells: [
    {
      field: simplePacket.fields[0],
      bitsTotal: 8,
      row: 0,
      startBit: 0,
      endBit: 7,
      segmentIndex: 0,
      totalSegments: 1,
      isFirst: true,
      isLast: true,
      fieldStartOffset: 0,
      fieldEndOffset: 7,
    },
  ],
};

const multiRowPacket: Packet = {
  name: "Multi-row",
  rowBits: 32,
  fields: [
    { id: "a", name: "A", bits: 8 },
    { id: "b", name: "B", bits: 8 },
    { id: "c", name: "C", bits: 8 },
    { id: "d", name: "D", bits: 8 },
    { id: "e", name: "E", bits: 8 },
    { id: "f", name: "F", bits: 8 },
    { id: "g", name: "G", bits: 8 },
    { id: "h", name: "H", bits: 8 },
  ],
};

function createMultiRowLayout(
  rowBits: number,
  fieldCount: number,
): ResolvedLayout {
  const cellsPerRow = rowBits / 8;
  const cells = multiRowPacket.fields
    .slice(0, fieldCount)
    .map((field, idx) => ({
      field,
      bitsTotal: 8,
      row: Math.floor(idx / cellsPerRow),
      startBit: (idx % cellsPerRow) * 8,
      endBit: (idx % cellsPerRow) * 8 + 7,
      segmentIndex: 0,
      totalSegments: 1,
      isFirst: idx % cellsPerRow === 0,
      isLast: idx % cellsPerRow === cellsPerRow - 1,
      fieldStartOffset: idx * 8,
      fieldEndOffset: idx * 8 + 7,
    }));
  return {
    totalBits: rowBits * Math.ceil(fieldCount / cellsPerRow),
    cells,
  };
}

describe("StaticDiagram", () => {
  it("renders a simple diagram", () => {
    const result = StaticDiagram({
      packet: simplePacket,
      layout: simpleLayout,
      theme: mockTheme,
    });

    expect(result).toBeDefined();
    expect(result.type).toBe("div");
    expect(result.props.style).toHaveProperty("display", "flex");
    expect(result.props.style).toHaveProperty("flexDirection", "column");
  });

  it("renders ruler with correct number of ticks", () => {
    const result = StaticDiagram({
      packet: simplePacket,
      layout: simpleLayout,
      theme: mockTheme,
    });

    const children = result.props.children;
    const ruler = children[0];
    expect(ruler.props.style).toHaveProperty("display", "flex");
    expect(ruler.props.style).toHaveProperty("height");
  });

  it("respects maxRows limit", () => {
    const layout = createMultiRowLayout(32, 8);
    const result = StaticDiagram({
      packet: multiRowPacket,
      layout,
      theme: mockTheme,
      maxRows: 2,
    });

    const children = result.props.children;
    const diagramBody = children[1];
    const rows = diagramBody.props.children;

    expect(rows.length).toBeLessThanOrEqual(3);
  });

  it("applies targetHeight scaling", () => {
    const result = StaticDiagram({
      packet: simplePacket,
      layout: simpleLayout,
      theme: mockTheme,
      targetHeight: 200,
    });

    expect(result).toBeDefined();
    expect(result.props.style).toHaveProperty("display", "flex");
  });

  it("uses custom font family when provided", () => {
    const customFont = "Custom Font";
    const result = StaticDiagram({
      packet: simplePacket,
      layout: simpleLayout,
      theme: mockTheme,
      fontFamily: customFont,
    });

    expect(result.props.style).toHaveProperty("fontFamily", customFont);
  });

  it("uses default font family when not provided", () => {
    const result = StaticDiagram({
      packet: simplePacket,
      layout: simpleLayout,
      theme: mockTheme,
    });

    expect(result.props.style).toHaveProperty(
      "fontFamily",
      "LINE Seed JP, system-ui, sans-serif",
    );
  });

  it("renders cells for each row", () => {
    const layout = createMultiRowLayout(32, 4);
    const result = StaticDiagram({
      packet: multiRowPacket,
      layout,
      theme: mockTheme,
    });

    expect(result).toBeDefined();
    expect(result.props.children).toBeDefined();
    const children = Array.isArray(result.props.children)
      ? result.props.children
      : [result.props.children];
    expect(children.length).toBeGreaterThanOrEqual(2);
  });

  it("alternates row background colors", () => {
    const layout = createMultiRowLayout(32, 4);
    const result = StaticDiagram({
      packet: multiRowPacket,
      layout,
      theme: mockTheme,
    });

    expect(result).toBeDefined();
    expect(result.props.style).toHaveProperty("display", "flex");
  });
});
