// @vitest-environment jsdom
//
// Regression: the empty-state OverridePanel used to list EVERY refSwitch under
// "Record variants" as a LIVE picker, even when its discriminator field is not
// in the current diagram. Several refSwitches sit behind an ancestor switch arm
// / repeat that defaults to a non-matching value, so on load they were inert and
// contradicted an empty-or-wrong-arm diagram (#11/#12 class):
//   * oncRpc replyStat / acceptStat / rejectStat — the REPLY subtree only
//     renders once rpcMsgType=1 (and acceptStat additionally needs replyStat=0).
//   * pgm NLA-AFI pickers — none of the SPM/NAK/NCF address fields render until
//     pgmType selects the matching message arm.
//   * lispMapReply lispLocAFI — its enclosing per-record Locators repeat had no
//     representative record on load, so the AFI cell never appeared.
//
// Fix: OverridePanel gates each "Record variants" picker on whether its
// discriminator field is materialised as a diagram cell — a layout-faithful
// "this picker is live" signal — disabling the inert ones with a hint instead of
// showing a control that can't change the diagram. lispMapReply's record-bearing
// inner repeat additionally seeds one locator so its AFI picker IS live on load.

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
  // Unmount any prior mount in the same test so duplicate element ids from a
  // previous scenario can't leak into the document and shadow the query.
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

/** The load-time env exactly as PacketViewer builds it: the renderer mirror's
 *  `initialState` seeds (defaultCount / refSwitch length seeds), then the
 *  packet's declared defaults, then a 0 fallback for every remaining ref —
 *  then the explicit overrides on top. */
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

/** The <select> rendered for the refSwitch keyed on `refKey` (id pattern from
 *  PeekSwitchPicker: `detail-peek-<refKey>`). */
function refSwitchSelect(
  container: HTMLElement,
  refKey: string,
): HTMLSelectElement | null {
  return container.querySelector<HTMLSelectElement>(`#detail-peek-${refKey}`);
}

describe("refSwitch 'Record variants' live gating", () => {
  it("disables the oncRpc REPLY-subtree pickers on load, enables them once the arm is selected", async () => {
    const src = PRESETS.oncRpc!;
    const packet = psdlToRenderer(src);
    // All three discriminators live inside the REPLY switch arm.
    const refKeys = (packet.refSwitches ?? []).map((r) => r.refKey).sort();
    expect(refKeys).toEqual(["acceptStat", "rejectStat", "replyStat"]);

    // On load (rpcMsgType defaults to 0 = CALL) none of the REPLY discriminators
    // render, so every picker is disabled with a hint.
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
      for (const refKey of ["replyStat", "acceptStat", "rejectStat"]) {
        const select = refSwitchSelect(container, refKey);
        expect(select, `${refKey} picker must render`).not.toBeNull();
        expect(select!.disabled, `${refKey} must be disabled on load`).toBe(
          true,
        );
      }
      expect(container.textContent ?? "").toMatch(/to edit/i);
    }

    // Picking REPLY (rpcMsgType=1) renders replyStat + acceptStat (replyStat=0),
    // so both become live; rejectStat (needs replyStat=1) stays disabled.
    {
      const { env, controllers } = loadEnv(src, { rpcMsgType: 1 });
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
      expect(refSwitchSelect(container, "replyStat")!.disabled).toBe(false);
      expect(refSwitchSelect(container, "acceptStat")!.disabled).toBe(false);
      expect(refSwitchSelect(container, "rejectStat")!.disabled).toBe(true);
    }

    // replyStat=1 (MSG_DENIED) reveals rejectStat and hides acceptStat — the
    // gate follows the live diagram exactly.
    {
      const { env, controllers } = loadEnv(src, {
        rpcMsgType: 1,
        replyStat: 1,
      });
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
      expect(refSwitchSelect(container, "rejectStat")!.disabled).toBe(false);
      expect(refSwitchSelect(container, "acceptStat")!.disabled).toBe(true);
    }
  });

  it("disables the pgm NLA-AFI pickers on load, enables one once its pgmType arm is selected", async () => {
    const src = PRESETS.pgm!;
    const packet = psdlToRenderer(src);
    const afiKeys = (packet.refSwitches ?? [])
      .map((r) => r.refKey)
      .filter((k) => k.endsWith("Afi"));
    expect(afiKeys).toContain("pgmSpmNlaAfi");

    // On load (pgmType defaults to ODATA) no AFI field renders → all disabled.
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
    for (const refKey of afiKeys) {
      expect(
        refSwitchSelect(container, refKey)!.disabled,
        `${refKey} must be disabled on load`,
      ).toBe(true);
    }

    // Find the pgmType value that materialises pgmSpmNlaAfi (the discriminator
    // is a group subfield, not a top-level switchCases field — scan the type
    // space), then assert that value makes the SPM picker live: proof the gate
    // is data-driven, not a blanket disable.
    let spmType: number | null = null;
    for (let v = 0; v <= 255; v++) {
      const { env: e } = loadEnv(src, { pgmType: v });
      const got = resolveLayout(src, { env: e }).cells;
      if (got.some((cell) => cell.field.id === "pgmSpmNlaAfi")) {
        spmType = v;
        break;
      }
    }
    expect(spmType, "a pgmType value must render pgmSpmNlaAfi").not.toBeNull();

    const { env: env2, controllers: c2 } = loadEnv(src, { pgmType: spmType! });
    const { cells: cells2 } = resolveLayout(src, { env: env2 });
    const { container: container2 } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId={null}
        controllers={c2}
        onControllerChange={() => {}}
        cells={cells2}
      />,
    );
    expect(refSwitchSelect(container2, "pgmSpmNlaAfi")!.disabled).toBe(false);
  });

  it("seeds one lispMapReply locator so its AFI picker is LIVE on load", async () => {
    const src = PRESETS.lispMapReply!;
    const packet = psdlToRenderer(src);

    // The record-bearing inner Locators repeat is seeded to one record.
    const locRepeat = (packet.freeRepeats ?? []).find(
      (r) => r.countKey === "lispRecLocCount",
    );
    expect(locRepeat?.defaultCount).toBe(1);

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
    // lispLocAFI renders (one locator) → its picker is live, not gated.
    expect(refSwitchSelect(container, "lispLocAFI")!.disabled).toBe(false);
    // The top-level EID-prefix AFI is also always live on load.
    expect(refSwitchSelect(container, "lispRecEIDAFI")!.disabled).toBe(false);
  });
});
