// @vitest-environment jsdom
//
// override-audit (rohcUncompressed): the FEEDBACK element's `feedbackData` is
// `bytes(cond(feedbackCode==0 ? feedbackSize : feedbackCode))`. The mirror
// surfaces `feedbackCode` (the Code nibble) as a length controller, but at the
// seeded load state — `feedbackCode == 0`, the default — the width is driven
// instead by the separate `feedbackSize` Size octet. That octet is itself an
// `optional {when: feedbackCode==0}` cell, so `flattenForMirror` never descends
// into it: it is neither a top-level mirror cell nor a Group subfield, and the
// direct-sibling length scan misses it. The result was a VISIBLE Size octet and
// a VISIBLE feedbackData region whose width depends entirely on `feedbackSize`,
// with no widget to change `feedbackSize` — a see-but-cannot-edit length octet
// and value in the default state.
//
// After the fix `collectSiblingLengthControllers` also treats an OPTIONAL-wrapped
// length cell as a controller candidate, so `feedbackSize` surfaces as an 8-bit
// packet-level length controller keyed on `env[feedbackSize]`. OverridePanel's
// per-controller live gate (`fieldRendered`) then keeps that slider LIVE exactly
// while the Size octet is in the diagram (feedbackCode==0) and disabled otherwise.

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import OverridePanel from "@/components/field-details/OverridePanel";
import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { peekEnvKey } from "@/lib/psdl/expr";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

const rohc = (): PsdlPacket => PRESETS.rohcUncompressed as PsdlPacket;

/** Logical bit-width of the FEEDBACK region (prefix5 + code3 + optional Size
 *  octet + feedbackData) under the given env. The feedback gate is a
 *  `peek(5)==30` Optional, so the gate key must be opened and at least one
 *  record requested. A region that wraps onto multiple rows emits one cell per
 *  row, each reporting the SAME full-region `bitsTotal`, so read it from the
 *  first cell rather than summing (which would double-count the wrapped rows). */
function feedbackRegionBits(overrides: Record<string, number>): number {
  const env = new Map<string, number>(Object.entries(overrides));
  const cell = resolveLayout(rohc(), { env }).cells.find((c) =>
    /^rohcFeedbackRegion/.test(c.field.id),
  );
  return cell?.bitsTotal ?? 0;
}

describe("rohcUncompressed feedbackSize length controller", () => {
  it("surfaces feedbackSize as an 8-bit length controller (not just feedbackCode)", () => {
    const mirror = psdlToRenderer(rohc());
    const lcs = mirror.lengthControllers ?? [];

    const codeLc = lcs.find((c) => c.id === "feedbackCode");
    expect(codeLc, "feedbackCode must still be surfaced").toBeDefined();

    const sizeLc = lcs.find((c) => c.id === "feedbackSize");
    expect(
      sizeLc,
      "feedbackSize (the optional Size octet) must be surfaced as a controller",
    ).toBeDefined();
    expect(sizeLc?.controlsLength).toBe("feedbackSize");
    // 8-bit Size octet → slider max 255.
    expect(sizeLc?.bits).toBe(8);
    expect(sizeLc?.max).toBe(255);

    // feedbackSize lives inside an Optional inside the repeat, so it is not (and
    // must not be promoted to) a top-level mirror cell.
    expect(mirror.fields.some((f) => f.id === "feedbackSize")).toBe(false);
  });

  it("env[feedbackSize] drives the feedbackData width when feedbackCode==0", () => {
    // Open the feedback gate, request one record, default Code = 0.
    const base = { [peekEnvKey(0, 5)]: 30, rohcFeedback: 1, feedbackCode: 0 };

    // prefix(5) + code(3) + size(8) = 16 bits of header, then feedbackData = N
    // bytes. Raising feedbackSize must grow the region, byte for byte.
    const at2 = feedbackRegionBits({ ...base, feedbackSize: 2 });
    const at6 = feedbackRegionBits({ ...base, feedbackSize: 6 });

    expect(at2).toBe(16 + 2 * 8);
    expect(at6).toBe(16 + 6 * 8);
    // The growth is exactly the extra feedbackSize bytes — proving the surfaced
    // controller drives the width.
    expect(at6 - at2).toBe((6 - 2) * 8);
  });
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

function lengthSlider(
  container: HTMLElement,
  fieldId: string,
): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(
    `#detail-ctrl-${fieldId}-slider`,
  );
}

describe("rohcUncompressed feedbackSize slider live-gate", () => {
  it("is LIVE in the default (feedbackCode=0) state and disabled once Code != 0", async () => {
    const src = rohc();
    const packet = psdlToRenderer(src);

    // Open the feedback gate and request one record so the FEEDBACK element is in
    // the diagram. feedbackCode = 0 is the load default (the Size octet is shown).
    const baseControllers = {
      [peekEnvKey(0, 5)]: 30,
      rohcFeedback: 1,
      feedbackCode: 0,
      feedbackSize: 3,
    };

    {
      const env = new Map<string, number>(Object.entries(baseControllers));
      const { cells } = resolveLayout(src, { env });
      // Sanity: the Size octet really is in the diagram at Code = 0.
      expect(
        cells.some((c) =>
          (c.subCells ?? []).some((s) => s.subfield.id === "feedbackSize"),
        ),
      ).toBe(true);
      const { container } = await mount(
        <OverridePanel
          packet={packet}
          selectedFieldId={null}
          controllers={baseControllers}
          onControllerChange={() => {}}
          cells={cells}
        />,
      );
      const slider = lengthSlider(container, "feedbackSize");
      expect(slider, "feedbackSize slider must render").not.toBeNull();
      expect(
        slider!.disabled,
        "must be LIVE at the default state (feedbackCode=0)",
      ).toBe(false);
    }

    {
      // Code != 0: the Size octet's optional gate closes, so the slider disables
      // with a hint (the width is then driven by feedbackCode instead).
      const controllers = { ...baseControllers, feedbackCode: 5 };
      const env = new Map<string, number>(Object.entries(controllers));
      const { cells } = resolveLayout(src, { env });
      expect(
        cells.some((c) =>
          (c.subCells ?? []).some((s) => s.subfield.id === "feedbackSize"),
        ),
      ).toBe(false);
      const { container } = await mount(
        <OverridePanel
          packet={packet}
          selectedFieldId={null}
          controllers={controllers}
          onControllerChange={() => {}}
          cells={cells}
        />,
      );
      const slider = lengthSlider(container, "feedbackSize");
      expect(slider, "feedbackSize slider must render").not.toBeNull();
      expect(slider!.disabled, "must be disabled once feedbackCode != 0").toBe(
        true,
      );
    }
  });
});
