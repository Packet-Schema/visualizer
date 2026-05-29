// @vitest-environment jsdom
//
// OverridePanel smoke — mounts the panel directly with curated preset
// fixtures and asserts each widget renders for its target field type.

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import OverridePanel from "@/components/field-details/OverridePanel";
import { PRESETS } from "@/lib/psdl/presets.generated";
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

describe("OverridePanel widgets", () => {
  it("renders an OverrideSlider for IHL on IPv4", async () => {
    const packet = psdlToRenderer(PRESETS.ipv4!);
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId="ihl"
        controllers={{ ihl: 5 }}
        onControllerChange={() => {}}
      />,
    );
    expect(
      container.querySelector('input[type="range"]'),
      "IHL must surface a range slider",
    ).not.toBeNull();
  });

  it("renders a SwitchDropdown for longPacketType on quicLong", async () => {
    const packet = psdlToRenderer(PRESETS.quicLong!);
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId="longPacketType"
        controllers={{}}
        onControllerChange={() => {}}
      />,
    );
    const select = container.querySelector("select");
    expect(select, "longPacketType must surface a <select>").not.toBeNull();
    expect(select?.options.length).toBeGreaterThan(0);
  });

  it("renders a SwitchDropdown for payloadLength7 (Group subfield) on websocketFrame", async () => {
    const packet = psdlToRenderer(PRESETS.websocketFrame!);
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId="wsByte2:payloadLength7"
        controllers={{}}
        onControllerChange={() => {}}
      />,
    );
    const select = container.querySelector("select");
    expect(
      select,
      "payloadLength7 (a Group subfield) must surface a <select>",
    ).not.toBeNull();
  });

  it("renders an OptionalToggle for mask (Group subfield) on websocketFrame", async () => {
    const packet = psdlToRenderer(PRESETS.websocketFrame!);
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId="wsByte2:mask"
        controllers={{}}
        onControllerChange={() => {}}
      />,
    );
    const checkbox = container.querySelector('input[type="checkbox"]');
    expect(checkbox, "mask must surface a checkbox").not.toBeNull();
  });

  it("renders an EnumDropdown for the BOOTP op field on dhcpv4", async () => {
    const packet = psdlToRenderer(PRESETS.dhcpv4!);
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId="op"
        controllers={{}}
        onControllerChange={() => {}}
      />,
    );
    const select = container.querySelector("select");
    expect(select, "op (enum) must surface a <select>").not.toBeNull();
    const text = container.textContent ?? "";
    expect(text).toMatch(/BOOTREQUEST/);
    expect(text).toMatch(/BOOTREPLY/);
  });

  it("renders a TLV inner variant dropdown when an Option's leaf cell is selected", async () => {
    const packet = psdlToRenderer(PRESETS.ipv4!);
    // Seed an Options instance so the TLV catalog has something to switch.
    const optionsField = packet.fields.find((f) => f.id === "options");
    if (optionsField?.tlv) optionsField.tlv.instances = [{ kind: 7 }];
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId="options__inst_0"
        controllers={{}}
        onTlvChange={() => {}}
        onControllerChange={() => {}}
      />,
    );
    const select = container.querySelector("select");
    expect(select, "TLV inner leaf must surface a <select>").not.toBeNull();
    const text = container.textContent ?? "";
    expect(text).toMatch(/TLV variant/);
  });

  it("renders a ByteOrderToggle for pcieTlpFragment.address (LE override)", async () => {
    const packet = psdlToRenderer(PRESETS.pcieTlpFragment!);
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId="address"
        controllers={{}}
        onByteOrderChange={() => {}}
        onControllerChange={() => {}}
      />,
    );
    const radios = container.querySelectorAll('button[role="radio"]');
    const labels = Array.from(radios).map((r) => r.textContent);
    expect(labels).toContain("BE");
    expect(labels).toContain("LE");
  });

  it("renders a free Repeat stepper for ospfHello on empty selection", async () => {
    const packet = psdlToRenderer(PRESETS.ospfHello!);
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId={null}
        controllers={{}}
        onControllerChange={() => {}}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toMatch(/Repeats in this packet/);
    expect(text).toMatch(/Neighbor List/);
  });

  it("renders a peek-switch picker for tlsExtensionsBlock on empty selection", async () => {
    const packet = psdlToRenderer(PRESETS.tlsExtensionsBlock!);
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId={null}
        controllers={{}}
        onControllerChange={() => {}}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toMatch(/Peek-based switches/);
  });

  it("opens the TLV editor when the trailing 'Options remaining' cell is clicked", async () => {
    const packet = psdlToRenderer(PRESETS.ipv4!);
    const optionsField = packet.fields.find((f) => f.id === "options");
    if (optionsField?.tlv) optionsField.tlv.instances = [{ kind: 1 }];
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId="options__remaining"
        controllers={{ ihl: 7 }}
        onTlvChange={() => {}}
        onControllerChange={() => {}}
      />,
    );
    // TlvEditor surfaces the `+ Add record` append <select>; finding any
    // <select> here is enough to confirm the routing hit the full editor
    // and not the empty / not-found fallback states.
    const select = container.querySelector("select");
    expect(
      select,
      "remaining cell must surface the full TlvEditor",
    ).not.toBeNull();
    const text = container.textContent ?? "";
    expect(text).toMatch(/Add record/);
  });

  it("renders the empty state for a plain TTL field", async () => {
    const packet = psdlToRenderer(PRESETS.ipv4!);
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId="ttl"
        controllers={{}}
        onControllerChange={() => {}}
      />,
    );
    expect(container.querySelector('input[type="range"]')).toBeNull();
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(container.textContent).toMatch(/no runtime override/i);
  });
});
