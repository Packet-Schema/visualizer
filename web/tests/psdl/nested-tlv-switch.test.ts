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

    // The inner option-type pickers — one per option list (rsByOptType,
    // raByOptType, …), all keyed on the same 8-bit peek at offset 0.
    expect(mirror.peekSwitches).toHaveLength(5);
    for (const ps of mirror.peekSwitches ?? []) {
      expect(ps.peekKey).toBe("__peek__0__8");
      expect(ps.cases.length).toBeGreaterThan(0);
    }

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
      // The tell-tale: peekSwitches whose offset is 0/8 AND multiple eos
      // freeRepeats sharing that picker — but the simplest cross-check is the
      // exact icmpv6Ndp signature (5 option lists). Use a conservative probe:
      // a preset with >=2 peekSwitches AND >=2 eos freeRepeats where each
      // freeRepeat has defaultCount and the peek is at offset 0.
      const peeks = mirror.peekSwitches ?? [];
      const frees = mirror.freeRepeats ?? [];
      const eosFrees = frees.filter((f) => f.defaultCount === 1);
      return peeks.length >= 2 && eosFrees.length >= 2;
    });
    expect(affected).toEqual(["icmpv6Ndp"]);
  });
});
