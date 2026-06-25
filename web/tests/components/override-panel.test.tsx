// @vitest-environment jsdom
//
// OverridePanel smoke — mounts the panel directly with curated preset
// fixtures and asserts each widget renders for its target field type.

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import OverridePanel from "@/components/field-details/OverridePanel";
import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";

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

  it("warns about slot overshoot on the inline variant dropdown (D2)", async () => {
    // override-audit D2: swapping a record's variant via the inline dropdown
    // (reached by clicking the record cell) must surface the same overshoot
    // warning as the full TlvEditor. Seed a 15 B Record Route into a 4 B slot.
    const packet = psdlToRenderer(PRESETS.ipv4!);
    const optionsField = packet.fields.find((f) => f.id === "options");
    if (optionsField?.tlv) optionsField.tlv.instances = [{ kind: 7 }];
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId="options__inst_0"
        controllers={{ ihl: 6 }}
        onTlvChange={() => {}}
        onControllerChange={() => {}}
        tlvSlotBytes={{ options: 4 }}
      />,
    );
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent ?? "").toMatch(/slot is only 4 B/);
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

  it("edits a chain header's Next Header (selects what FOLLOWS it)", async () => {
    // Per IPv6 wire semantics, a header's Next Header field selects the NEXT
    // element. Clicking header #0 (Hop-by-Hop) and changing its Next Header
    // must change header #1's type — not header #0's own type.
    const packet = psdlToRenderer(PRESETS.ipv6!);
    const chainField = packet.fields.find((f) => f.chainCatalog);
    if (!chainField) throw new Error("ipv6 mirror missing chain field");
    chainField.chainInstances = [{ proto: 0 }, { proto: 43 }]; // HBH, Routing
    let received: {
      instances: { proto: number }[];
      finalProto?: number;
    } | null = null;
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId="nextHeader_chain__chain_0"
        controllers={{}}
        onChainChange={(_f, next) => {
          received = next;
        }}
        onControllerChange={() => {}}
      />,
    );
    const select = container.querySelector<HTMLSelectElement>("select");
    expect(
      select,
      "per-header Next Header dropdown must render",
    ).not.toBeNull();
    const text = container.textContent ?? "";
    // Label frames it as the NEXT header, with readable names.
    expect(text).toMatch(/Next Header after Hop-by-Hop/);
    // #0's Next Header currently points to header #1 = Routing (43).
    expect(Number(select!.value)).toBe(43);
    // Change it to Fragment (44): header #1 becomes Fragment, #0 unchanged.
    await act(async () => {
      select!.value = "44";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(received).not.toBeNull();
    expect(received!.instances.map((i) => i.proto)).toEqual([0, 44]);
  });

  it("ending a chain header on an upper-layer protocol truncates the tail", async () => {
    const packet = psdlToRenderer(PRESETS.ipv6!);
    const chainField = packet.fields.find((f) => f.chainCatalog)!;
    chainField.chainInstances = [{ proto: 0 }, { proto: 43 }]; // HBH, Routing
    let received: {
      instances: { proto: number }[];
      finalProto?: number;
    } | null = null;
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId="nextHeader_chain__chain_0"
        controllers={{}}
        onChainChange={(_f, next) => {
          received = next;
        }}
        onControllerChange={() => {}}
      />,
    );
    const select = container.querySelector<HTMLSelectElement>("select");
    // Set #0's Next Header to TCP (6): chain ends after #0, Routing dropped.
    await act(async () => {
      select!.value = "6";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(received!.instances.map((i) => i.proto)).toEqual([0]);
    expect(received!.finalProto).toBe(6);
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
    // The 0.5 ospfHello preset names the neighbour Repeat "Neighbors" (eos),
    // surfaced via freeRepeats; it was "Neighbor List" in 0.4.
    expect(text).toMatch(/Neighbors/);
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
    // TTL itself carries no runtime override → read-only message, no
    // field-level slider/checkbox. (In 0.5 the EmptyState also renders the
    // packet-level "Peek-based switches" picker, since the ipv4 Options TLV
    // now surfaces a peek Switch; that <select> is a packet-level extra, not
    // a TTL override, so we no longer assert the panel is select-free.)
    expect(container.querySelector('input[type="range"]')).toBeNull();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(container.textContent).toMatch(/no runtime override/i);
  });

  it("resolves a plain-repeat leaf cell (dnsResponse RR Type) via diagram cells, not 'Field not found' (A1)", async () => {
    const dns = PRESETS.dnsResponse!;
    const packet = psdlToRenderer(dns);
    // Build the diagram cells the way PacketViewer does: preset defaults +
    // a controller to materialise one answer record + 0-filled refs.
    const env = new Map<string, number>();
    for (const [k, v] of initialEnv(dns)) env.set(k, v);
    env.set("dnsAnCount", 1);
    for (const r of collectPsdlRefs(dns)) if (!env.has(r)) env.set(r, 0);
    const { cells } = resolveLayout(dns, { env });
    // The RR Type leaf renders as a `#0` repeat cell that has NO mirror field
    // (the dnsAnswers repeat is a plain multi-field struct, dropped at
    // psdl-to-renderer/index.ts), so without `cells` it dead-ends.
    expect(cells.some((c) => c.field.id === "dnsRrType#0")).toBe(true);
    expect(packet.fields.some((f) => f.id === "dnsRrType")).toBe(false);

    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId="dnsRrType#0"
        controllers={{}}
        onControllerChange={() => {}}
        cells={cells}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/Field not found/);
    expect(text).toMatch(/no runtime override/i);
  });
});
