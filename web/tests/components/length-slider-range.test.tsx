// @vitest-environment jsdom
//
// Audit gap (blocking): the length-controller slider computed its upper bound as
//
//   field.max ?? (typeof field.bits === "number" ? 2 ** field.bits - 1 : 255)
//
// A length field whose WIDTH is data-dependent (varint, berLength, delimited
// bytes) carries `bits: 0` in the mirror — the width isn't known until the value
// is. `0` is a number, so the `?? 255` fallback never fired and the bound became
// `2 ** 0 - 1 = 0`: min=0/max=0. The control rendered ENABLED but could not move,
// and `apply()` clamped every typed number into [0,0], so touching the slider
// once destroyed a seeded length with no way back (http3Frame: payload 8 → 0).
//
// Separately, the number input displayed `value` unclamped while the range
// clamped it to `max`, so the two inputs disagreed about the same state
// (websocketFrame loads at range=1024 / number=65536).

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import OverridePanel from "@/components/field-details/OverridePanel";
import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
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

// The six presets whose length controllers have data-dependent widths.
const AFFECTED = [
  "snmpV2c",
  "snmpv3",
  "kerberosAsReq",
  "ocspRequest",
  "quicLong",
  "http3Frame",
] as const;

describe("length-controller sliders always have a usable range", () => {
  for (const key of AFFECTED) {
    it(`${key}: every length slider can actually move`, async () => {
      const packet = psdlToRenderer(PRESETS[key]!);
      const controllers = initialState(packet) as unknown as Record<
        string,
        number
      >;
      // The sliders live in the EmptyState "Length controllers" section, which
      // renders with NO field selected — i.e. the state the user is in the
      // moment the preset loads, before any click.
      const targets: (string | null)[] = [
        null,
        ...packet.fields.filter((f) => f.controlsLength).map((f) => f.id),
      ];
      expect(
        (packet.lengthControllers ?? []).length +
          packet.fields.filter((f) => f.controlsLength).length,
        `${key} must have length controllers`,
      ).toBeGreaterThan(0);

      for (const fieldId of targets) {
        const { container } = await mount(
          <OverridePanel
            packet={packet}
            selectedFieldId={fieldId}
            controllers={controllers}
            onControllerChange={() => {}}
          />,
        );
        for (const el of Array.from(
          container.querySelectorAll('input[type="range"]'),
        )) {
          const range = el as HTMLInputElement;
          const lo = Number(range.min);
          const hi = Number(range.max);
          expect(
            hi,
            `${key}/${fieldId ?? "(no selection)"}: slider range is a single point (min=${range.min} max=${range.max})`,
          ).toBeGreaterThan(lo);
        }
        // The range and the number input must agree about the same state.
        const range = container.querySelector<HTMLInputElement>(
          'input[type="range"]',
        );
        const number = container.querySelector<HTMLInputElement>(
          'input[type="number"]',
        );
        if (range && number && number.value !== "") {
          expect(
            Number(number.value),
            `${key}/${fieldId ?? "(no selection)"}: number shows ${number.value} but the range tops out at ${range.max}`,
          ).toBeLessThanOrEqual(Number(range.max));
        }
        await act(async () => {
          activeRoot!.unmount();
        });
        activeContainer!.remove();
        activeRoot = null;
        activeContainer = null;
      }
    });
  }
});
