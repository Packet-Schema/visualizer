// @vitest-environment jsdom
//
// high (see-but-cannot-edit): pppoe's entire `pppoeHeader` group was dropped
// from the override mirror because it NESTS the `verType` sub-group, so
// `groupToSubfieldField` returned null and psdlToRenderer pushed nothing —
// the mirror had ZERO fields. `collectBoundedControllers` correctly detects
// `payloadLength` as the bounded-budget controller, but the lengthController
// emission loop iterates `fields` looking for a top-level cell / subfield with
// that id and (with 0 fields) finds nothing, so NO control is emitted. The
// user could SEE the Payload Length cell and the tag-list payload but had no
// way to edit the length or change how many tags render — the budget-derived
// `pppoeTagList` repeat has no freeRepeat, so the length is its ONLY control.
//
// Fix: psdlToRenderer's top-level group branch falls back to
// `groupToSubfieldFieldDeep` when the shallow collapse bails, flattening
// nested-group leaves into a flat `subfields[]`. That restores a mirror field
// for `pppoeHeader` whose subfields include `payloadLength`, so the existing
// bounded-controller subfield path emits a packet-level lengthController.

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import OverridePanel from "@/components/field-details/OverridePanel";
import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

/** Total laid-out cell count for a given payloadLength budget, replicating the
 *  PacketViewer boundedRepeats derivation: the eos repeat's count is DERIVED
 *  from the bounded byte budget (`floor((budget - prefixBytes) / perRecordBytes)`),
 *  not read straight from env — and `resolveLayout` enforces the budget, so the
 *  count and the length must move together. This is the same coupling the real
 *  diagram applies; the payloadLength slider is the user's single control. */
function cellCountForLength(psdl: PsdlPacket, payloadLength: number): number {
  const mirror = psdlToRenderer(psdl);
  const br = (mirror.boundedRepeats ?? []).find(
    (b) => b.lengthKey === "payloadLength",
  )!;
  const env = new Map<string, number>();
  for (const [k, v] of initialEnv(psdl)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  env.set("payloadLength", payloadLength);
  for (const s of br.innerScopeSeeds ?? [])
    if (!env.get(s.key)) env.set(s.key, s.value);
  const forRecords = Math.max(0, payloadLength - br.prefixBytes);
  env.set(br.countKey, Math.floor(forRecords / br.perRecordBytes));
  return resolveLayout(psdl, { env }).cells.length;
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

describe("pppoe payloadLength budget is editable", () => {
  it("surfaces payloadLength as a packet-level length controller", () => {
    const mirror = psdlToRenderer(PRESETS.pppoe!);
    // The nested-group header is no longer dropped: pppoeHeader collapses to a
    // single subfield-bearing field that includes payloadLength.
    const header = mirror.fields.find((f) => f.id === "pppoeHeader");
    expect(header, "pppoeHeader must reach the mirror").toBeDefined();
    expect(header!.subfields?.some((s) => s.id === "payloadLength")).toBe(true);
    // payloadLength is a subfield, never a top-level cell, so it can't host its
    // own slider — it is surfaced as a packet-level length controller instead.
    expect(mirror.fields.some((f) => f.id === "payloadLength")).toBe(false);
    const lc = (mirror.lengthControllers ?? []).find(
      (l) => l.id === "payloadLength",
    );
    expect(
      lc,
      "payloadLength must be a packet-level length controller",
    ).toBeDefined();
    expect(lc!.controlsLength).toBe("payloadLength");
    // The bounded-budget length is keyed by boundedRepeats.lengthKey.
    expect(
      (mirror.boundedRepeats ?? []).some(
        (br) => br.lengthKey === "payloadLength",
      ),
    ).toBe(true);
  });

  it("raising the length grows the visible tag-list payload", () => {
    expect(cellCountForLength(PRESETS.pppoe!, 32)).toBeGreaterThan(
      cellCountForLength(PRESETS.pppoe!, 0),
    );
  });

  it("clicking the payloadLength subcell yields an editable OverrideSlider", async () => {
    const packet = psdlToRenderer(PRESETS.pppoe!);
    const env = new Map<string, number>();
    for (const [k, v] of initialEnv(PRESETS.pppoe!)) env.set(k, v);
    for (const r of collectPsdlRefs(PRESETS.pppoe!))
      if (!env.has(r)) env.set(r, 0);
    const { cells } = resolveLayout(PRESETS.pppoe!, { env });
    const controllers = Object.fromEntries(env);
    const { container } = await mount(
      <OverridePanel
        packet={packet}
        selectedFieldId="pppoeHeader:payloadLength"
        controllers={controllers}
        onControllerChange={() => {}}
        cells={cells}
      />,
    );
    // The payloadLength subcell shares its parent's override surface; the live
    // length-controller slider is reachable in the panel (not disabled) because
    // its sized payload region renders.
    const slider = container.querySelector('input[type="range"]');
    expect(
      slider,
      "payloadLength length controller must surface a live range slider",
    ).not.toBeNull();
    expect((slider as HTMLInputElement).disabled).toBe(false);
  });
});
