// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/diagram-export", async () => {
  const actual = await vi.importActual<typeof import("@/lib/diagram-export")>(
    "@/lib/diagram-export",
  );
  return {
    ...actual,
    buildDiagramSvg: vi.fn(
      (
        _packet: import("@/lib/psml/renderer").Packet,
        _layout: import("@/lib/psml/renderer").ResolvedLayout,
        options?: { theme?: { background: string } },
      ) => `<svg data-bg="${options?.theme?.background ?? "none"}"></svg>`,
    ),
    readDiagramTheme: vi.fn((mode: string) => ({
      background:
        mode === "follow-ui" &&
        document.documentElement.getAttribute("data-theme") === "dark"
          ? "dark-bg"
          : "light-bg",
      rowEven: "",
      rowOdd: "",
      rulerTick: "",
      rulerLabel: "",
      accent: "",
      fieldStroke: "",
      fieldLabel: "",
      fieldSublabel: "",
      fieldContinuation: "",
      fieldPalette: {},
    })),
  };
});

import ImportExportDrawer from "@/components/import-export/ImportExportDrawer";

let mounted: { container: HTMLDivElement; root: Root }[] = [];

function mount(node: React.ReactNode): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  const entry = { container, root };
  mounted.push(entry);
  return entry;
}

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  mounted = [];
  document.documentElement.setAttribute("data-theme", "light");
});

describe("ImportExportDrawer", () => {
  it("renders without crashing", () => {
    const packet = {
      name: "Test",
      rowBits: 8,
      fields: [{ id: "a", name: "A", bits: 8 }],
    } as const;
    const layout = {
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
    const { container } = mount(
      <ImportExportDrawer
        open={true}
        mode="export"
        packet={packet as never}
        controllers={{}}
        layout={layout as never}
        onClose={() => {}}
        onImport={() => {}}
      />,
    );

    expect(container).toBeDefined();
  });

  it("generates SVG preview for export", () => {
    const packet = {
      name: "IPv4",
      rowBits: 32,
      fields: [{ id: "version", name: "Version", bits: 4 }],
    } as const;
    const layout = {
      totalBits: 32,
      cells: [
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
      ],
    };

    const { container } = mount(
      <ImportExportDrawer
        open={true}
        mode="export"
        packet={packet as never}
        controllers={{}}
        layout={layout as never}
        onClose={() => {}}
        onImport={() => {}}
      />,
    );

    const formatSelect =
      container.querySelectorAll<HTMLSelectElement>("select")[1];
    act(() => {
      formatSelect.value = "svg";
      formatSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const previewDiv = container.querySelector(".diagram-export-preview");
    expect(previewDiv).toBeDefined();
    expect(previewDiv?.innerHTML).toContain("<svg");
  });

  it("resolves follow-ui theme mode to current document theme", () => {
    const packet = {
      name: "TCP",
      rowBits: 32,
      fields: [{ id: "sport", name: "Sport", bits: 16 }],
    } as const;
    const layout = {
      totalBits: 32,
      cells: [
        {
          field: packet.fields[0],
          bitsTotal: 16,
          row: 0,
          startBit: 0,
          endBit: 15,
          segmentIndex: 0,
          totalSegments: 1,
          isFirst: true,
          isLast: true,
          fieldStartOffset: 0,
          fieldEndOffset: 15,
        },
      ],
    };

    document.documentElement.setAttribute("data-theme", "dark");
    const { container } = mount(
      <ImportExportDrawer
        open={true}
        mode="export"
        packet={packet as never}
        controllers={{}}
        layout={layout as never}
        onClose={() => {}}
        onImport={() => {}}
      />,
    );

    const formatSelect =
      container.querySelectorAll<HTMLSelectElement>("select")[1];
    act(() => {
      formatSelect.value = "svg";
      formatSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const themeSelect =
      container.querySelectorAll<HTMLSelectElement>("select")[2];
    act(() => {
      themeSelect.value = "follow-ui";
      themeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const previewDiv = container.querySelector(".diagram-export-preview");
    expect(previewDiv?.innerHTML).toContain('data-bg="dark-bg"');
  });

  it("updates preview when document theme changes with follow-ui mode", async () => {
    const packet = {
      name: "ICMP",
      rowBits: 32,
      fields: [{ id: "type", name: "Type", bits: 8 }],
    } as const;
    const layout = {
      totalBits: 32,
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

    document.documentElement.setAttribute("data-theme", "light");
    const { container } = mount(
      <ImportExportDrawer
        open={true}
        mode="export"
        packet={packet as never}
        controllers={{}}
        layout={layout as never}
        onClose={() => {}}
        onImport={() => {}}
      />,
    );

    const formatSelect =
      container.querySelectorAll<HTMLSelectElement>("select")[1];
    act(() => {
      formatSelect.value = "svg";
      formatSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const themeSelect =
      container.querySelectorAll<HTMLSelectElement>("select")[2];
    act(() => {
      themeSelect.value = "follow-ui";
      themeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    let previewDiv = container.querySelector(".diagram-export-preview");
    expect(previewDiv?.innerHTML).toContain('data-bg="light-bg"');

    // Simulate document theme change
    act(() => {
      document.documentElement.setAttribute("data-theme", "dark");
      // Trigger MutationObserver callback
      const event = new MutationEvent("DOMAttrModified", {
        attrName: "data-theme",
      });
      document.documentElement.dispatchEvent(event);
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    previewDiv = container.querySelector(".diagram-export-preview");
    expect(previewDiv?.innerHTML).toContain('data-bg="dark-bg"');
  });
});
