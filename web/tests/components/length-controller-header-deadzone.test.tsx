// @vitest-environment jsdom
//
// Regression: PacketViewer's `inertLengthControllers` probe used to perturb a
// length controller by a SINGLE step (`current===0 ? 8 : current-1`) and mark
// the slider inert when `layout.totalBits` did not move. For total-length-
// INCLUSIVE fields backed by a `bounded` scope `bytes = lengthField - header`
// (diameter `avpLength`, ikev2Sa `ikev2ProposalLength`, pcep `pcepObjectLength`)
// that single step lands inside the header "deadzone": the budget is still <=0,
// no value bytes appear, totalBits is unchanged — so the ONLY control that can
// reveal the (visible) value region was greyed out at load. A see-but-cannot-
// edit defect, plus a hard-coded DNS-only hint that contradicted these packets.
//
// Fix: the probe also tries a large representative jump (+64B) that escapes any
// plausible fixed header and treats the controller as LIVE if EITHER probe
// changes totalBits. This test replicates the (fixed) probe and asserts the
// three total-length-inclusive sliders are NOT flagged inert, that raising the
// length grows the value region, and that the disabled hint is no longer the
// nonsensical DNS-RDATA string.

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

/** The load-time env exactly as PacketViewer builds it (mirror `initialState`
 *  seeds, packet defaults, a 0 fallback for every remaining ref). */
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

/** Replicates PacketViewer's (fixed) `inertLengthControllers` probe for a single
 *  controller key: probes a small step AND a large +64B jump, LIVE if either
 *  changes totalBits. */
function isInert(src: PsdlPacket, key: string): boolean {
  const { env, controllers } = loadEnv(src);
  const base = resolveLayout(src, { env });
  const current = Number(controllers[key] ?? 0);
  const probeValues = [
    current === 0 ? 8 : Math.max(0, current - 1),
    current + 64,
  ];
  for (const probeValue of probeValues) {
    if (probeValue === current) continue;
    const { env: probedEnv } = loadEnv(src, { [key]: probeValue });
    try {
      const probed = resolveLayout(src, { env: probedEnv });
      if (probed.totalBits !== base.totalBits) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function lengthSlider(
  container: HTMLElement,
  fieldId: string,
): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(
    `#detail-ctrl-${fieldId}-slider`,
  );
}

describe("length-controller header-deadzone probe", () => {
  const CASES: Array<{ preset: string; key: string }> = [
    { preset: "diameter", key: "avpLength" },
    { preset: "ikev2Sa", key: "ikev2ProposalLength" },
    { preset: "pcep", key: "pcepObjectLength" },
  ];

  for (const { preset, key } of CASES) {
    it(`${preset}: ${key} is LIVE at load (probe escapes the header deadzone) and grows the value region`, () => {
      const src = PRESETS[preset]!;
      expect(src, `${preset} preset must exist`).toBeDefined();

      // The single-step probe alone lands in the header deadzone; the fixed
      // multi-value probe must NOT flag the controller inert.
      expect(
        isInert(src, key),
        `${key} must not be flagged inert at load`,
      ).toBe(false);

      // And raising the length past the header MUST grow the diagram, i.e. the
      // value region is genuinely editable through this control.
      const { env: lowEnv } = loadEnv(src);
      const low = resolveLayout(src, { env: lowEnv });
      const { env: highEnv } = loadEnv(src, { [key]: 64 });
      const high = resolveLayout(src, { env: highEnv });
      expect(
        high.totalBits,
        `${key}=64 must add value bytes beyond the load baseline`,
      ).toBeGreaterThan(low.totalBits);
    });
  }

  it("the disabled hint is generic, never the hard-coded DNS-RDATA string", async () => {
    // Render OverridePanel for a non-DNS packet WITH the controller marked inert
    // (forcing the hint path). The hint must reference the field generically and
    // must NOT mention DNS RDATA variants — which would contradict the diagram.
    const src = PRESETS.diameter!;
    const packet = psdlToRenderer(src);
    const lc = (packet.lengthControllers ?? []).find(
      (c) => c.controlsLength === "avpLength",
    );
    expect(
      lc,
      "diameter must surface the avpLength length controller",
    ).toBeDefined();

    const { env, controllers } = loadEnv(src);
    const { cells } = resolveLayout(src, { env });
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId={null}
        controllers={controllers}
        onControllerChange={() => {}}
        cells={cells}
        inertLengthControllers={new Set(["avpLength"])}
      />,
    );
    const slider = lengthSlider(container, "avpLength");
    expect(slider, "avpLength slider must render").not.toBeNull();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/RDATA/i);
    expect(text).not.toMatch(/CNAME|NS \/|PTR|TXT|SRV/);
    expect(text).toMatch(/avpLength/);
  });
});
