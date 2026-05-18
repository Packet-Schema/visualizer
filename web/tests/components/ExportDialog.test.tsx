// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ExportDialog from "@/components/diagram-export/ExportDialog";
import {
  downloadBlobFile,
  downloadTextFile,
  svgToPngBlob,
} from "@/lib/diagram-export";
import type { Packet, ResolvedLayout } from "@/lib/psml/renderer";

vi.mock("@/lib/diagram-export", async () => {
  const actual = await vi.importActual<typeof import("@/lib/diagram-export")>(
    "@/lib/diagram-export",
  );
  return {
    ...actual,
    downloadBlobFile: vi.fn(),
    downloadTextFile: vi.fn(),
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

async function renderDialog(onClose = vi.fn()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <ExportDialog packet={packet} layout={layout} open onClose={onClose} />,
    );
  });
  return { container, onClose, root };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function selectByLabel(container: HTMLElement, labelText: string): HTMLSelectElement {
  const label = [...container.querySelectorAll("label")].find((candidate) =>
    candidate.textContent?.includes(labelText),
  );
  const select = label?.querySelector("select");
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error(`Missing select for ${labelText}`);
  }
  return select;
}

function inputByLabel(container: HTMLElement, labelText: string): HTMLInputElement {
  const label = [...container.querySelectorAll("label")].find((candidate) =>
    candidate.textContent?.includes(labelText),
  );
  const input = label?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Missing input for ${labelText}`);
  }
  return input;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("ExportDialog", () => {
  it("starts on SVG and hides PNG-only controls", async () => {
    const { container, root } = await renderDialog();

    expect(selectByLabel(container, "Format").value).toBe("svg");
    expect(selectByLabel(container, "Theme for saved image").value).toBe("follow-ui");
    expect(container.textContent).not.toContain("PNG resolution");
    expect(container.textContent).toContain("Save SVG");

    await act(async () => root?.unmount());
  });

  it("shows PNG-only controls and changes the save label when PNG is selected", async () => {
    const { container, root } = await renderDialog();
    const format = selectByLabel(container, "Format");

    await act(async () => {
      format.value = "png";
      format.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(container.textContent).toContain("PNG resolution");
    expect(container.textContent).toContain("Save PNG");
    expect(inputByLabel(container, "PNG resolution").getAttribute("type")).toBe("range");
    expect(inputByLabel(container, "PNG resolution").getAttribute("min")).toBe("1");
    expect(inputByLabel(container, "PNG resolution").getAttribute("max")).toBe("8");
    expect(inputByLabel(container, "PNG resolution").getAttribute("step")).toBe("1");
    expect(inputByLabel(container, "PNG resolution").className).toBe("pv-slider");

    await act(async () => root?.unmount());
  });

  it("routes the single save action to the selected format", async () => {
    vi.mocked(svgToPngBlob).mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    const { container, root } = await renderDialog();

    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Save SVG")
        ?.click();
    });
    expect(downloadTextFile).toHaveBeenCalledTimes(1);
    expect(downloadBlobFile).not.toHaveBeenCalled();

    const format = selectByLabel(container, "Format");
    await act(async () => {
      format.value = "png";
      format.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Save PNG")
        ?.click();
    });

    expect(svgToPngBlob).toHaveBeenCalledTimes(1);
    expect(downloadBlobFile).toHaveBeenCalledTimes(1);

    await act(async () => root?.unmount());
  });

  it("keeps PNG errors visible after a failed save", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(svgToPngBlob).mockRejectedValue(new Error("boom"));
    const { container, root } = await renderDialog();
    const format = selectByLabel(container, "Format");

    await act(async () => {
      format.value = "png";
      format.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Save PNG")
        ?.click();
    });

    expect(container.textContent).toContain(
      "PNG export failed. Please try SVG or another browser.",
    );

    await act(async () => root?.unmount());
  });

  it("ignores stale PNG completions after the dialog is closed and reopened", async () => {
    const pending = deferred<Blob>();
    vi.mocked(svgToPngBlob).mockReturnValue(pending.promise);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const firstOnClose = vi.fn();
    const secondOnClose = vi.fn();

    await act(async () => {
      root.render(<ExportDialog packet={packet} layout={layout} open onClose={firstOnClose} />);
    });

    const format = selectByLabel(container, "Format");
    await act(async () => {
      format.value = "png";
      format.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Save PNG")
        ?.click();
    });

    await act(async () => {
      root.render(
        <ExportDialog packet={packet} layout={layout} open={false} onClose={firstOnClose} />,
      );
    });
    await act(async () => {
      root.render(
        <ExportDialog packet={packet} layout={layout} open onClose={secondOnClose} />,
      );
    });

    pending.resolve(new Blob(["png"], { type: "image/png" }));
    await act(async () => {
      await pending.promise;
    });

    expect(downloadBlobFile).not.toHaveBeenCalled();
    expect(firstOnClose).not.toHaveBeenCalled();
    expect(secondOnClose).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("persists all dialog settings as JSON and restores them on the next mount", async () => {
    const { container, root } = await renderDialog();
    const format = selectByLabel(container, "Format");
    const exportThemeMode = selectByLabel(container, "Theme for saved image");
    const width = selectByLabel(container, "Width");
    const transparency = inputByLabel(container, "Transparent background");

    await act(async () => {
      format.value = "png";
      format.dispatchEvent(new Event("change", { bubbles: true }));
      exportThemeMode.value = "dark";
      exportThemeMode.dispatchEvent(new Event("change", { bubbles: true }));
      width.value = "40";
      width.dispatchEvent(new Event("change", { bubbles: true }));
      transparency.click();
    });

    const scale = inputByLabel(container, "PNG resolution");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        scale,
        "7",
      );
      scale.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(JSON.parse(localStorage.getItem("packet-view-diagram-export-settings-v1") ?? ""))
      .toEqual({
        format: "png",
        exportThemeMode: "dark",
        pngScale: 7,
        diagramWidth: 40,
        transparentBackground: true,
      });

    await act(async () => root?.unmount());

    const remounted = await renderDialog();
    expect(selectByLabel(remounted.container, "Format").value).toBe("png");
    expect(selectByLabel(remounted.container, "Theme for saved image").value).toBe("dark");
    expect(selectByLabel(remounted.container, "Width").value).toBe("40");
    expect(inputByLabel(remounted.container, "Transparent background").checked).toBe(
      true,
    );
    expect(inputByLabel(remounted.container, "PNG resolution").value).toBe("7");

    await act(async () => remounted.root?.unmount());
  });
});
