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
import { PRESETS } from "@/lib/psdl/presets.server";
import { resolveLayout } from "@/lib/psdl/layout";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";

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
  // IPv4's options region is a TLV-shaped repeat inside a single-ref `bounded`
  // scope (`ihl*4 - 20`) lifted to the `options` tlv field. The TLV editor
  // (add/remove records) owns that region; IHL must NOT also be a length-slider
  // (dragging it would inflate the byte counter while ZERO new cells appear), so
  // the IHL cell is NOT painted overridable. The override surface is `options`.
  it("does NOT mark IHL overridable on IPv4 (the options TLV editor owns the region)", async () => {
    const ipv4 = PRESETS.ipv4!;
    const packet = psdlToRenderer(ipv4);

    // The mirror's override surface for the options region is the lifted tlv
    // field, not an IHL length slider.
    expect(packet.fields.find((f) => f.id === "ihl")?.controlsLength).toBe(
      undefined,
    );
    expect(packet.fields.some((f) => f.id === "options" && f.tlv)).toBe(true);

    const layout = resolveLayout(ipv4, {
      env: new Map<string, number>([
        ["ihl", 5],
        ["options", 0],
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
    expect(ihlCell?.getAttribute("data-overridable")).not.toBe("true");
  });
});
