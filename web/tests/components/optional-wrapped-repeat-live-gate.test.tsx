// @vitest-environment jsdom
//
// Regression (#13, medium): a TLV-shaped (or plain) repeat wrapped in an
// `optional{when: ref(X)}` container surfaces a freeRepeat count stepper +
// peek type-picker (the optional-wrapped-tlv fix). But the freeRepeat only
// carried a `gate` for SWITCH-CASE nesting (caseGate is null for optional
// nesting), and peekSwitches were NEVER `fieldRendered`-gated. So at load —
// where `initialState` seeds defaultCount=1 / the peek arm but leaves the
// optional's `when` field X=0, making the whole section ABSENT from the diagram
// — OverridePanel showed a LIVE 'count = 1' stepper AND a LIVE peek picker over
// a diagram drawing nothing from the section: an inert/misleading control that
// contradicts the diagram (bar #2: ANY user-supplied PSDL, no surface that
// contradicts the diagram).
//
// Fix: the optional-nested freeRepeat carries `gateFieldId` and the peekSwitch
// carries `gateFieldId` (a representative inner field id of the arm seeded at
// load); OverridePanel disables both with a hint until that id is a rendered
// cell — the same `fieldRendered` gate a refSwitch picker uses. Once the
// optional's `when` is set the section renders and both controls go live.

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import OverridePanel from "@/components/field-details/OverridePanel";
import { peek, ref } from "@/lib/psdl/expr";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { initialState } from "@/lib/psdl/renderer-helpers";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

const bits = (n: number) => ({ kind: "bits" as const, n });

// `flag` int + `optional(ref flag){ repeat 'recs' eos { switch 'recSw' on
// peek(8) } }` — the optional-wrapped TLV-shaped repeat.
function mkPacket(): PsdlPacket {
  return {
    name: "OptionalWrappedRepeat",
    rowBits: 32,
    body: [
      { id: "flag", name: "Flag", type: bits(8) },
      {
        kind: "optional",
        id: "recsOpt",
        when: ref("flag"),
        container: {
          kind: "repeat",
          id: "recs",
          count: "eos",
          element: {
            id: "recStruct",
            fields: [
              {
                kind: "switch",
                id: "recSw",
                on: peek(8),
                cases: {
                  "1": {
                    id: "recA",
                    name: "Type A",
                    fields: [
                      { id: "aType", name: "A Type", type: bits(8) },
                      { id: "aVal", name: "A Value", type: bits(8) },
                    ],
                  },
                  "2": {
                    id: "recB",
                    name: "Type B",
                    fields: [
                      { id: "bType", name: "B Type", type: bits(8) },
                      { id: "bVal", name: "B Value", type: bits(16) },
                    ],
                  },
                },
              },
            ],
          },
        },
      },
    ],
  };
}

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

/** Load-time env exactly as PacketViewer builds it: the mirror's initialState
 *  seeds, then declared defaults, then a 0 fallback for every ref — then the
 *  explicit overrides on top. */
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

describe("optional-wrapped repeat live gating", () => {
  it("threads gateFieldId onto the freeRepeat stepper and the peek picker", () => {
    const mirror = psdlToRenderer(mkPacket());
    const recsRepeat = (mirror.freeRepeats ?? []).find(
      (r) => r.countKey === "recs",
    );
    expect(recsRepeat?.gateFieldId).toBe("aType");
    // No switch-case gate (the optional has no caseGate).
    expect(recsRepeat?.gate).toBeUndefined();

    const peekSw = (mirror.peekSwitches ?? []).find((p) => p.id === "recSw");
    // The seeded arm is cases[0].value (1 = Type A), so the anchor is its field.
    expect(peekSw?.gateFieldId).toBe("aType");
  });

  it("disables both controls on load (optional absent), enables them once the flag is set", async () => {
    const src = mkPacket();
    const packet = psdlToRenderer(src);

    // On load `flag` defaults to 0 → the optional is absent → the section draws
    // nothing → both the stepper and the peek picker are disabled with a hint.
    {
      const { env, controllers } = loadEnv(src);
      const { cells } = resolveLayout(src, { env });
      // Sanity: no inner field renders at the default.
      expect(cells.some((c) => c.field.id.startsWith("aType"))).toBe(false);

      const { container } = await mount(
        <OverridePanel
          packet={packet}
          selectedFieldId={null}
          controllers={controllers}
          onControllerChange={() => {}}
          cells={cells}
        />,
      );
      const stepper = container.querySelector<HTMLInputElement>(
        "#detail-repeat-recs-number",
      );
      expect(stepper, "count stepper must render").not.toBeNull();
      expect(stepper!.disabled, "stepper disabled on load").toBe(true);

      const picker = container.querySelector<HTMLSelectElement>(
        "#detail-peek-__peek__0__8",
      );
      expect(picker, "peek picker must render").not.toBeNull();
      expect(picker!.disabled, "peek picker disabled on load").toBe(true);

      expect(container.textContent ?? "").toMatch(/to edit/i);
    }

    // Setting `flag` (the optional's `when`) reveals the section → an inner cell
    // renders → both controls go live. The gate follows the live diagram.
    {
      const { env, controllers } = loadEnv(src, { flag: 1 });
      const { cells } = resolveLayout(src, { env });
      expect(cells.some((c) => c.field.id.startsWith("aType"))).toBe(true);

      const { container } = await mount(
        <OverridePanel
          packet={packet}
          selectedFieldId={null}
          controllers={controllers}
          onControllerChange={() => {}}
          cells={cells}
        />,
      );
      expect(
        container.querySelector<HTMLInputElement>("#detail-repeat-recs-number")!
          .disabled,
      ).toBe(false);
      expect(
        container.querySelector<HTMLSelectElement>("#detail-peek-__peek__0__8")!
          .disabled,
      ).toBe(false);
    }
  });
});
