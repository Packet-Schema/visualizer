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

  it("gates dnsResponse's RDLENGTH slider in the seeded A-record arm (inert), enables it for CNAME", async () => {
    // dnsResponse seeds dnsRrType=1 (an A record), whose RDATA is a FIXED 32-bit
    // address — the dnsRdLength slider sizes the value only for the
    // CNAME/NS/PTR/MX/TXT/SRV/RAW arms. The RDLENGTH header octet is ALWAYS in
    // the diagram, so the older `fieldRendered`-only gate (the controller's OWN
    // cell renders) wrongly showed the slider as live even though sweeping it
    // moves ZERO cell widths in the A arm. The strengthened gate probes whether
    // perturbing the value changes any rendered cell (PacketViewer's
    // `inertLengthControllers` re-resolve), so the slider is disabled with a hint
    // pointing at the RDATA-variant picker in the A arm, and live once a
    // length-sized arm (CNAME) is selected.
    const src = PRESETS.dnsResponse!;
    const packet = psdlToRenderer(src);
    const lc = (packet.lengthControllers ?? []).find(
      (c) => c.controlsLength && c.controlsLength.startsWith("dnsRdLength"),
    );
    expect(
      lc,
      "dnsResponse must surface the dnsRdLength length controller",
    ).toBeDefined();

    // The same probe PacketViewer runs: a length controller is INERT when
    // perturbing its value (through the SAME env pipeline) leaves the total
    // layout bits unchanged while its field is in the diagram.
    function inertSet(overrides: Record<string, number>): Set<string> {
      const { env, controllers } = loadEnv(src, overrides);
      const base = resolveLayout(src, { env });
      const inert = new Set<string>();
      for (const c of packet.lengthControllers ?? []) {
        const key = c.controlsLength;
        if (!key) continue;
        if (!base.cells.some((cell) => cell.field.id.startsWith(`${key}`)))
          continue;
        const current = Number(controllers[key] ?? 0);
        const probeValue = current === 0 ? 8 : Math.max(0, current - 1);
        if (probeValue === current) continue;
        const probedEnv = new Map(env);
        probedEnv.set(key, probeValue);
        try {
          const probed = resolveLayout(src, { env: probedEnv });
          if (probed.totalBits === base.totalBits) inert.add(key);
        } catch {
          /* a throw means the structure changed → live */
        }
      }
      return inert;
    }

    // Seeded A-record arm (dnsRrType=1): inert → slider disabled with the
    // variant-picker hint.
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
          inertLengthControllers={inertSet({})}
        />,
      );
      const slider = lengthSlider(container, lc!.id);
      expect(slider, "dnsRdLength slider must render").not.toBeNull();
      expect(
        slider!.disabled,
        "must be gated in the fixed-width A-record arm",
      ).toBe(true);
      expect(container.textContent ?? "").toMatch(/sized by dnsRdLength/i);
    }

    // CNAME arm (dnsRrType=5): the value IS sized by RDLENGTH → live slider.
    {
      const overrides = { dnsRrType: 5 };
      const { env, controllers } = loadEnv(src, overrides);
      const { cells } = resolveLayout(src, { env });
      const { container } = await mount(
        <OverridePanel
          packet={packet}
          selectedFieldId={null}
          controllers={controllers}
          onControllerChange={() => {}}
          cells={cells}
          inertLengthControllers={inertSet(overrides)}
        />,
      );
      const slider = lengthSlider(container, lc!.id);
      expect(slider, "dnsRdLength slider must render").not.toBeNull();
      expect(
        slider!.disabled,
        "must be live in the CNAME arm whose value is sized by RDLENGTH",
      ).toBe(false);
    }
  });
});
