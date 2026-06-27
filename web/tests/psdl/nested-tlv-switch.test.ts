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

    // The lone picker unions every aliased switch's cases (deduped by value).
    const picker = optPickers[0]!;
    expect(picker.cases.map((c) => c.value).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 5,
    ]);

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
