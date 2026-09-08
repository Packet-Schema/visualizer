// override-design-audit: http3Frame's two leading fields are QUIC varints —
// `http3FrameType` (the frame Type, ALSO the `http3FramePayload` switch
// discriminator) and `http3PayloadLength` (the Length, `controlsLength:self`).
//
// Because `http3FrameType` carries `switchCases`, the mirror STRIPS its varint
// width and forces `bits:0`, so it never hosts a fixed-width, cell-anchored
// `switchCases` widget the way a normal int discriminator does. And it matched
// NONE of `collectRefSwitches`' nested-discriminator collectors (it is a
// TOP-LEVEL field, not case/group/encrypted-nested), so no packet-level
// refSwitch picker was surfaced either: the whole packet's frame Type was
// see-but-cannot-edit from the OverridePanel. Separately, `http3PayloadLength`
// (controlsLength:self) seeded to 0 → the payload rendered empty on load.
//
// The fix (a) surfaces a packet-level `http3FramePayload` refSwitch keyed on
// `env[http3FrameType]` (extending `fieldNestedNoWidget` to a TOP-LEVEL
// dynamic-width discriminator and relaxing the `switchCases`-as-coverage veto
// for it), and (b) seeds the self-controlling varint Length to the varint
// default so a representative non-empty frame renders on load and the
// OverridePanel length control agrees with the diagram.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { resolveLayout } from "@/lib/psdl/layout";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { seedDynamicWidthDefaults } from "@/lib/psdl/dynamic-width-defaults";
import { initialState } from "@/lib/psdl/renderer-helpers";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";
import type { Packet as RendererPacket } from "@/lib/psdl/renderer";

// Mirror PacketViewer's `buildLayoutEnv`: start from `initialState`, layer the
// packet's declared defaults / ref 0-fills, then the dynamic-width seeds — the
// exact load-time env the diagram resolves against.
function loadEnv(
  src: PsdlPacket,
  mirror: RendererPacket,
  overrides: Record<string, number> = {},
): Map<string, number> {
  const state = { ...initialState(mirror), ...overrides };
  const env = new Map<string, number>(
    Object.entries(state).map(([k, v]) => [k, Number(v)]),
  );
  for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
  seedDynamicWidthDefaults(src, env);
  return env;
}

describe("http3Frame frame-type picker + non-empty load", () => {
  const src = (): PsdlPacket => PRESETS.http3Frame!;

  it("surfaces a packet-level refSwitch for the frame Type discriminator", () => {
    const mirror = psdlToRenderer(src());
    const rs = (mirror.refSwitches ?? []).find(
      (r) => r.refKey === "http3FrameType",
    );
    expect(rs).toBeDefined();
    expect(rs!.id).toBe("http3FramePayload");
    // The 7 registered frame types are all selectable (DATA/HEADERS/…/MAX_PUSH_ID),
    // plus a synthetic unknown/extension arm for the `_` default.
    const values = rs!.cases.map((c) => c.value);
    for (const t of [0, 1, 3, 4, 5, 7, 13]) expect(values).toContain(t);
  });

  it("the discriminator cell renders on load, so the picker is live (not gated off)", () => {
    const mirror = psdlToRenderer(src());
    const cells = resolveLayout(src(), { env: loadEnv(src(), mirror) }).cells;
    // `OverridePanel` gates the refSwitch on whether the discriminator field
    // renders a cell (`fieldRendered`). It must be present, else the picker is
    // permanently disabled.
    expect(cells.some((c) => c.field.id === "http3FrameType")).toBe(true);
  });

  it("renders a representative non-empty frame on load (payload seeded non-zero)", () => {
    const mirror = psdlToRenderer(src());
    // The self-controlling varint Length seeds to a non-zero default in the
    // bootstrap controllers — so the panel length control agrees with the
    // diagram instead of reading 0 over a painted payload.
    expect(initialState(mirror).http3PayloadLength).toBeGreaterThan(0);
    const ids = resolveLayout(src(), { env: loadEnv(src(), mirror) }).cells.map(
      (c) => c.field.id,
    );
    expect(ids).toContain("http3FrameType");
    expect(ids).toContain("http3PayloadLength");
    // The default DATA arm's payload is non-empty.
    expect(ids).toContain("data");
  });

  it("driving env[http3FrameType] via the picker selects each frame's payload", () => {
    const mirror = psdlToRenderer(src());
    const armField: Record<number, string> = {
      0: "data",
      1: "headerBlock",
      3: "pushId",
      5: "pushHeaderBlock",
      7: "streamId",
      13: "maxPushId",
    };
    for (const [value, fieldId] of Object.entries(armField)) {
      const ids = resolveLayout(src(), {
        env: loadEnv(src(), mirror, { http3FrameType: Number(value) }),
      }).cells.map((c) => c.field.id);
      // The frame Type cell stays visible AND the selected arm's payload renders.
      expect(ids).toContain("http3FrameType");
      expect(ids).toContain(fieldId);
    }
  });

  it("only http3Frame gets a top-level dynamic-width refSwitch (no other preset regressed)", () => {
    const affected: string[] = [];
    for (const [name, p] of Object.entries(PRESETS)) {
      if (!p) continue;
      const m = psdlToRenderer(p);
      for (const rs of m.refSwitches ?? []) {
        const f = m.fields.find((x) => x.id === rs.refKey);
        // The new path's signature: a refSwitch whose discriminator mirror field
        // carries `switchCases` (it is the switch `on:ref` target itself) yet was
        // stripped to `bits:0` (a dynamic-width varint).
        if (f && f.switchCases && f.bits === 0) affected.push(name);
      }
    }
    expect([...new Set(affected)]).toEqual(["http3Frame"]);
  });
});
