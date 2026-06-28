// @vitest-environment jsdom
//
// Regression: the empty-state OverridePanel used to list EVERY length controller
// under "Length controllers" as a LIVE slider, even when the field it sizes is
// NOT in the current diagram. Many controlled fields only exist inside an
// un-selected switch arm / a not-yet-instantiated record, so the slider did
// nothing for any value until the user first changed a DIFFERENT control (the
// discriminator / record count). A node probe across all 184 presets found 80
// such surfaced sliders whose controlled field is absent from the default
// diagram (socks5.socksDomainLen, snmpv3.*, mqttConnect.*, capwap.*, …).
//
// Concrete example (socks5): the "Domain Length" slider (socksDomainLen) is
// shown live, but socksAtyp defaults to the IPv4 arm so dstAddrDomain /
// socksDomainLen are not in the diagram — driving the slider 0..128 leaves the
// diagram byte-identical. Only ATYP=domain (socksAtyp=3) materialises the field.
//
// Fix: gate each length-controller slider exactly like the refSwitch "Record
// variants" picker — disable it with a hint unless its controlled field is a
// materialised diagram cell (`fieldRendered(cells, controlsLength)`). This is
// the same inert/misleading-control class, keyed on the same layout-faithful
// signal (`cells` IS the live diagram).

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import OverridePanel from "@/components/field-details/OverridePanel";
import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { initialState } from "@/lib/psdl/renderer-helpers";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

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
  if (activeRoot && activeContainer) {
    await act(async () => {
      activeRoot!.unmount();
    });
    activeContainer.remove();
    activeRoot = null;
    activeContainer = null;
  }
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

/** The load-time env exactly as PacketViewer builds it (mirrors the refSwitch
 *  live-gate test): mirror `initialState` seeds, packet defaults, a 0 fallback
 *  for every remaining ref, then the explicit overrides on top. */
function loadEnv(
  src: PsdlPacket,
  overrides: Record<string, number> = {},
): { env: Map<string, number>; controllers: Record<string, number> } {
  const mirror = psdlToRenderer(src);
  const controllers: Record<string, number> = Object.fromEntries(
    Object.entries(initialState(mirror)).map(([k, v]) => [k, Number(v)]),
  );
  const env = new Map<string, number>(Object.entries(controllers));
  for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
  for (const [k, v] of Object.entries(overrides)) {
    env.set(k, v);
    controllers[k] = v;
  }
  return { env, controllers };
}

/** The length-controller slider's range input (id pattern from OverrideSlider:
 *  `detail-ctrl-<fieldId>-slider`). */
function lengthSlider(
  container: HTMLElement,
  fieldId: string,
): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(
    `#detail-ctrl-${fieldId}-slider`,
  );
}

describe("length-controller live gating", () => {
  it("disables socks5's Domain Length slider on load (IPv4 arm), enables it once ATYP=domain", async () => {
    const src = PRESETS.socks5!;
    const packet = psdlToRenderer(src);

    // socks5 has exactly one length controller: socksDomainLen sizes the domain
    // address, which only exists in the ATYP=domain (socksAtyp=3) switch arm.
    const lc = (packet.lengthControllers ?? []).find(
      (c) => c.controlsLength === "socksDomainLen",
    );
    expect(
      lc,
      "socks5 must surface the socksDomainLen length controller",
    ).toBeDefined();

    // On load (socksAtyp defaults to the IPv4 arm) the domain field is NOT in the
    // diagram, so the slider is disabled with a hint — not a live, inert control.
    {
      const { env, controllers } = loadEnv(src);
      const { cells } = resolveLayout(src, { env });
      // Sanity: the controlled field really is absent at default.
      expect(cells.some((c) => c.field.id.startsWith("socksDomainLen"))).toBe(
        false,
      );
      const { container } = await mount(
        <OverridePanel
          packet={packet}
          selectedFieldId={null}
          controllers={controllers}
          onControllerChange={() => {}}
          cells={cells}
        />,
      );
      const slider = lengthSlider(container, "socksDomainLen");
      expect(slider, "Domain Length slider must render").not.toBeNull();
      expect(slider!.disabled, "must be disabled on the IPv4 arm").toBe(true);
      expect(container.textContent ?? "").toMatch(/to edit socksDomainLen/i);
    }

    // Selecting ATYP=domain (socksAtyp=3) materialises socksDomainLen → the
    // slider becomes live (a data-driven gate, not a blanket disable).
    {
      const { env, controllers } = loadEnv(src, { socksAtyp: 3 });
      const { cells } = resolveLayout(src, { env });
      expect(cells.some((c) => c.field.id.startsWith("socksDomainLen"))).toBe(
        true,
      );
      const { container } = await mount(
        <OverridePanel
          packet={packet}
          selectedFieldId={null}
          controllers={controllers}
          onControllerChange={() => {}}
          cells={cells}
        />,
      );
      const slider = lengthSlider(container, "socksDomainLen");
      expect(slider, "Domain Length slider must render").not.toBeNull();
      expect(slider!.disabled, "must be live once ATYP=domain").toBe(false);
    }
  });

  it("gates dnsResponse's RDLENGTH slider on the ACTIVE RR-type arm, not just the rendered octet", async () => {
    // dnsResponse.dnsRdLength's octet renders in every RR record, but it only
    // SIZES a value in the RDATA switch arms that use `bytes(ref dnsRdLength)`
    // (NS / CNAME / PTR / MX / SRV / TXT / unknown). The default RR is an A
    // record (dnsRrType=1) whose RDATA is a fixed 32-bit address — dnsRdLength
    // sizes nothing there, so the slider must be DISABLED (live-but-inert
    // otherwise). Two gates now catch this: the static `lengthSizesFieldIds`
    // value-render check (none of the sized arms rendered → inert) AND, as a
    // backstop, PacketViewer's `inertLengthControllers` re-resolve probe.
    // Selecting NS (dnsRrType=2) materialises a `bytes(ref dnsRdLength)` value,
    // so the slider becomes live.
    const src = PRESETS.dnsResponse!;
    const packet = psdlToRenderer(src);
    const lc = (packet.lengthControllers ?? []).find(
      (c) => c.controlsLength === "dnsRdLength",
    );
    if (!lc) return; // preset shape changed — nothing to assert
    expect(
      lc.lengthSizesFieldIds && lc.lengthSizesFieldIds.length > 0,
      "dnsRdLength must record the switch-arm values it sizes",
    ).toBe(true);

    // Default (A record): the slider is disabled with a hint — inert here.
    {
      const { env, controllers } = loadEnv(src);
      const { cells } = resolveLayout(src, { env });
      const { container } = await mount(
        <OverridePanel
          packet={packet}
          selectedFieldId={null}
          controllers={controllers}
          onControllerChange={() => {}}
          cells={cells}
        />,
      );
      const slider = lengthSlider(container, lc.id);
      expect(slider, "dnsRdLength slider must render").not.toBeNull();
      expect(
        slider!.disabled,
        "must be disabled on the A-record arm (RDATA is a fixed address)",
      ).toBe(true);
    }

    // NS record (dnsRrType=2): NSDNAME = bytes(ref dnsRdLength) → slider is live.
    {
      const { env, controllers } = loadEnv(src, { dnsRrType: 2 });
      const { cells } = resolveLayout(src, { env });
      const { container } = await mount(
        <OverridePanel
          packet={packet}
          selectedFieldId={null}
          controllers={controllers}
          onControllerChange={() => {}}
          cells={cells}
        />,
      );
      const slider = lengthSlider(container, lc.id);
      expect(slider, "dnsRdLength slider must render").not.toBeNull();
      expect(
        slider!.disabled,
        "must be live once an RDATA arm consumes dnsRdLength (NS)",
      ).toBe(false);
    }
  });

  it("gates pimHelloOptions' Option Length slider on the ACTIVE option arm (Holdtime inert, Address List live)", async () => {
    // pimHelloOptLen's 16-bit Length octet renders in EVERY Hello option arm
    // (it's a sibling BEFORE the value `switch`), but it only sizes a value in
    // arms 24 (Address List → addrListData) and `_` (unknown). The seeded option
    // type is 1 (Holdtime), whose value is a fixed 16-bit int — the slider is
    // live-looking but byte-for-byte inert there (sweeping it changes nothing).
    // The gate must key on whether a value arm consuming the length is rendered,
    // not on the always-present Length octet.
    const src = PRESETS.pimHelloOptions!;
    const packet = psdlToRenderer(src);
    const lc = (packet.lengthControllers ?? []).find(
      (c) => c.controlsLength === "pimHelloOptLen",
    );
    expect(
      lc,
      "pimHelloOptions must surface the pimHelloOptLen length controller",
    ).toBeDefined();
    expect(
      lc!.lengthSizesFieldIds?.includes("addrListData"),
      "pimHelloOptLen must record addrListData as a value it sizes",
    ).toBe(true);

    // Seeded Holdtime arm (pimHelloOptType=1): value htHoldtime is fixed-width,
    // so the slider is disabled with a hint instead of a live-but-inert control.
    {
      const { env, controllers } = loadEnv(src, { pimHelloOptType: 1 });
      const { cells } = resolveLayout(src, { env });
      // Sanity: addrListData is absent on the Holdtime arm.
      expect(cells.some((c) => c.field.id.startsWith("addrListData"))).toBe(
        false,
      );
      const { container } = await mount(
        <OverridePanel
          packet={packet}
          selectedFieldId={null}
          controllers={controllers}
          onControllerChange={() => {}}
          cells={cells}
        />,
      );
      const slider = lengthSlider(container, "pimHelloOptLen");
      expect(slider, "Option Length slider must render").not.toBeNull();
      expect(
        slider!.disabled,
        "must be disabled on the Holdtime arm (htHoldtime is fixed-width)",
      ).toBe(true);
      expect(container.textContent ?? "").toMatch(/to edit pimHelloOptLen/i);
    }

    // Address List arm (pimHelloOptType=24): addrListData = bytes(ref
    // pimHelloOptLen) → the slider becomes live and grows the value.
    {
      const { env, controllers } = loadEnv(src, { pimHelloOptType: 24 });
      const { cells } = resolveLayout(src, { env });
      expect(cells.some((c) => c.field.id.startsWith("addrListData"))).toBe(
        true,
      );
      const { container } = await mount(
        <OverridePanel
          packet={packet}
          selectedFieldId={null}
          controllers={controllers}
          onControllerChange={() => {}}
          cells={cells}
        />,
      );
      const slider = lengthSlider(container, "pimHelloOptLen");
      expect(slider, "Option Length slider must render").not.toBeNull();
      expect(
        slider!.disabled,
        "must be live once ATYP=Address List consumes pimHelloOptLen",
      ).toBe(false);
    }
  });
});
