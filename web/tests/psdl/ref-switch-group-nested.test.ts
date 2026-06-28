// Regression: a TOP-LEVEL Switch whose discriminator is a flag / int bit
// declared inside a top-level GROUP (not a switch case, not a repeat) used to
// surface ZERO override control — a see-but-cannot-edit gap.
//
// `flattenForMirror` does not descend into groups, so the discriminator is never
// a top-level renderer-mirror cell; `attachOverrideMetadata` therefore can't
// stamp a `switchCases` / `enumVariants` widget on it, and `collectRefSwitches`
// only surfaced a packet-level picker when the discriminator was inside a plain
// repeat or inside a switch case (`switchCaseFieldIds`). A group-nested
// discriminator fell through every path: the user saw the flag bit AND the
// region the Switch selects, but had no enum dropdown, no SwitchDropdown, no
// refSwitch — the visible variants could not be selected.
//
// Fix: `collectGroupNestedFieldIds` collects ids declared inside a top-level
// Group (excluding repeat / switch-case scopes), and the field-nested refSwitch
// path now qualifies a Switch discriminated on one of those, exactly like the
// case-nested path. The surfaced picker's cases are ordered so the
// discriminator's declared default comes first (so `initialState`'s `cases[0]`
// seed agrees with the author's default rather than silently switching the load
// diagram to another arm).

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { initialState } from "@/lib/psdl/renderer-helpers";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

/** Cell ids the diagram resolves for a given env, the way the live app derives
 *  it (initialEnv defaults, then a 0-fill for every ref). */
function cellGeometry(
  psdl: PsdlPacket,
  overrides: Record<string, number>,
): string[] {
  const env = new Map<string, number>(Object.entries(overrides));
  for (const [k, v] of initialEnv(psdl)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  return resolveLayout(psdl, { env }).cells.flatMap((c) => [
    c.field.id,
    ...(c.subCells ?? []).map((s) => s.subfield.id),
  ]);
}

// DCCP-shaped: the 1-bit `x` flag lives inside `flagsGroup`, and a top-level
// `seqNum` Switch selects a 24-bit vs 48-bit Sequence Number on it.
const dccp: PsdlPacket = {
  name: "dccp",
  rowBits: 32,
  body: [
    {
      kind: "group",
      id: "flagsGroup",
      children: [
        { id: "x", name: "X", type: { kind: "int", bits: 1 } },
        { id: "reserved", name: "Reserved", type: { kind: "int", bits: 7 } },
      ],
    },
    {
      kind: "switch",
      id: "seqNum",
      name: "Sequence Number",
      on: { kind: "ref", field: "x" },
      cases: {
        "0": {
          id: "seq24",
          fields: [
            {
              id: "seqShort",
              name: "Sequence Number",
              type: { kind: "int", bits: 24 },
            },
          ],
        },
        "1": {
          id: "seq48",
          fields: [
            {
              id: "reserved2",
              name: "Reserved",
              type: { kind: "int", bits: 8 },
            },
            {
              id: "seqLong",
              name: "Sequence Number",
              type: { kind: "int", bits: 48 },
            },
          ],
        },
      },
    },
  ],
} as unknown as PsdlPacket;

// LISP-shaped: three single-bit flags inside `lispFlags`, each selecting a
// distinct region via its own top-level Switch.
const lisp: PsdlPacket = {
  name: "lisp",
  rowBits: 32,
  body: [
    {
      kind: "group",
      id: "lispFlags",
      children: [
        { id: "lispV", name: "V", type: { kind: "int", bits: 1 } },
        { id: "lispI", name: "I", type: { kind: "int", bits: 1 } },
        { id: "lispN", name: "N", type: { kind: "int", bits: 1 } },
        { id: "lispRest", name: "Flags", type: { kind: "int", bits: 5 } },
      ],
    },
    {
      kind: "switch",
      id: "byLispV",
      name: "Map-Version",
      on: { kind: "ref", field: "lispV" },
      cases: {
        "0": {
          id: "noVersion",
          fields: [
            {
              id: "vReserved",
              name: "Reserved",
              type: { kind: "int", bits: 24 },
            },
          ],
        },
        "1": {
          id: "withVersion",
          fields: [
            {
              id: "srcMapVersion",
              name: "Source Map-Version",
              type: { kind: "int", bits: 12 },
            },
            {
              id: "dstMapVersion",
              name: "Dest Map-Version",
              type: { kind: "int", bits: 12 },
            },
          ],
        },
      },
    },
    {
      kind: "switch",
      id: "byLispI",
      name: "Instance ID",
      on: { kind: "ref", field: "lispI" },
      cases: {
        "0": { id: "noInstance", fields: [] },
        "1": {
          id: "withInstance",
          fields: [
            {
              id: "instanceId",
              name: "Instance ID",
              type: { kind: "int", bits: 24 },
            },
          ],
        },
      },
    },
  ],
} as unknown as PsdlPacket;

describe("group-nested switch discriminator surfaces a refSwitch", () => {
  it("dccp: the `x` flag bit inside flagsGroup gets a variant picker", () => {
    const m = psdlToRenderer(dccp);
    const rs = (m.refSwitches ?? []).find((r) => r.refKey === "x");
    expect(
      rs,
      "a refSwitch keyed on the group-nested `x` must be surfaced",
    ).toBeTruthy();
    expect(rs!.cases.map((c) => c.value).sort()).toEqual([0, 1]);
  });

  it("dccp: selecting each `x` value changes resolveLayout geometry", () => {
    const at0 = cellGeometry(dccp, { x: 0 });
    const at1 = cellGeometry(dccp, { x: 1 });
    // x=0 → a single 24-bit Sequence Number; x=1 → 8-bit Reserved + 48-bit Seq.
    expect(at1).not.toEqual(at0);
    expect(at0).toContain("seqShort");
    expect(at1).toContain("seqLong");
  });

  it("lisp: lispV and lispI flags inside lispFlags each get a picker", () => {
    const m = psdlToRenderer(lisp);
    const keys = (m.refSwitches ?? []).map((r) => r.refKey);
    expect(keys).toContain("lispV");
    expect(keys).toContain("lispI");
  });

  it("lisp: selecting each flag value changes resolveLayout geometry", () => {
    const vOff = cellGeometry(lisp, { lispV: 0, lispI: 0 });
    const vOn = cellGeometry(lisp, { lispV: 1, lispI: 0 });
    const iOn = cellGeometry(lisp, { lispV: 0, lispI: 1 });
    expect(vOn).not.toEqual(vOff);
    expect(iOn).not.toEqual(vOff);
    expect(vOn).toContain("srcMapVersion");
    expect(iOn).toContain("instanceId");
  });

  it("does not surface a duplicate when the variants are byte-identical", () => {
    // An all-identical-arm switch on a group flag is inert — no picker.
    const inert: PsdlPacket = {
      name: "inert",
      rowBits: 32,
      body: [
        {
          kind: "group",
          id: "g",
          children: [{ id: "f", name: "F", type: { kind: "int", bits: 1 } }],
        },
        {
          kind: "switch",
          id: "sw",
          name: "Sw",
          on: { kind: "ref", field: "f" },
          cases: {
            "0": {
              id: "a",
              fields: [{ id: "x0", name: "X", type: { kind: "int", bits: 8 } }],
            },
            "1": {
              id: "b",
              fields: [{ id: "x1", name: "X", type: { kind: "int", bits: 8 } }],
            },
          },
        },
      ],
    } as unknown as PsdlPacket;
    const m = psdlToRenderer(inert);
    expect((m.refSwitches ?? []).some((r) => r.refKey === "f")).toBe(false);
  });
});

describe("pgm: group-nested pgmType discriminator", () => {
  it("surfaces a pgmType picker and respects its declared default ordering", () => {
    const m = psdlToRenderer(PRESETS.pgm!);
    const rs = (m.refSwitches ?? []).find((r) => r.refKey === "pgmType");
    expect(
      rs,
      "pgmType (inside pgmCommonHeader group) must get a picker",
    ).toBeTruthy();
    // initialState seeds cases[0]; that seed must equal the field's declared
    // default (ODATA = 4) so the load diagram does not switch to another arm.
    const declared = initialEnv(PRESETS.pgm!).get("pgmType");
    expect(declared).toBeDefined();
    expect(rs!.cases[0]!.value).toBe(declared);
    expect(initialState(m).pgmType).toBe(declared);
  });
});
