// override-design-audit: a dynamic-width (varint / berLength / delimited) or
// enum leaf that lives inside a COLLAPSED Group whose parent the renderer mirror
// does NOT carry as a top-level field (a group nested inside another group, or a
// group emitted inside a repeat) resolves — via `resolveFromCells` — to the
// layout subcell. The flat-cell branch of `resolveLayout` stamps the
// dynamic-width / enum metadata onto its synthetic field, but the collapsed-group
// branch used to build its subfields WITHOUT merging those maps, so the subcell
// carried no `isBerLength` / `enumVariants` hint and OverridePanel rendered no
// WidthPicker / EnumDropdown even though `env[fieldId]` genuinely drives the cell
// (see-but-cannot-edit). This pins the metadata onto collapsed-group subfields.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { resolveLayout } from "@/lib/psdl/layout";
import { resolveSelection } from "@/components/field-details/selection-resolver";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import type { Cell } from "@/lib/psdl/renderer";

function resolveSub(preset: string, subCellId: string) {
  const packet = PRESETS[preset as keyof typeof PRESETS]!;
  const { cells } = resolveLayout(packet);
  const mirror = psdlToRenderer(packet);
  // Assert the cell is actually VISIBLE in the diagram (otherwise the test
  // would pass vacuously on a cell the user can't see / click).
  const visible = (cells as Cell[]).some((c) =>
    (c.subCells ?? []).some((sc) => sc.id === subCellId),
  );
  expect(visible).toBe(true);
  return resolveSelection(mirror, subCellId, cells);
}

describe("collapsed-group subfields keep width/enum editors", () => {
  // snmpv3 `msgFlagsLength` is a berLength leaf inside `msgFlagsGroup`, which is
  // itself nested inside `msgGlobalData` — the renderer mirror does not carry it
  // as a top-level field, so the subcell is the only override surface.
  it("stamps isBerLength on a berLength leaf in a nested group (snmpv3 msgFlagsGroup:msgFlagsLength)", () => {
    const r = resolveSub("snmpv3", "msgFlagsGroup:msgFlagsLength");
    expect(r.kind).toBe("subfield");
    if (r.kind === "subfield") expect(r.sub.isBerLength).toBe(true);
  });

  it("stamps isBerLength on a berLength leaf in a nested group (snmpv3 msgGlobalData:headerLength)", () => {
    const r = resolveSub("snmpv3", "msgGlobalData:headerLength");
    expect(r.kind).toBe("subfield");
    if (r.kind === "subfield") expect(r.sub.isBerLength).toBe(true);
  });

  // ipinip `outerProtocol` is an enum leaf inside the collapsed
  // `outerIpv4Header` group; pppoe `code` is an enum leaf inside `pppoeHeader`.
  // Both are see-but-cannot-edit without the enumVariants stamp.
  it("stamps enumVariants on an enum leaf in a collapsed group (ipinip outerIpv4Header:outerProtocol)", () => {
    const r = resolveSub("ipinip", "outerIpv4Header:outerProtocol");
    expect(r.kind).toBe("subfield");
    if (r.kind === "subfield") {
      expect(r.sub.enumVariants).toBeDefined();
      expect(Object.keys(r.sub.enumVariants ?? {}).length).toBeGreaterThan(0);
    }
  });

  it("stamps enumVariants on an enum leaf in a collapsed group (pppoe pppoeHeader:code)", () => {
    const r = resolveSub("pppoe", "pppoeHeader:code");
    expect(r.kind).toBe("subfield");
    if (r.kind === "subfield") {
      expect(r.sub.enumVariants).toBeDefined();
      expect(Object.keys(r.sub.enumVariants ?? {}).length).toBeGreaterThan(0);
    }
  });
});
