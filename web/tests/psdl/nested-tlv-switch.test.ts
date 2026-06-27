// nested-tlv (critical): icmpv6Ndp's per-message-type Options lists
// (rsOptions/raOptions/nsOptions/naOptions/rdOptions) are each a
// repeat{count:eos, element:[switch on peek bits:8]} living INSIDE the
// top-level `ndpBody` switch (on ref `type`). They are isTlvRepeat-shaped, so
// they were never lifted to a top-level `tlv` field and got ZERO override
// surface — the user could SEE the option records the eos auto-fill renders but
// had NO control to add records or pick the option type (see-but-cannot-edit).
//
// The fix surfaces, for each such switch-nested non-insideRepeat TLV repeat,
// (1) a freeRepeat eos count stepper keyed on env[repeat.id] (defaultCount 1)
// and (2) the inner peek type-picker (publishing __peek__0__8). icmpv6Ndp is the
// ONLY affected preset across all 184 built-ins.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { initialState } from "@/lib/psdl/renderer-helpers";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

function cellIds(
  psdl: PsdlPacket,
  overrides: Record<string, number>,
): string[] {
  const env = new Map<string, number>(Object.entries(overrides));
  for (const [k, v] of initialEnv(psdl)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  return resolveLayout(psdl, { env }).cells.map((c) => c.field.id);
}

describe("nested-tlv: icmpv6Ndp switch-nested option repeats", () => {
  it("surfaces 5 freeRepeats and 5 peekSwitches for the NDP option lists", () => {
    const mirror = psdlToRenderer(PRESETS.icmpv6Ndp!);

    const optionRepeatKeys = [
      "rsOptions",
      "raOptions",
      "nsOptions",
      "naOptions",
      "rdOptions",
    ];
    const freeKeys = (mirror.freeRepeats ?? []).map((r) => r.countKey).sort();
    expect(freeKeys).toEqual([...optionRepeatKeys].sort());

    // Each is an eos repeat seeded so a representative option shows on load.
    for (const fr of mirror.freeRepeats ?? []) {
      expect(fr.defaultCount).toBe(1);
    }

    // The inner option-type pickers (rsByOptType, raByOptType, …) are each a
    // peek at offset 0 width 8, so they all key on the SAME `__peek__0__8`
    // controller — only the switch inside the currently-selected message
    // variant ever renders. Surface ONE de-duplicated picker (cases unioned)
    // rather than five aliasing controls that read/write a single value
    // (override-audit: no inert/misleading controls).
    expect(mirror.peekSwitches).toHaveLength(1);
    const optPicker = mirror.peekSwitches![0]!;
    expect(optPicker.peekKey).toBe("__peek__0__8");
    expect(optPicker.cases.length).toBeGreaterThan(0);

    // These repeats are NOT promoted to a top-level tlv field.
    expect(mirror.fields.some((f) => f.tlv)).toBe(false);
  });

  it("the surfaced controls actually drive the icmpv6Ndp diagram", () => {
    const src = PRESETS.icmpv6Ndp!;

    // Router Solicitation (type 133) with one rsOptions record renders the
    // option Type/Length/Value record (peek defaults to 0 → the unknown-option
    // fallthrough case ndpOptValue). The count stepper key (env[rsOptions])
    // genuinely instantiates the record.
    const base = cellIds(src, { type: 133, rsOptions: 1 });
    expect(base).toContain("ndpOptType#0");
    expect(base).toContain("ndpOptLength#0");
    expect(base).toContain("ndpOptValue#0");

    // Driving the peek type-picker to 3 switches the rendered option to Prefix
    // Information — proving the peek key the mirror publishes is the real one.
    const prefix = cellIds(src, {
      type: 133,
      rsOptions: 1,
      __peek__0__8: 3,
    });
    expect(prefix).toContain("ndpPrefixLength#0");
    expect(prefix).toContain("ndpPrefix#0");
  });

  it("icmpv6Ndp is the only preset with switch-nested TLV option repeats", () => {
    // A regression canary: if another preset starts surfacing switch-nested TLV
    // repeats, this count changes and we should re-audit the relaxed guard.
    const affected = Object.keys(PRESETS).filter((key) => {
      const mirror = psdlToRenderer(PRESETS[key]!);
      // The tell-tale: multiple eos freeRepeats (the per-message option lists)
      // sharing a single de-duplicated peek option-type picker. (peekSwitches
      // are collapsed by peekKey, so the icmpv6Ndp signature is now ONE peek
      // picker plus >=2 eos freeRepeats, not five aliasing pickers.) Use a
      // conservative probe: a preset with a peek option picker AND the five
      // per-message eos option lists (each carrying a defaultCount).
      const peeks = mirror.peekSwitches ?? [];
      const frees = mirror.freeRepeats ?? [];
      const eosFrees = frees.filter((f) => f.defaultCount === 1);
      return peeks.length >= 1 && eosFrees.length >= 5;
    });
    expect(affected).toEqual(["icmpv6Ndp"]);
  });

  it("gates each NDP option stepper on its message-type case and seeds `type` so the active arm agrees with the diagram on load", () => {
    // Each per-message Options repeat lives in a DISTINCT `type` case of the
    // top-level ndpBody switch, so it can only instantiate records when the
    // diagram is rendering that arm. The mirror tags each freeRepeat with its
    // owning discriminator gate `{ key: "type", value: <case> }`.
    const mirror = psdlToRenderer(PRESETS.icmpv6Ndp!);
    const gates = Object.fromEntries(
      (mirror.freeRepeats ?? []).map((r) => [r.countKey, r.gate]),
    );
    expect(gates.rsOptions).toEqual({ key: "type", value: 133 });
    expect(gates.raOptions).toEqual({ key: "type", value: 134 });
    expect(gates.nsOptions).toEqual({ key: "type", value: 135 });
    expect(gates.naOptions).toEqual({ key: "type", value: 136 });
    expect(gates.rdOptions).toEqual({ key: "type", value: 137 });

    // initialState seeds the gated discriminator `type` to the FIRST gated
    // repeat's case (133), so on load the ndpBody switch renders the Router
    // Solicitation arm and the rsOptions stepper's seeded count (1) matches the
    // rendered records — rather than 0-filling `type` to 0, taking the `_`
    // default arm, and showing five live steppers over ZERO option records.
    const seed = initialState(mirror);
    expect(seed.type).toBe(133);
    expect(seed.rsOptions).toBe(1);

    // The seeded env genuinely renders the option record in the diagram — the
    // surfaced count agrees with what the user sees.
    const env = new Map<string, number>(
      Object.entries(seed as Record<string, number>),
    );
    for (const [k, v] of initialEnv(PRESETS.icmpv6Ndp!)) {
      if (!env.has(k)) env.set(k, v);
    }
    for (const r of collectPsdlRefs(PRESETS.icmpv6Ndp!)) {
      if (!env.has(r)) env.set(r, 0);
    }
    const ids = resolveLayout(PRESETS.icmpv6Ndp!, { env }).cells.map(
      (c) => c.field.id,
    );
    expect(ids).toContain("ndpOptType#0");
    expect(ids).toContain("ndpOptLength#0");
    expect(ids).toContain("ndpOptValue#0");
  });

  it("surfaces ndpOptLength as a length controller so the visible Value cell is editable", () => {
    // Residual of the nested-tlv fix: at the seeded load state the option-type
    // peek defaults to 0, selecting the inner switch's `_` (unknown-option) arm.
    // That arm renders `ndpOptType`, `ndpOptLength` (category=length) and
    // `ndpOptValue` (`bytes(ndpOptLength*8 - 2)`). The Value cell is VISIBLE and
    // its width is driven ENTIRELY by `ndpOptLength`, but `ndpOptLength` lives
    // inside the option repeat's inner peek-Switch — it is not a top-level mirror
    // cell and was in NO control, so the user could SEE the Value (and Length)
    // cell but had no surface to grow/shrink it (see-but-cannot-edit). The fix
    // surfaces `ndpOptLength` as a packet-level length controller.
    const mirror = psdlToRenderer(PRESETS.icmpv6Ndp!);
    const ndpOptLenLc = (mirror.lengthControllers ?? []).find(
      (lc) => lc.id === "ndpOptLength",
    );
    expect(ndpOptLenLc).toBeDefined();
    expect(ndpOptLenLc!.controlsLength).toBe("ndpOptLength");
    // 8-bit Length octet → a slider that can reach 255.
    expect(ndpOptLenLc!.bits).toBe(8);
    expect(ndpOptLenLc!.max).toBe(255);

    // Driving env[ndpOptLength] genuinely grows the visible ndpOptValue cell in
    // the diagram (the `_` unknown-option arm, peek 0), proving the controller is
    // wired to the value's width — not an inert label.
    const src = PRESETS.icmpv6Ndp!;
    const small = cellIds(src, { type: 133, rsOptions: 1, __peek__0__8: 0 });
    const grown = cellIds(src, {
      type: 133,
      rsOptions: 1,
      __peek__0__8: 0,
      ndpOptLength: 4,
    });
    const valSegs = (ids: string[]): number =>
      ids.filter((id) => id.startsWith("ndpOptValue")).length;
    expect(valSegs(small)).toBeGreaterThan(0);
    expect(valSegs(grown)).toBeGreaterThan(valSegs(small));
  });

  it("collapses the 5 aliasing NDP option-type pickers into one picker", () => {
    // Regression: collectPeekSwitches used to emit one peekSwitch per option
    // list (rsByOptType / raByOptType / nsByOptType / naByOptType /
    // rdByOptType), but every one is a peek at offset 0 width 8 → they all
    // published `__peek__0__8`. OverridePanel rendered five separate,
    // differently-named pickers that all read/write that single controller, so
    // four were inert at any moment and moving one silently retargeted whichever
    // message variant was live. They must collapse to ONE picker.
    const src = PRESETS.icmpv6Ndp!;
    const mirror = psdlToRenderer(src);

    const optPickers = (mirror.peekSwitches ?? []).filter(
      (p) => p.peekKey === "__peek__0__8",
    );
    expect(optPickers).toHaveLength(1);

    // The lone picker unions every aliased switch's cases (deduped by value),
    // PLUS a synthetic `0` default sentinel reaching the structurally distinct
    // `_` arm (the generic `ndpOptType/Length/Value` body for any unlisted
    // option type — a real, RFC-defined "unknown option" state the diagram can
    // render and the picker must be able to select).
    const picker = optPickers[0]!;
    expect(picker.cases.map((c) => c.value).sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 5,
    ]);

    // The synthetic default value selects the generic option arm.
    const rsGeneric = cellIds(src, {
      type: 133,
      rsOptions: 1,
      __peek__0__8: 0,
    });
    expect(rsGeneric).toContain("ndpOptValue#0");
    expect(rsGeneric).not.toContain("ndpPrefixLength#0");

    // And the single controller still drives whichever message variant is the
    // active discriminator — the same `__peek__0__8` key works for both a
    // Router Solicitation (type 133, rsOptions) and a Neighbor Solicitation
    // (type 135, nsOptions), proving it is not scoped to one variant.
    const rsPrefix = cellIds(src, { type: 133, rsOptions: 1, __peek__0__8: 3 });
    expect(rsPrefix).toContain("ndpPrefixLength#0");
    const nsPrefix = cellIds(src, { type: 135, nsOptions: 1, __peek__0__8: 3 });
    expect(nsPrefix).toContain("ndpPrefixLength#0");
  });
});
