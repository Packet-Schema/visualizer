// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cellVisual,
  downloadBlobFile,
  downloadTextFile,
  generateLayoutCssVariables,
  naturalDiagramHeight,
  readDiagramTheme,
  rowBandColor,
  svgToPngBlob,
} from "../../lib/diagram-export";
import type { DiagramExportTheme } from "../../lib/diagram-export";
import { FIELD_FILL_OPACITY } from "../../lib/constants";
import type { Packet, ResolvedLayout } from "../../lib/psdl/renderer";

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
              field: {
                id: "plain",
                name: "Plaintext",
                bits: 12,
                category: "payload-marker",
              },
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
              field: {
                id: "plain",
                name: "Plaintext",
                bits: 12,
                category: "payload-marker",
              },
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

const LIGHT_TEST_THEME: DiagramExportTheme = {
  background: "#ffffff",
  rowEven: "#f5f7fb",
  rowOdd: "#fbfcfe",
  rulerTick: "#667085",
  rulerLabel: "#475467",
  accent: "#2563eb",
  fieldStroke: "#344054",
  fieldLabel: "#101828",
  fieldSublabel: "#344054",
  fieldContinuation: "#667085",
  markerAccent: "#d4548f",
  markerAccentSoft: "#e8b4c8",
  subfieldBackground: "#fafbfc",
  fieldFillOpacity: FIELD_FILL_OPACITY,
  rulerMinorOpacity: 0.55,
  subfieldBackgroundOpacity: 0.52,
  fieldPalette: {
    blue: `rgba(127, 183, 255, ${FIELD_FILL_OPACITY})`,
    indigo: `rgba(168, 166, 255, ${FIELD_FILL_OPACITY})`,
    violet: `rgba(209, 165, 255, ${FIELD_FILL_OPACITY})`,
    teal: `rgba(142, 215, 209, ${FIELD_FILL_OPACITY})`,
    green: `rgba(168, 223, 159, ${FIELD_FILL_OPACITY})`,
    amber: `rgba(243, 215, 126, ${FIELD_FILL_OPACITY})`,
    orange: `rgba(247, 178, 122, ${FIELD_FILL_OPACITY})`,
    rose: `rgba(244, 161, 174, ${FIELD_FILL_OPACITY})`,
    slate: `rgba(195, 200, 211, ${FIELD_FILL_OPACITY})`,
  },
};

describe("diagram export helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // vi.restoreAllMocks() does not undo vi.stubGlobal — the svgToPngBlob
    // tests below stub `Image`, and leaving the stub around can leak into
    // other tests in the same worker.
    vi.unstubAllGlobals();
    document.head.querySelectorAll("style[data-test-theme]").forEach((el) => {
      el.remove();
    });
  });

  it("returns explicit light/dark theme independent from current UI theme", () => {
    document.documentElement.setAttribute("data-theme", "dark");

    expect(readDiagramTheme("light").background).toBe("#FBFEFF");
    expect(readDiagramTheme("dark").background).toBe("#151A28");
  });

  it("returns theme constants independent of CSSLayerBlockRule", () => {
    const original = globalThis.CSSLayerBlockRule;

    // Older Safari/WebView builds do not expose CSSLayerBlockRule at all.
    // readDiagramTheme should still return the correct theme constants.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).CSSLayerBlockRule;

    try {
      expect(readDiagramTheme("light").background).toBe("#FBFEFF");
      expect(readDiagramTheme("dark").background).toBe("#151A28");
    } finally {
      globalThis.CSSLayerBlockRule = original;
    }
  });

  it("uses the current UI theme when mode is follow-ui", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    expect(readDiagramTheme("follow-ui").background).toBe("#151A28");

    document.documentElement.setAttribute("data-theme", "light");
    expect(readDiagramTheme("follow-ui").background).toBe("#FBFEFF");
  });

  it("returns explicit theme without mutating the current UI theme", () => {
    document.documentElement.setAttribute("data-theme", "dark");

    expect(readDiagramTheme("light").background).toBe("#FBFEFF");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("downloads text and blob files through temporary anchors", () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:test"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:test");
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    downloadTextFile("demo.svg", "image/svg+xml", "<svg />");
    downloadBlobFile("demo.png", new Blob(["png"], { type: "image/png" }));

    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(click).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("rasterizes SVG into a PNG blob", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:test"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((
      tagName: string,
    ) => {
      if (tagName !== "canvas") {
        return createElement(tagName);
      }
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          scale: vi.fn(),
          drawImage: vi.fn(),
        }),
        toBlob: (callback: BlobCallback) =>
          callback(new Blob(["png"], { type: "image/png" })),
      } as unknown as HTMLCanvasElement;
    }) as typeof document.createElement);

    class MockImage {
      width = 100;
      height = 50;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }

    vi.stubGlobal("Image", MockImage);

    await expect(svgToPngBlob("<svg />", 2)).resolves.toBeInstanceOf(Blob);
  });

  it("rejects when the image fails to load", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:bad");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    class FailingImage {
      width = 0;
      height = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal("Image", FailingImage);

    await expect(svgToPngBlob("<svg />", 2)).rejects.toBeDefined();
  });

  it("rejects when the canvas 2D context is unavailable", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:bad");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((
      tagName: string,
    ) => {
      if (tagName !== "canvas") return createElement(tagName);
      return {
        width: 0,
        height: 0,
        getContext: () => null,
        toBlob: () => {},
      } as unknown as HTMLCanvasElement;
    }) as typeof document.createElement);

    class OkImage {
      width = 10;
      height = 10;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", OkImage);

    await expect(svgToPngBlob("<svg />", 2)).rejects.toBeDefined();
  });

  it("rejects when canvas.toBlob yields no blob", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:bad");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((
      tagName: string,
    ) => {
      if (tagName !== "canvas") return createElement(tagName);
      return {
        width: 0,
        height: 0,
        getContext: () => ({ scale: vi.fn(), drawImage: vi.fn() }),
        toBlob: (callback: BlobCallback) => callback(null),
      } as unknown as HTMLCanvasElement;
    }) as typeof document.createElement);

    class OkImage {
      width = 10;
      height = 10;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", OkImage);

    await expect(svgToPngBlob("<svg />", 2)).rejects.toBeDefined();
  });

  it("generates CSS variables for all layout constants", () => {
    const css = generateLayoutCssVariables();
    expect(css).toContain(":root {");
    expect(css).toContain("--diagram-ruler-height: 22px");
    expect(css).toContain("--diagram-ruler-gap: 6px");
    expect(css).toContain("--diagram-row-height: 56px");
    expect(css).toContain("--diagram-row-padding-vertical: 4px");
    expect(css).toContain("--diagram-cell-padding-vertical: 6px");
    expect(css).toContain("--diagram-cell-padding-horizontal: 8px");
    expect(css).toContain("--subfield-height: 18px");
    expect(css).toContain("--row-border-radius: 8px");
    expect(css).toContain("--cell-border-radius: 10px");
    expect(css).toContain("--title-font-size: 12px");
    expect(css).toContain("--subtitle-font-size: 10px");
  });

  it("calculates natural diagram height correctly", () => {
    const height0 = naturalDiagramHeight(0);
    const height1 = naturalDiagramHeight(1);
    const height2 = naturalDiagramHeight(2);
    // padding (16*2=32) + rulerHeight (22) + rulerGap (6) = 60 for 0 rows
    expect(height0).toBe(60);
    // + 1 row: (rowHeight 56 + rowPaddingVertical*2=8) = 64 per row
    expect(height1).toBe(60 + 64);
    // + 1 gap between rows (4)
    expect(height2).toBe(60 + 64 + 64 + 4);
  });

  it("returns correct band color based on row index and theme", () => {
    expect(rowBandColor(0, LIGHT_TEST_THEME)).toBe(LIGHT_TEST_THEME.rowEven);
    expect(rowBandColor(1, LIGHT_TEST_THEME)).toBe(LIGHT_TEST_THEME.rowOdd);
    expect(rowBandColor(2, LIGHT_TEST_THEME)).toBe(LIGHT_TEST_THEME.rowEven);
    expect(rowBandColor(3, LIGHT_TEST_THEME)).toBe(LIGHT_TEST_THEME.rowOdd);
  });

  it("cellVisual applies field fill with opacity", () => {
    const cell = layoutForMode("wire").cells[0];
    const field = packet.fields[0];
    const visual = cellVisual(cell, field, LIGHT_TEST_THEME);
    expect(visual.fill).toContain("rgba");
    expect(visual.fill).toContain(String(FIELD_FILL_OPACITY));
    expect(visual.isDashed).toBe(false);
    expect(visual.titleColor).toBe(LIGHT_TEST_THEME.fieldLabel);
    expect(visual.title).toBe("Type");
    expect(visual.subtitle).toBe("4 bits");
  });

  it("cellVisual marks encrypted cells as dashed with accent stroke", () => {
    const encryptedCell = layoutForMode("wire").cells[1];
    const field = packet.fields[1];
    const visual = cellVisual(encryptedCell, field, LIGHT_TEST_THEME);
    expect(visual.isDashed).toBe(true);
    expect(visual.stroke).toBe(LIGHT_TEST_THEME.fieldStroke);
  });

  it("cellVisual applies continuation color to non-first segments", () => {
    const layout = layoutForMode("semantic");
    const continuationCell = layout.cells[2];
    const field = layout.cells[2].field;
    const visual = cellVisual(continuationCell, field, LIGHT_TEST_THEME);
    expect(visual.titleColor).toBe(LIGHT_TEST_THEME.fieldContinuation);
    expect(visual.title).toContain("…");
  });
});
