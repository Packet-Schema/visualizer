// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildDiagramSvg,
  downloadBlobFile,
  downloadTextFile,
  readDiagramTheme,
  readDiagramThemeFromDocument,
  svgToPngBlob,
} from "../../lib/diagram-export";
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
    const parser = new DOMParser();
    const standardSvg = parser.parseFromString(standard, "image/svg+xml").documentElement;
    const wideSvg = parser.parseFromString(wide, "image/svg+xml").documentElement;
    const wideBodyRect = wideSvg.querySelector("rect[rx='10']");

    expect(standardSvg.getAttribute("width")).toBe("224");
    expect(wideSvg.getAttribute("width")).toBe("352");
    expect(wideBodyRect?.getAttribute("width")).toBe("156");
  });

  it("can emit transparent background when requested", () => {
    const normal = buildDiagramSvg(packet, layoutForMode("wire"));
    const transparent = buildDiagramSvg(packet, layoutForMode("wire"), {
      transparentBackground: true,
    });
    expect(normal).toContain("<rect width=");
    expect(normal).toContain('fill="#f5f7fb"');
    expect(transparent).not.toContain("<rect width=");
    expect(transparent).not.toContain('fill="#f5f7fb"');
    expect(transparent).not.toContain('fill="#fbfcfe"');
  });

  it("centers ruler labels and clips field text to each cell", () => {
    const svg = new DOMParser()
      .parseFromString(buildDiagramSvg(packet, layoutForMode("wire")), "image/svg+xml")
      .documentElement;
    const firstRulerLabel = svg.querySelector("text");
    const firstFieldLabel = svg.querySelector("text[clip-path]");

    expect(firstRulerLabel?.getAttribute("text-anchor")).toBe("middle");
    expect(firstFieldLabel?.getAttribute("clip-path")).toBe("url(#cell-0-0-0061)");
    expect(svg.querySelector("clipPath#cell-0-0-0061")).not.toBeNull();
  });

  it("sanitizes clip-path ids for field ids that contain fragment-breaking characters", () => {
    const repeatedFieldPacket: Packet = {
      ...packet,
      fields: [{ id: "name#1 \"quoted\"", name: "Type", bits: 8, category: "type" }],
    };
    const layout: ResolvedLayout = {
      totalBits: 8,
      cells: [
        {
          field: repeatedFieldPacket.fields[0],
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
    const svg = new DOMParser()
      .parseFromString(buildDiagramSvg(repeatedFieldPacket, layout), "image/svg+xml")
      .documentElement;
    const fieldLabel = svg.querySelector("text[clip-path]");
    const clipPath = svg.querySelector("clipPath");
    const clipPathId = clipPath?.getAttribute("id");

    expect(clipPathId).toBe("cell-0-0-006e-0061-006d-0065-0023-0031-0020-0022-0071-0075-006f-0074-0065-0064-0022");
    expect(clipPathId).not.toContain("#");
    expect(clipPathId).not.toContain(" ");
    expect(clipPathId).not.toContain("\"");
    expect(fieldLabel?.getAttribute("clip-path")).toBe(`url(#${clipPathId})`);
  });

  it("rejects invalid row indices instead of corrupting the row array", () => {
    const invalidLayout = {
      ...layoutForMode("wire"),
      cells: [{ ...layoutForMode("wire").cells[0], row: -1 }],
    };

    expect(() => buildDiagramSvg(packet, invalidLayout)).toThrow(
      "Invalid diagram row index: -1",
    );
  });
});

describe("diagram export helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads concrete theme colors from the document", () => {
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      const color = (element as HTMLElement).style.color;
      return {
        color:
          color === "var(--bg-elevated)"
            ? "rgb(1, 2, 3)"
            : color === "var(--field-blue)"
              ? "rgb(4, 5, 6)"
              : "",
      } as CSSStyleDeclaration;
    });

    const theme = readDiagramThemeFromDocument();

    expect(theme.background).toBe("rgb(1, 2, 3)");
    expect(theme.fieldPalette.blue).toBe("rgb(4, 5, 6)");
  });

  it("resolves explicit light/dark theme independent from current UI theme", () => {
    document.documentElement.setAttribute("data-theme", "dark");

    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      const themedAncestor = (element as HTMLElement).closest("[data-theme]");
      const explicitTheme = themedAncestor?.getAttribute("data-theme");
      const color = (element as HTMLElement).style.color;
      if (color === "var(--bg-elevated)" && explicitTheme === "light") {
        return { color: "rgb(250, 250, 250)" } as CSSStyleDeclaration;
      }
      if (color === "var(--bg-elevated)" && explicitTheme === "dark") {
        return { color: "rgb(15, 15, 15)" } as CSSStyleDeclaration;
      }
      return { color: "" } as CSSStyleDeclaration;
    });

    expect(readDiagramTheme("light").background).toBe("rgb(250, 250, 250)");
    expect(readDiagramTheme("dark").background).toBe("rgb(15, 15, 15)");
  });

  it("uses the current UI theme when mode is follow-ui", () => {
    document.documentElement.setAttribute("data-theme", "dark");

    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      const color = (element as HTMLElement).style.color;
      if (color !== "var(--bg-elevated)") return { color: "" } as CSSStyleDeclaration;
      return { color: "rgb(20, 21, 22)" } as CSSStyleDeclaration;
    });

    expect(readDiagramTheme("follow-ui").background).toBe("rgb(20, 21, 22)");
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
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

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
    vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
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
      } as HTMLCanvasElement;
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
});
