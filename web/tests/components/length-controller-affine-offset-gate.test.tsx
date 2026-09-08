// @vitest-environment jsdom
//
// Regression: PacketViewer's `inertLengthControllers` probe decides whether a
// length-controller slider is live by re-resolving the layout with the env key
// perturbed by ONE sample value (`current === 0 ? 8 : current - 1`) and marking
// the controller inert if that single re-resolve leaves `totalBits` unchanged.
//
// For length fields that size a payload through an AFFINE offset (`value - K`)
// the seeded/probe value falls BELOW K, so the payload is still width-0 and the
// probe looks inert — even though larger values clearly grow the diagram. The
// OverridePanel then disabled the slider (with a DNS-RDATA hint that has nothing
// to do with the packet), so the user could SEE the field (e.g. the SCTP DATA
// chunk + its Length octet) but had NO control to reveal the payload it sizes.
//
// Concretely for sctp: at the seeded state (chunkLength=0) `data_userData =
// bytes(chunkLength - 16)` is width-0 and absent; the old probe samples
// chunkLength=8 -> 8-16<0 -> still 224 bits == base -> inert -> the ONLY control
// that can reveal the DATA payload was permanently disabled. Same root cause for
// ipfix `ipfixLength`, psamp `psampLength`, pcep `pcepObjectLength`, ikev2Sa
// `ikev2ProposalLength`, bgpNotification `bgpLength`.
//
// Fix: replace the single-sample perturbation with a small UPWARD sweep
// (current+1/+8/+32/+64/+128, capped at the field max) and mark the controller
// inert only when NONE of those samples changes `totalBits`. This re-enables the
// affine-offset sliders while keeping genuinely fixed-width arms (lwm2mRegister
// tlvLength16/24, ipinip innerIhl) correctly disabled.

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import PacketViewer from "@/components/packet-viewer/PacketViewer";
import { PRESETS } from "@/lib/psdl/presets.server";
import { resolveLayout } from "@/lib/psdl/layout";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { initialState } from "@/lib/psdl/renderer-helpers";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("packet-schema-visualizer-tour-seen", "1");
  window.history.replaceState(null, "", "/");
});

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

/** The load-time env exactly as PacketViewer builds it: mirror `initialState`
 *  seeds, packet defaults, a 0 fallback for every remaining ref, then explicit
 *  overrides on top. */
function loadEnv(
  src: PsdlPacket,
  overrides: Record<string, number> = {},
): Map<string, number> {
  const mirror = psdlToRenderer(src);
  const env = new Map<string, number>(
    Object.entries(initialState(mirror)).map(([k, v]) => [k, Number(v)]),
  );
  for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
  for (const [k, v] of Object.entries(overrides)) env.set(k, v);
  return env;
}

/** Mount the real PacketViewer for a built-in preset (no lazy fetch — the body
 *  is provided up front, mirroring how the server seeds it). */
async function mountPreset(presetKey: string): Promise<HTMLElement> {
  window.history.replaceState(null, "", `/?preset=${presetKey}`);
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <PacketViewer
        initialBuiltInPacket={
          (PRESETS as Record<string, PsdlPacket>)[presetKey]
        }
      />,
    );
  });
  // Flush hydration + any lazy preset fetch the URL hydration triggers.
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  activeRoot = root;
  activeContainer = container;
  return container;
}

/** The length-controller slider lives in the OverridePanel's "Length
 *  controllers" section, which renders in the empty state (no cell selection
 *  needed). Its id is `detail-ctrl-<controlsLength>-slider`. */
function lengthSlider(
  container: HTMLElement,
  controlsLength: string,
): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(
    `#detail-ctrl-${controlsLength}-slider`,
  );
}

// All six affine-offset length controllers that the single-sample probe wrongly
// disabled. `[preset, controlsLength, higherValue]`: at the seeded state the
// sized payload is width-0/absent; at `higherValue` it materialises.
const AFFINE_CASES: ReadonlyArray<readonly [string, string, number]> = [
  ["sctp", "chunkLength", 20],
  ["ipfix", "ipfixLength", 32],
  ["psamp", "psampLength", 32],
  ["pcep", "pcepObjectLength", 32],
  ["ikev2Sa", "ikev2ProposalLength", 32],
  ["bgpNotification", "bgpLength", 32],
];

// Genuinely fixed-width length controllers — the seeded arm's value does NOT
// grow with the slider, so they must stay DISABLED (no regression).
const FIXED_CASES: ReadonlyArray<readonly [string, string]> = [
  ["lwm2mRegister", "tlvLength16"],
  ["lwm2mRegister", "tlvLength24"],
  ["ipinip", "innerIhl"],
];

describe("length-controller affine-offset live gating", () => {
  it("reveals sctp's DATA payload (data_userData) when chunkLength clears the 16-byte header offset", () => {
    const src = PRESETS.sctp as PsdlPacket;

    // Seeded state (chunkLength=0): data_userData = bytes(chunkLength - 16) is
    // width-0 and absent from the diagram.
    const base = resolveLayout(src, { env: loadEnv(src) });
    expect(
      base.cells.some((c) => c.field.id.startsWith("data_userData")),
      "data_userData must be absent at chunkLength=0",
    ).toBe(false);

    // Raising chunkLength past the 16-byte header offset materialises the
    // payload — proof the controller is genuinely drivable.
    const grown = resolveLayout(src, {
      env: loadEnv(src, { chunkLength: 20 }),
    });
    expect(
      grown.cells.some((c) => c.field.id.startsWith("data_userData")),
      "data_userData must appear once chunkLength > 16",
    ).toBe(true);
    expect(grown.totalBits).toBeGreaterThan(base.totalBits);
  });

  it.each(AFFINE_CASES)(
    "keeps %s's %s length slider ENABLED at the seeded affine-offset state",
    async (presetKey, controlsLength) => {
      const container = await mountPreset(presetKey);
      const slider = lengthSlider(container, controlsLength);
      expect(
        slider,
        `${presetKey}: ${controlsLength} slider must render`,
      ).not.toBeNull();
      // The upward sweep finds a value that grows the diagram, so the slider is
      // live — not disabled with the misleading DNS-RDATA hint.
      expect(
        slider!.disabled,
        `${presetKey}: ${controlsLength} must be enabled (affine-offset payload is drivable)`,
      ).toBe(false);
    },
  );

  it.each(FIXED_CASES)(
    "keeps %s's %s length slider DISABLED (fixed-width arm — no regression)",
    async (presetKey, controlsLength) => {
      const container = await mountPreset(presetKey);
      const slider = lengthSlider(container, controlsLength);
      expect(
        slider,
        `${presetKey}: ${controlsLength} slider must render`,
      ).not.toBeNull();
      expect(
        slider!.disabled,
        `${presetKey}: ${controlsLength} must stay disabled (sized value is fixed-width)`,
      ).toBe(true);
    },
  );
});
