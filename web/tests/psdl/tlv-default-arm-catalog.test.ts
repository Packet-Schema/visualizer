// The `_` default arm of a TLV-shaped Repeat must be surfaced as a catalog
// entry, and an instance carrying an unlisted Kind (which decodes through that
// `_` arm on the wire) must round-trip losslessly rather than being silently
// dropped.
//
// Before the fix, `switchToTlvCatalog` skipped the `_` arm (it has no numeric
// key), so e.g. tcp `options` had a catalog of [0,1,2,3,4,5,8] with NO entry for
// the 3-field `optionGeneric` (`_`) arm (Kind / Length / Value). The user could
// SEE the generic option the diagram renders for any unlisted Kind but could not
// add one (see-but-cannot-edit), and `repeatToTlvField` DROPPED any imported
// instance whose Kind wasn't listed — losing a valid user/imported record on
// import (a lossless-round-trip violation).

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import {
  mergeInstancesIntoPsdl,
  psdlToRenderer,
} from "@/lib/psdl/psdl-to-renderer";
import { validatePsdlPacket } from "@/lib/psdl/validate";
import type { Container, Repeat } from "@/lib/psdl/types";

/** Recursively locate a Repeat by id through any composition primitive. */
function findRepeat(containers: Container[], id: string): Repeat | undefined {
  for (const c of containers) {
    if (c.kind === "repeat" && c.id === id) return c;
    const kids =
      c.kind === "group"
        ? c.children
        : c.kind === "repeat"
          ? c.element.fields
          : c.kind === "bounded"
            ? c.fields
            : c.kind === "optional"
              ? [c.container]
              : undefined;
    if (kids) {
      const hit = findRepeat(kids, id);
      if (hit) return hit;
    }
    if (c.kind === "switch") {
      for (const arm of Object.values(c.cases)) {
        const hit = findRepeat(arm.fields, id);
        if (hit) return hit;
      }
    }
  }
  return undefined;
}

describe("TLV `_` default arm catalog", () => {
  it("surfaces the tcp optionGeneric (`_`) arm as a catalog entry", () => {
    const mirror = psdlToRenderer(PRESETS.tcp!);
    const opts = mirror.fields.find((f) => f.id === "options");
    expect(opts?.tlv, "options must surface a TLV catalog").toBeDefined();

    // The listed Kinds (0,1,2,3,4,5,8) PLUS a synthetic entry for the `_`
    // (optionGeneric) arm, keyed by the smallest non-covered value (6 here).
    const kinds = opts!.tlv!.catalog.map((c) => c.kind);
    expect(kinds).toContain(6);
    const generic = opts!.tlv!.catalog.find((c) => c.kind === 6)!;
    expect(generic.name.toLowerCase()).toContain("generic");
    // It carries the arm's Kind / Length / Value fields, and its variable-length
    // Value (`bytes(length-2)`) gets a per-instance byte knob so it renders a
    // VISIBLE cell instead of a permanently zero-width, uneditable field.
    expect(generic.fields?.map((f) => f.id)).toEqual([
      "kind",
      "length",
      "value",
    ]);
    expect(generic.variableBytes?.some((v) => v.fieldId === "value")).toBe(
      true,
    );
  });

  it("round-trips an unlisted-Kind tcp option instance losslessly", () => {
    const source = structuredClone(PRESETS.tcp!);
    // A perfectly valid user/imported PSDL carrying a generic option whose Kind
    // (99) is not individually modelled — it decodes through the `_` arm.
    findRepeat(source.body, "options")!.instances = [{ kind: 99 }, { kind: 2 }];

    // Import: the unlisted Kind must NOT be dropped; it folds onto the
    // default-arm sentinel entry (kind 6) so the record survives + renders.
    const mirror1 = psdlToRenderer(source);
    const opts1 = mirror1.fields.find((f) => f.id === "options");
    expect(opts1?.tlv?.instances).toEqual([{ kind: 6 }, { kind: 2 }]);

    // Lift back to PSDL (what every export path does) — must stay valid.
    const lifted = mergeInstancesIntoPsdl(source, mirror1);
    expect(() => validatePsdlPacket(lifted)).not.toThrow();
    expect(findRepeat(lifted.body, "options")?.instances).toEqual([
      { kind: 6 },
      { kind: 2 },
    ]);

    // Re-import (what every hydrate path does): the generic record survives,
    // idempotently — the round-trip is now stable, not lossy.
    const mirror2 = psdlToRenderer(lifted);
    const opts2 = mirror2.fields.find((f) => f.id === "options");
    expect(opts2?.tlv?.instances).toEqual([{ kind: 6 }, { kind: 2 }]);
  });
});
