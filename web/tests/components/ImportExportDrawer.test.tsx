// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import ImportExportDrawer from "@/components/import-export/ImportExportDrawer";
import { svgToPngBlob } from "@/lib/diagram-export";
import type { Packet, ResolvedLayout } from "@/lib/psml/renderer";

vi.mock("@/lib/diagram-export", async () => {
  const actual = await vi.importActual<typeof import("@/lib/diagram-export")>(
    "@/lib/diagram-export",
  );
  return {
    ...actual,
    svgToPngBlob: vi.fn(),
  };
});

const packet: Packet = {
  name: "Demo",
  rowBits: 8,
  fields: [{ id: "a", name: "Type", bits: 8, category: "type" }],
};

const layout: ResolvedLayout = {
  totalBits: 8,
  cells: [
    {
      field: packet.fields[0],
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

async function renderDrawer(): Promise<{
  container: HTMLDivElement;
  root: Root;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <ImportExportDrawer
        open
        mode="export"
        packet={packet}
        controllers={{}}
        layout={layout}
        onClose={vi.fn()}
        onImport={vi.fn()}
      />,
    );
  });
  return { container, root };
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("ImportExportDrawer image export", () => {
  function formatSelect(container: HTMLElement): HTMLSelectElement {
    const label = [...container.querySelectorAll("label")].find((candidate) =>
      candidate.textContent?.includes("Format:"),
    );
    const select = label?.querySelector("select");
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error("Format select not found");
    }
    return select;
  }

  it("shows image formats in Export format select", async () => {
    const { container, root } = await renderDrawer();
    const format = formatSelect(container);
    expect(format?.textContent).toContain("Image (SVG)");
    expect(format?.textContent).toContain("Image (PNG)");
    await act(async () => root.unmount());
  });

  it("switches from textarea to image preview for SVG format", async () => {
    const { container, root } = await renderDrawer();
    const format = formatSelect(container);
    await act(async () => {
      format.value = "svg";
      format.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector(".min-h-\\[200px\\] svg")).not.toBeNull();
    await act(async () => root.unmount());
  });

  it("copies PNG as image when format is PNG", async () => {
    vi.mocked(svgToPngBlob).mockResolvedValue(
      new Blob(["png"], { type: "image/png" }),
    );
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: class ClipboardItemMock {
        constructor(public data: Record<string, Blob>) {}
      },
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(), write },
    });

    const { container, root } = await renderDrawer();
    const format = formatSelect(container);
    await act(async () => {
      format.value = "png";
      format.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Copy")
        ?.click();
    });
    expect(svgToPngBlob).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });
});
