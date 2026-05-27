// @vitest-environment jsdom
//
// HybridDiagram override marker test — mounts the diagram for a single
// preset and verifies that cells corresponding to overridable fields
// (length controllers, TLV catalogs, chain catalogs) carry the
// `data-overridable="true"` attribute the CSS uses to render the dot.

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import HybridDiagram from "@/components/diagram/HybridDiagram";
import { PRESETS } from "@/lib/psml/presets.generated";
import { resolveLayout } from "@/lib/psml/layout";
import { psmlToRenderer } from "@/lib/psml/psml-to-renderer";

let activeRoot: Root | null = null;
let activeContainer: HTMLElement | null = null;

afterEach(async () => {
  if (activeRoot && activeContainer) {
    await act(async () => {
      activeRoot!.unmount();
    });
    activeContainer.remove();
  }
  activeRoot = null;
  activeContainer = null;
});

async function mount(ui: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  activeRoot = root;
  activeContainer = container;
  return { container };
}

describe("HybridDiagram override marker", () => {
  it("marks the IHL cell as overridable on IPv4", async () => {
    const ipv4 = PRESETS.ipv4!;
    const packet = psmlToRenderer(ipv4);
    const layout = resolveLayout(ipv4, {
      env: new Map<string, number>([
        ["ihl", 5],
        ["ipv4OptionsCount", 0],
        ["optType", 0],
        ["headerBytes", 20],
      ]),
    });

    const { container } = await mount(
      <HybridDiagram
        packet={packet}
        layout={layout}
        selectedFieldId={null}
        onFieldClick={() => {}}
        onSubfieldClick={() => {}}
      />,
    );

    const ihlCell = container.querySelector('[data-field-id="ihl"]');
    expect(ihlCell, "ihl cell must be rendered").not.toBeNull();
    expect(ihlCell?.getAttribute("data-overridable")).toBe("true");
  });
});
