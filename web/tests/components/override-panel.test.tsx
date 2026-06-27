// @vitest-environment jsdom
//
// OverridePanel smoke — mounts the panel directly with curated preset
// fixtures and asserts each widget renders for its target field type.

import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import OverridePanel from "@/components/field-details/OverridePanel";
import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { seedDynamicWidthDefaults } from "@/lib/psdl/dynamic-width-defaults";

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

  it("renders a free Repeat stepper for a top-level eos repeat (diameter)", async () => {
    // diameter's AVP list is a top-level eos repeat (not bounded), so its count
    // is a free env key and the stepper is a safe, working control.
    const packet = psdlToRenderer(PRESETS.diameter!);
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
    expect(text).toMatch(/AVPs/);
  });

  it("op-count repeat stepper displays the record count and writes the inverted ref (srhv6)", async () => {
    // SRv6 `repeat srhSegmentList count={srhLastEntry + 1}`: the stepper is
    // keyed on srhLastEntry but shows the SEGMENT count (= srhLastEntry + 1) and
    // writes the inverted value so the diagram's count becomes the shown N.
    const packet = psdlToRenderer(PRESETS.srhv6!);
    const writes: Array<[string, number]> = [];
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId={null}
        controllers={{ srhLastEntry: 2 }}
        onControllerChange={(k, v) => writes.push([k, v])}
      />,
    );
    expect(container.textContent ?? "").toMatch(/Repeats in this packet/);
    const input = container.querySelector(
      'input[type="number"]',
    ) as HTMLInputElement | null;
    expect(input, "op-count repeat must render a stepper input").not.toBeNull();
    // srhLastEntry=2 → 3 displayed segments.
    expect(input!.value).toBe("3");

    // Increment: display 3 → 4 segments → write srhLastEntry = 4 - 1 = 3.
    const incBtn = container.querySelector(
      'button[aria-label^="Increment"]',
    ) as HTMLButtonElement | null;
    expect(incBtn).not.toBeNull();
    await act(async () => {
      incBtn!.click();
    });
    expect(writes.at(-1)).toEqual(["srhLastEntry", 3]);

    // Typing "5" segments writes srhLastEntry = 5 - 1 = 4. React tracks the
    // controlled input's value internally, so set it through the native
    // prototype setter before dispatching `change` (otherwise React's tracker
    // sees no delta and skips onChange).
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      nativeSetter.call(input, "5");
      input!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(writes.at(-1)).toEqual(["srhLastEntry", 4]);
  });

  it("does NOT surface a free Repeat stepper for a bounded-nested repeat (ospfHello)", async () => {
    // ospfHello's neighbour list is governed by the packet-length bounded
    // budget, so a naked count stepper would over-consume it. It must be driven
    // by the length slider, not surfaced as a destructive stepper.
    const packet = psdlToRenderer(PRESETS.ospfHello!);
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId={null}
        controllers={{}}
        onControllerChange={() => {}}
      />,
    );
    expect(container.textContent ?? "").not.toMatch(/Repeats in this packet/);
  });

  it("renders a peek-switch picker for a standalone peek switch (sctp)", async () => {
    // sctp has a genuine standalone `Switch on peek` (not a TLV repeat's
    // dispatch), so the peek picker is the right surface for it.
    const packet = psdlToRenderer(PRESETS.sctp!);
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId={null}
        controllers={{}}
        onControllerChange={() => {}}
      />,
    );
    expect(container.textContent ?? "").toMatch(/Peek-based switches/);
  });

  it("does NOT double-surface a peek picker for a TLV repeat's dispatch (tlsExtensionsBlock)", async () => {
    // tlsExtensionsBlock's `extensions` is a Repeat<Switch on peek> promoted to
    // a TLV editor; the redundant peek picker (which goes inert after a record
    // is added) must be suppressed in favour of the TLV editor.
    const packet = psdlToRenderer(PRESETS.tlsExtensionsBlock!);
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId={null}
        controllers={{}}
        onControllerChange={() => {}}
        onTlvChange={() => {}}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/Peek-based switches/);
    expect(text).toMatch(/TLV editors in this packet/);
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

  it("surfaces a delimited length width picker for syslog's delimiter-terminated bytes (#3)", async () => {
    const packet = psdlToRenderer(PRESETS.syslog!);
    // Every top-level delimiter-terminated `bytes` field must be tagged so the
    // mirror knows it carries an editable byte-count width.
    const delimited = packet.fields
      .filter((f) => f.isDelimited)
      .map((f) => f.id);
    expect(delimited).toEqual([
      "pri",
      "version",
      "timestamp",
      "hostname",
      "appName",
      "procId",
      "msgId",
      "structData",
    ]);

    const onChange = vi.fn();
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId="hostname"
        controllers={{ hostname: 4 }}
        onControllerChange={onChange}
      />,
    );
    // It must NOT fall through to the read-only empty state...
    expect(container.textContent ?? "").not.toMatch(/no runtime override/i);
    // ...and must render a byte-count radiogroup whose buttons are byte values
    // (delimited stores a byte count, not bits, so the seeded 4 must show "4B").
    const group = container.querySelector('[role="radiogroup"]');
    expect(
      group,
      "delimited bytes must surface a width radiogroup",
    ).not.toBeNull();
    expect(container.textContent ?? "").toMatch(/Delimited length/i);
    const buttons = Array.from(
      group!.querySelectorAll('[role="radio"]'),
    ) as HTMLButtonElement[];
    expect(buttons.map((b) => b.textContent)).toContain("4B");
    const active = buttons.find(
      (b) => b.getAttribute("aria-checked") === "true",
    );
    expect(active?.textContent).toBe("4B");

    // Picking a different option writes a BYTE count under the field id.
    const eight = buttons.find((b) => b.textContent === "8B")!;
    await act(async () => {
      eight.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("hostname", 8);
  });

  // A varint / berLength leaf that lives INSIDE a switch case / optional /
  // repeat never becomes a renderer mirror field (psdlToRenderer only walks
  // flattenForMirror(body) top-level). Its width IS editable — env[fieldId]
  // bridges to __varintBits__/__berLen__ in layout.ts — so a click must
  // surface a WidthPicker via the diagram cells, not the read-only empty
  // state (see-but-cannot-edit).
  function packetViewerEnv(src: (typeof PRESETS)[string]) {
    const env = new Map<string, number>();
    for (const [k, v] of initialEnv(src!)) env.set(k, v);
    for (const r of collectPsdlRefs(src!)) if (!env.has(r)) env.set(r, 0);
    seedDynamicWidthDefaults(src!, env);
    return env;
  }

  it("surfaces a varint width picker for a switch-case-nested leaf (quicLong tokenLength) (#width)", async () => {
    const src = PRESETS.quicLong!;
    const packet = psdlToRenderer(src);
    // No mirror field exists for the switch-nested leaf...
    expect(packet.fields.some((f) => f.id === "tokenLength")).toBe(false);
    // ...but the seeded env makes it a visible diagram cell.
    const { cells } = resolveLayout(src, { env: packetViewerEnv(src) });
    expect(cells.some((c) => c.field.id === "tokenLength")).toBe(true);

    const onChange = vi.fn();
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId="tokenLength"
        controllers={{ tokenLength: 8 }}
        onControllerChange={onChange}
        cells={cells}
      />,
    );
    expect(container.textContent ?? "").not.toMatch(/no runtime override/i);
    const group = container.querySelector('[role="radiogroup"]');
    expect(
      group,
      "switch-nested varint must surface a width radiogroup",
    ).not.toBeNull();
    expect(container.textContent ?? "").toMatch(/Varint width \(quic\)/i);
    const buttons = Array.from(
      group!.querySelectorAll('[role="radio"]'),
    ) as HTMLButtonElement[];
    // quic ladder is bits; the seeded 8 bits shows "1B".
    expect(buttons.map((b) => b.textContent)).toContain("1B");
    const thirtyTwo = buttons.find((b) => b.textContent === "4B")!;
    await act(async () => {
      thirtyTwo.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("tokenLength", 32);
  });

  it("surfaces a BER length width picker for a repeat-nested leaf (kerberosAsReq padataCtxLength) (#width)", async () => {
    const src = PRESETS.kerberosAsReq!;
    const packet = psdlToRenderer(src);
    expect(packet.fields.some((f) => f.id === "padataCtxLength")).toBe(false);
    const { cells } = resolveLayout(src, { env: packetViewerEnv(src) });
    expect(cells.some((c) => c.field.id === "padataCtxLength")).toBe(true);

    const onChange = vi.fn();
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId="padataCtxLength"
        controllers={{}}
        onControllerChange={onChange}
        cells={cells}
      />,
    );
    expect(container.textContent ?? "").not.toMatch(/no runtime override/i);
    const group = container.querySelector('[role="radiogroup"]');
    expect(
      group,
      "repeat-nested berLength must surface a width radiogroup",
    ).not.toBeNull();
    expect(container.textContent ?? "").toMatch(/BER length width/i);
  });
});
