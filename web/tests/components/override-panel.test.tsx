// @vitest-environment jsdom
//
// OverridePanel smoke — mounts the panel directly with curated preset
// fixtures and asserts each widget renders for its target field type.

import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import OverridePanel from "@/components/field-details/OverridePanel";
import { PRESETS } from "@/lib/psdl/presets.server";
import {
  psdlToRenderer,
  applyByteOrderOverrides,
} from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import {
  seedDynamicWidthDefaults,
  DELIMITED_DEFAULT_BYTES,
} from "@/lib/psdl/dynamic-width-defaults";
import { initialState } from "@/lib/psdl/renderer-helpers";

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
  it("renders an OverrideSlider for a length controller (isisLsp pduLength)", async () => {
    // isisLsp's `pduLength` budgets a NON-tlv bounded repeat, so it keeps its
    // length slider. (IPv4 IHL no longer surfaces a slider — its options region
    // is a TLV-shaped bounded scope owned by the `options` TLV editor; see the
    // suppression test below.)
    const packet = psdlToRenderer(PRESETS.isisLsp!);
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId="pduLength"
        controllers={{ pduLength: 27 }}
        onControllerChange={() => {}}
      />,
    );
    expect(
      container.querySelector('input[type="range"]'),
      "pduLength must surface a range slider",
    ).not.toBeNull();
  });

  it("does NOT render an OverrideSlider for IHL on IPv4 (TLV editor owns options)", async () => {
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
      "IHL must NOT surface a misleading length slider",
    ).toBeNull();
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
    // A1: the click must resolve via the diagram cells (no dead-end), not
    // "Field not found".
    expect(text).not.toMatch(/Field not found/);
    // dnsRrType is an enum (RR Type) leaf, so the resolved cell now carries
    // `enumVariants` (layout stamps them) and surfaces an editable dropdown
    // rather than the read-only fallback — see-but-cannot-edit fixed.
    const select = container.querySelector("select");
    expect(select, "enum leaf must surface a <select>").not.toBeNull();
    expect(text).not.toMatch(/no runtime override/i);
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
    // Drive the panel from the REAL bootstrap controllers (`initialState`), not a
    // hardcoded value — otherwise the regression below (picker highlights 1B
    // while the diagram shows the seeded 4-byte cell) would be masked.
    const controllers = initialState(packet);
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId="hostname"
        controllers={controllers}
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

  it("bootstrap controllers seed the delimited default so the WidthPicker matches the diagram cell (panel must not contradict diagram on load)", async () => {
    const packet = psdlToRenderer(PRESETS.syslog!);
    const delimited = packet.fields.filter((f) => f.isDelimited);
    expect(delimited.length).toBeGreaterThan(0);

    // The renderer-mirror bootstrap must seed the SAME default the diagram layout
    // seeds, so every delimited field's controller is the visible byte count
    // (NOT undefined → pickerWidths[0]=1B, which contradicted the diagram).
    const controllers = initialState(packet);
    for (const f of delimited) {
      expect(
        controllers[f.id],
        `${f.id} must be seeded in bootstrap controllers`,
      ).toBe(DELIMITED_DEFAULT_BYTES);
    }

    // Cross-check against the actual diagram: the seeded layout cell width (in
    // bytes) equals the picker's active byte count, for the same env the
    // bootstrap controllers represent.
    const env = packetViewerEnv(PRESETS.syslog!);
    const layout = resolveLayout(PRESETS.syslog!, { env });
    const cell = layout.cells.find((c) => c.field.id === "hostname");
    expect(cell, "hostname cell must be present in the diagram").toBeDefined();
    expect(cell!.bitsTotal / 8).toBe(DELIMITED_DEFAULT_BYTES);

    const onChange = vi.fn();
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId="hostname"
        controllers={controllers}
        onControllerChange={onChange}
      />,
    );
    const buttons = Array.from(
      container.querySelectorAll('[role="radio"]'),
    ) as HTMLButtonElement[];
    const active = buttons.find(
      (b) => b.getAttribute("aria-checked") === "true",
    );
    // The highlighted option must match the diagram cell (4B), NOT the 1B
    // pickerWidths[0] fallback the unseeded controllers used to produce.
    expect(active?.textContent).toBe(`${cell!.bitsTotal / 8}B`);
    expect(active?.textContent).toBe("4B");
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

  // A delimiter-terminated (NUL-terminated) `bytes` leaf that lives INSIDE a
  // switch case is the delimited counterpart of the varint/berLength cases
  // above. tftp's RRQ/WRQ/ERROR arms declare rrqFilename / rrqMode / wrqFilename
  // / wrqMode / errMsg, none of which become renderer mirror fields (they live
  // in the `opcode` switch cases). seedDynamicWidthDefaults seeds them to a
  // visible default and resolveLayout stamps `isDelimited` onto the synthetic
  // cell, so a click must surface an editable byte-count width via the diagram
  // cells — not the read-only empty state (#3, switch-case delimited bytes).
  it("surfaces a delimited width picker for switch-case-nested bytes (tftp rrqFilename/rrqMode) (#3)", async () => {
    const src = PRESETS.tftp!;
    const packet = psdlToRenderer(src);
    // The delimited Filename/Mode leaves live inside the `opcode` switch cases,
    // so they are NOT top-level mirror fields and NOT length controllers.
    expect(packet.fields.some((f) => f.id === "rrqFilename")).toBe(false);
    expect(packet.fields.some((f) => f.id === "rrqMode")).toBe(false);
    expect(
      (packet.lengthControllers ?? []).some(
        (f) => f.id === "rrqFilename" || f.id === "rrqMode",
      ),
    ).toBe(false);

    // Selecting RRQ (opcode = 1) materialises the Filename + Mode cells, each
    // seeded to a visible 4-byte default and flagged delimited by the layout.
    const env = packetViewerEnv(src);
    env.set("opcode", 1);
    const { cells } = resolveLayout(src, { env });
    for (const id of ["rrqFilename", "rrqMode"]) {
      const cell = cells.find((c) => c.field.id === id);
      expect(cell, `${id} cell must be present at opcode=1`).toBeTruthy();
      expect(
        cell!.field.isDelimited,
        `layout must stamp isDelimited onto ${id}`,
      ).toBe(true);
    }

    for (const id of ["rrqFilename", "rrqMode"]) {
      const onChange = vi.fn();
      const { container } = await mount(
        <OverridePanel
          packet={packet}
          selectedFieldId={id}
          controllers={{ [id]: 4 }}
          onControllerChange={onChange}
          cells={cells}
        />,
      );
      // Must NOT fall through to the read-only empty state...
      expect(container.textContent ?? "").not.toMatch(/no runtime override/i);
      // ...and must render the delimited byte-count radiogroup.
      const group = container.querySelector('[role="radiogroup"]');
      expect(
        group,
        `${id} delimited bytes must surface a width radiogroup`,
      ).not.toBeNull();
      expect(container.textContent ?? "").toMatch(/Delimited length/i);
      const buttons = Array.from(
        group!.querySelectorAll('[role="radio"]'),
      ) as HTMLButtonElement[];
      // Delimited stores a byte count, so the seeded 4 shows as "4B" and is the
      // active option.
      const active = buttons.find(
        (b) => b.getAttribute("aria-checked") === "true",
      );
      expect(active?.textContent).toBe("4B");
      // Picking a different option writes a BYTE count under the bare field id
      // (the env key the layout reads via __bytesDelimLen__).
      const eight = buttons.find((b) => b.textContent === "8B")!;
      await act(async () => {
        eight.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(onChange).toHaveBeenCalledWith(id, 8);
    }
  });

  // Regression: the bootstrap `controllers` (`initialState`) must seed the SAME
  // delimited default the diagram layout seeds, for switch-case-nested delimited
  // leaves that are NOT mirror fields (tftp's rrqFilename/rrqMode/wrqFilename/
  // wrqMode/errMsg). Without it the WidthPicker's `current = controllers[id] ??
  // widths[0]` falls to 1 byte and highlights "1B" while the diagram already
  // shows the seeded ~4-byte cell -- a panel-vs-diagram contradiction on load.
  // Drive the panel from the REAL `initialState` (NOT a hand-injected
  // controller) so the production bootstrap path is what's under test.
  it("bootstrap controllers seed the delimited default for switch-case-nested leaves so the WidthPicker matches the diagram on load (tftp rrqFilename) (#3/#11)", async () => {
    const src = PRESETS.tftp!;
    const packet = psdlToRenderer(src);
    // These leaves live inside the `opcode` switch cases, so they are NOT mirror
    // fields nor length controllers (the prior test asserts that).
    const state = initialState(packet);
    for (const id of [
      "rrqFilename",
      "rrqMode",
      "wrqFilename",
      "wrqMode",
      "errMsg",
    ]) {
      expect(
        state[id],
        `initialState must seed controllers[${id}] to the delimited default`,
      ).toBe(DELIMITED_DEFAULT_BYTES);
    }

    // The diagram seeds the SAME width: rrqFilename renders at 4 bytes at load.
    const env = packetViewerEnv(src);
    env.set("opcode", 1);
    const { cells } = resolveLayout(src, { env });
    const cell = cells.find((c) => c.field.id === "rrqFilename");
    expect(cell, "rrqFilename cell must be present at opcode=1").toBeTruthy();
    expect(cell!.bitsTotal / 8).toBe(DELIMITED_DEFAULT_BYTES);

    // Drive the WidthPicker from the bootstrap controllers -- the "4B" option
    // must be the ACTIVE one, matching the diagram (no manual controller seed).
    const onChange = vi.fn();
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId="rrqFilename"
        controllers={state}
        onControllerChange={onChange}
        cells={cells}
      />,
    );
    const group = container.querySelector('[role="radiogroup"]');
    expect(group, "rrqFilename must surface a width radiogroup").not.toBeNull();
    const buttons = Array.from(
      group!.querySelectorAll('[role="radio"]'),
    ) as HTMLButtonElement[];
    const active = buttons.find(
      (b) => b.getAttribute("aria-checked") === "true",
    );
    expect(
      active?.textContent,
      "active option must be the seeded 4B, not the widths[0] 1B fallback",
    ).toBe(`${DELIMITED_DEFAULT_BYTES}B`);
  });

  it("surfaces an EnumDropdown for a repeat-nested enum leaf (dnsResponse dnsQType) (#enum)", async () => {
    // see-but-cannot-edit: a plain enum leaf inside a repeat record never
    // becomes a renderer mirror field, so a click resolves through
    // resolveFromCells to the synthetic layout cell. layout.ts must stamp
    // `enumVariants` onto that cell so OverridePanel's EnumDropdown fires —
    // exactly as it does for a top-level enum (arp.oper, dhcpv4.op).
    const src = PRESETS.dnsResponse!;
    const packet = psdlToRenderer(src);
    // No mirror field exists for the repeat-nested enum leaf...
    expect(packet.fields.some((f) => f.id === "dnsQType")).toBe(false);
    // ...but a query record (dnsQdCount=1) makes it a visible diagram cell.
    const env = packetViewerEnv(src);
    env.set("dnsQdCount", 1);
    const { cells } = resolveLayout(src, { env });
    const cell = cells.find((c) => c.field.id === "dnsQType#0");
    expect(cell, "dnsQType cell must be present").toBeTruthy();
    expect(
      cell!.field.enumVariants,
      "layout must stamp enumVariants onto the synthetic cell field",
    ).toBeTruthy();

    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId="dnsQType#0"
        controllers={{}}
        onControllerChange={() => {}}
        cells={cells}
      />,
    );
    expect(container.textContent ?? "").not.toMatch(/no runtime override/i);
    const select = container.querySelector("select");
    expect(select, "repeat-nested enum must surface a <select>").not.toBeNull();
    expect(select?.options.length).toBeGreaterThan(0);
  });

  it("a per-record enum dropdown writes the BARE authored env key, not a #N-suffixed phantom (rtcpSdes)", async () => {
    // see-but-cannot-edit: a field authored inside a plain repeat surfaces on
    // the diagram as a cell whose id carries a per-instance repeat suffix
    // (`#i_j`). resolveLayout reads that field from its BARE authored env key
    // (layout.ts stripRepeatTag), so a widget MUST drive the bare key — writing
    // env[rtcpSdesItemType#0_0] is a phantom the layout never reads, leaving the
    // dropdown inert. fieldAsTarget must strip the suffix so the EnumDropdown
    // fires onControllerChange("rtcpSdesItemType", v).
    const src = PRESETS.rtcpSdes!;
    const packet = psdlToRenderer(src);
    // No mirror field exists for the repeat-nested enum leaf...
    expect(packet.fields.some((f) => f.id === "rtcpSdesItemType")).toBe(false);
    // ...but materialising a SDES chunk + items makes it a visible diagram cell.
    const env = packetViewerEnv(src);
    env.set("sc", 1);
    env.set("rtcpSdesItems", 2);
    env.set("rtcpSdesItemLen", 4);
    const { cells } = resolveLayout(src, { env });
    const cell = cells.find((c) => c.field.id.startsWith("rtcpSdesItemType#"));
    expect(cell, "rtcpSdesItemType repeat cell must be present").toBeTruthy();
    // The cell id carries a `#i_j` repeat suffix (the phantom-key trap).
    expect(cell!.field.id).toMatch(/#\d+(?:_\d+)*$/);
    expect(
      cell!.field.enumVariants,
      "enum variants must be stamped",
    ).toBeTruthy();

    const writes: Array<[string, number]> = [];
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId={cell!.field.id}
        controllers={{}}
        onControllerChange={(k, v) => writes.push([k, v])}
        cells={cells}
      />,
    );
    const select = container.querySelector("select");
    expect(
      select,
      "per-record enum leaf must surface a <select>",
    ).not.toBeNull();

    // Picking a variant must write the BARE key the layout reads, never a
    // #-suffixed phantom.
    select!.value = "2";
    await act(async () => {
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(writes).toContainEqual(["rtcpSdesItemType", 2]);
    expect(writes.every(([k]) => !k.includes("#"))).toBe(true);
  });

  it("surfaces ONLY the NDP option stepper for the selected `type`=133 arm (gate)", async () => {
    // icmpv6Ndp's five Options steppers (rsOptions/raOptions/…) each live in a
    // distinct `type` case. The panel must surface only the one whose gate the
    // discriminator currently selects, so the surfaced count never contradicts
    // the rendered arm. With `type`=133 (Router Solicitation) only the
    // "Type=133 → Options" stepper shows; the other four are hidden.
    const packet = psdlToRenderer(PRESETS.icmpv6Ndp!);
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId={null}
        controllers={{ type: 133, rsOptions: 1 }}
        onControllerChange={() => {}}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toMatch(/Type=133/);
    expect(text).not.toMatch(/Type=134/);
    expect(text).not.toMatch(/Type=135/);
    expect(text).not.toMatch(/Type=137/);
  });

  it("swaps the live NDP option stepper when `type`=135 is selected (gate)", async () => {
    const packet = psdlToRenderer(PRESETS.icmpv6Ndp!);
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId={null}
        controllers={{ type: 135, nsOptions: 1 }}
        onControllerChange={() => {}}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toMatch(/Type=135/);
    expect(text).not.toMatch(/Type=133/);
  });

  // see-but-cannot-edit: a Field with an explicit `byteOrder` that lives inside
  // a Switch case / plain Repeat never becomes a renderer mirror field (it is
  // only a diagram Cell carrying `cell.byteOrder`). core stamps the marker onto
  // the cell but NOT onto `cell.field.byteOrder`, so the old
  // `if (field.byteOrder && onByteOrderChange)` gate was always false and the
  // BE/LE toggle never rendered. rtmp's `messageStreamId` (inside the `fmt`
  // switch, byteOrder LE) is the canonical case: the diagram shows
  // `messageStreamId[LE]` but it was uneditable.
  it("surfaces a BE/LE toggle for a switch-case-nested explicit-byteOrder field (rtmp messageStreamId) (#byteOrder)", async () => {
    const src = PRESETS.rtmp!;
    const packet = psdlToRenderer(src);
    // No mirror field exists for the switch-nested LE leaf...
    expect(packet.fields.some((f) => f.id === "messageStreamId")).toBe(false);
    // ...but it IS a visible diagram cell carrying the LE marker.
    const { cells } = resolveLayout(src, {});
    const cell = cells.find((c) => c.field.id === "messageStreamId");
    expect(cell, "messageStreamId cell must be present").toBeTruthy();
    expect(cell!.byteOrder, "cell must carry the LE marker").toBe("LE");
    expect(
      cell!.field.byteOrder,
      "core never copies byteOrder onto cell.field",
    ).toBeUndefined();

    let flipped: { id: string; order: "BE" | "LE" } | null = null;
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId="messageStreamId"
        controllers={{}}
        onControllerChange={() => {}}
        onByteOrderChange={(id, order) => {
          flipped = { id, order };
        }}
        cells={cells}
      />,
    );
    // The panel must NOT fall through to the read-only empty state...
    expect(container.textContent ?? "").not.toMatch(/no runtime override/i);
    // ...and must render a BE/LE radiogroup with LE currently active.
    const radios = Array.from(
      container.querySelectorAll('button[role="radio"]'),
    ) as HTMLButtonElement[];
    const labels = radios.map((r) => r.textContent);
    expect(labels).toContain("BE");
    expect(labels).toContain("LE");
    const activeLe = radios.find(
      (r) =>
        r.textContent === "LE" && r.getAttribute("aria-checked") === "true",
    );
    expect(activeLe, "LE must be the active byte order").toBeTruthy();

    // Clicking BE must fire onByteOrderChange with the field's BARE id.
    const beButton = radios.find((r) => r.textContent === "BE")!;
    await act(async () => {
      beButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(flipped).toEqual({ id: "messageStreamId", order: "BE" });
  });

  // The flip must actually move the diagram: recording it on the mirror's
  // `byteOrderOverrides` map and re-stamping the PSDL via
  // `applyByteOrderOverrides` flips the resolved cell's byteOrder.
  it("a recorded byteOrder override re-stamps the diagram cell (rtmp messageStreamId LE→BE)", () => {
    const src = PRESETS.rtmp!;
    const mirror = psdlToRenderer(src);
    const before = resolveLayout(applyByteOrderOverrides(src, mirror), {});
    expect(
      before.cells.find((c) => c.field.id === "messageStreamId")?.byteOrder,
    ).toBe("LE");

    const flipped = {
      ...mirror,
      byteOrderOverrides: { messageStreamId: "BE" },
    };
    const after = resolveLayout(
      applyByteOrderOverrides(src, flipped as typeof mirror),
      {},
    );
    expect(
      after.cells.find((c) => c.field.id === "messageStreamId")?.byteOrder,
    ).toBe("BE");
    // A mirror with no overrides returns the same PSDL reference (cheap no-op).
    expect(applyByteOrderOverrides(src, mirror)).toBe(src);
  });
});
