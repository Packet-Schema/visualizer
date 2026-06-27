// Dynamic-width (berLength/varint/delimited) and enum override controls for
// leaves inside a nested/compound Group.
//
// `groupToSubfieldField` (psdl-to-renderer/subfield.ts) only collapses a
// TOP-LEVEL Group whose children are ALL leaf fields; the moment a top-level
// Group has a compound child the group never enters the renderer mirror, and
// its cell is built by the LAYOUT collapsed-group path in `resolveLayout`. That
// path used to copy only id/name/bits/description onto each subfield — NOT the
// dynWidth (varintEncoding/isBerLength/isDelimited) or enumFlags (enumVariants)
// maps the flat-cell path spreads. A click on such a subfield then resolved to
// a SubCell carrying no width/enum hint, so OverridePanel rendered the dead-end
// "Subfields share their parent's override. Select the parent cell." even
// though env[fieldId] genuinely drives the cell's wire width / value
// (see-but-cannot-edit on snmpv3 BER lengths, ipinip outerProtocol, pppoe code).
//
// resolveLayout now spreads the same maps (plus the authored defaultValue) onto
// the collapsed-group subfields so the controls are reachable.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { seedDynamicWidthDefaults } from "@/lib/psdl/dynamic-width-defaults";
import { resolveSelection } from "@/components/field-details/selection-resolver";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

/** Resolve a `<parentId>:<subId>` selection through the same path the diagram
 *  click → OverridePanel uses (renderer mirror + layout cells). The env is
 *  seeded exactly as the app does so varint / delimited leaves render at their
 *  visible default width instead of collapsing to a zero-width (unclickable)
 *  cell. */
function resolveSub(psdl: PsdlPacket, sel: string) {
  const env = new Map<string, number>(initialEnv(psdl));
  seedDynamicWidthDefaults(psdl, env);
  const layout = resolveLayout(psdl, { env });
  const mirror = psdlToRenderer(psdl);
  return resolveSelection(mirror, sel, layout.cells);
}

describe("group-subfield dynamic-width / enum controls", () => {
  it("surfaces berLength + varint + enum flags on subfields of a non-collapsing Group", () => {
    // A top-level Group with a compound child (the nested `nestedBits` group)
    // — so `groupToSubfieldField` returns null and the cell is built by the
    // layout collapsed-group path — plus sibling berLength / varint / enum
    // leaves the user can SEE and (via env[fieldId]) genuinely edit.
    const psdl: PsdlPacket = {
      name: "GroupDynWidth",
      rowBits: 32,
      body: [
        {
          kind: "group",
          id: "header",
          name: "Header",
          children: [
            {
              kind: "group",
              id: "nestedBits",
              name: "Nested Bits",
              children: [
                { id: "flagA", name: "Flag A", type: { kind: "bits", n: 4 } },
                { id: "flagB", name: "Flag B", type: { kind: "bits", n: 4 } },
              ],
            },
            {
              id: "lenBer",
              name: "BER Length",
              type: { kind: "berLength" },
              defaultValue: 5,
            },
            {
              id: "lenVarint",
              name: "Varint Length",
              type: { kind: "varint", encoding: "leb128" },
            },
            {
              id: "opcode",
              name: "Opcode",
              type: {
                kind: "enum",
                bits: 8,
                variants: { 0: "Request", 1: "Reply" },
              },
              defaultValue: 1,
            },
          ],
        },
      ],
    };

    const ber = resolveSub(psdl, "header:lenBer");
    expect(ber.kind).toBe("subfield");
    if (ber.kind === "subfield") {
      expect(ber.sub.isBerLength).toBe(true);
      // The authored defaultValue rides along so the WidthPicker seeds correctly.
      expect(ber.sub.defaultValue).toBe(5);
    }

    const varint = resolveSub(psdl, "header:lenVarint");
    expect(varint.kind).toBe("subfield");
    if (varint.kind === "subfield") {
      expect(varint.sub.varintEncoding).toBe("leb128");
    }

    const en = resolveSub(psdl, "header:opcode");
    expect(en.kind).toBe("subfield");
    if (en.kind === "subfield") {
      expect(en.sub.enumVariants).toEqual({ 0: "Request", 1: "Reply" });
      expect(en.sub.defaultValue).toBe(1);
    }
  });

  it("does not regress: subfields of an unaffected Group carry no spurious flags", () => {
    const psdl: PsdlPacket = {
      name: "PlainGroup",
      rowBits: 32,
      body: [
        {
          kind: "group",
          id: "header",
          name: "Header",
          children: [
            {
              kind: "group",
              id: "nestedBits",
              name: "Nested Bits",
              children: [
                { id: "x", name: "X", type: { kind: "bits", n: 8 } },
                { id: "y", name: "Y", type: { kind: "bits", n: 8 } },
              ],
            },
            { id: "plain", name: "Plain", type: { kind: "bits", n: 8 } },
            { id: "plain2", name: "Plain 2", type: { kind: "bits", n: 8 } },
          ],
        },
      ],
    };
    const r = resolveSub(psdl, "header:plain");
    expect(r.kind).toBe("subfield");
    if (r.kind === "subfield") {
      expect(r.sub.isBerLength).toBeUndefined();
      expect(r.sub.varintEncoding).toBeUndefined();
      expect(r.sub.isDelimited).toBeUndefined();
      expect(r.sub.enumVariants).toBeUndefined();
    }
  });

  // Preset coverage: the three real presets the global scan flagged. Each has a
  // dynamic-width / enum leaf inside a Group with a compound child, so the
  // control was unreachable before the layout collapsed-group fix.
  it.each([
    ["snmpv3", "msgIdGroup:msgIdLength", "isBerLength"],
    ["snmpv3", "msgMaxSizeGroup:msgMaxSizeLength", "isBerLength"],
    ["snmpv3", "msgFlagsGroup:msgFlagsLength", "isBerLength"],
    ["snmpv3", "msgSecurityModelGroup:msgSecModelLength", "isBerLength"],
    ["snmpv3", "msgGlobalData:headerLength", "isBerLength"],
    ["ipinip", "outerIpv4Header:outerProtocol", "enumVariants"],
    ["pppoe", "pppoeHeader:code", "enumVariants"],
  ] as const)("exposes the override control for %s %s", (key, sel, flag) => {
    const r = resolveSub(PRESETS[key]!, sel);
    expect(r.kind).toBe("subfield");
    if (r.kind === "subfield") {
      if (flag === "isBerLength") {
        expect(r.sub.isBerLength).toBe(true);
      } else {
        expect(r.sub.enumVariants).toBeDefined();
        expect(Object.keys(r.sub.enumVariants!).length).toBeGreaterThan(0);
      }
    }
  });
});
