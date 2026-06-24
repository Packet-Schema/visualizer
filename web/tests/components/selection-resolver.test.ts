// Unit tests for resolveSelection — the shared cell-id → Field/SubField
// resolver used by DetailPanel and OverridePanel.

import { describe, it, expect } from "vitest";

import { resolveSelection } from "@/components/field-details/selection-resolver";
import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import type { Cell } from "@/lib/psdl/renderer";

describe("resolveSelection", () => {
  const ipv4 = psdlToRenderer(PRESETS.ipv4!);

  it("returns empty for a null selection", () => {
    expect(resolveSelection(ipv4, null)).toEqual({ kind: "empty" });
  });

  it("resolves a plain top-level field", () => {
    const r = resolveSelection(ipv4, "options");
    expect(r.kind).toBe("field");
    if (r.kind === "field") expect(r.field.id).toBe("options");
  });

  it("resolves a TLV instance cell to its parent TLV field (Codex P2)", () => {
    // `options__inst_0` is a synthetic id minted by applyTlvInstances; it
    // doesn't exist on packet.fields. It must resolve back to the parent
    // `options` TLV field rather than returning field-not-found.
    const r = resolveSelection(ipv4, "options__inst_0");
    expect(r.kind).toBe("field");
    if (r.kind === "field") expect(r.field.id).toBe("options");
  });

  it("resolves a TLV leaf sub-cell (parent:sub synthetic) to the parent TLV", () => {
    // The diagram dispatches TLV leaf clicks as `<inst>:<inst>__<leaf>`.
    // Before the fix this produced subfield-not-found because the parent
    // half (`options__inst_0`) isn't a real field id.
    const r = resolveSelection(ipv4, "options__inst_0:options__inst_0__type");
    expect(r.kind).toBe("field");
    if (r.kind === "field") expect(r.field.id).toBe("options");
  });

  it("resolves a TLV remaining cell to the parent TLV field", () => {
    const r = resolveSelection(ipv4, "options__remaining");
    expect(r.kind).toBe("field");
    if (r.kind === "field") expect(r.field.id).toBe("options");
  });

  // override-audit A1: records inside a plain (non-TLV/non-chain) repeat have
  // no renderer-mirror field, so a click used to dead-end at "Field not found".
  // The resolver now falls back to the diagram cells, which carry every
  // rendered cell's id/name/bits straight from the normalized layout.
  it("falls back to the diagram cells for a leaf the mirror lacks (A1)", () => {
    const cells = [
      { field: { id: "dnsRrType#0", name: "Type", bits: 16 } },
    ] as unknown as Cell[];
    // The ipv4 mirror has no `dnsRrType#0` field.
    expect(resolveSelection(ipv4, "dnsRrType#0").kind).toBe("field-not-found");
    const r = resolveSelection(ipv4, "dnsRrType#0", cells);
    expect(r.kind).toBe("field");
    if (r.kind === "field") expect(r.field.name).toBe("Type");
  });

  it("falls back to a group sub-cell the mirror lacks (A1)", () => {
    const parentField = { id: "g#0", name: "Attr Flags", bits: 8 };
    const cells = [
      {
        field: parentField,
        subCells: [
          {
            id: "g#0:optional",
            parentField,
            subfield: { id: "optional", name: "Optional", bits: 1 },
          },
        ],
      },
    ] as unknown as Cell[];
    const r = resolveSelection(ipv4, "g#0:optional", cells);
    expect(r.kind).toBe("subfield");
    if (r.kind === "subfield") {
      expect(r.sub.name).toBe("Optional");
      expect(r.parent.name).toBe("Attr Flags");
    }
  });

  it("prefers the renderer mirror over cells when both resolve", () => {
    // A cell carrying a clashing id must not shadow a real mirror field.
    const cells = [
      { field: { id: "options", name: "WRONG", bits: 0 } },
    ] as unknown as Cell[];
    const r = resolveSelection(ipv4, "options", cells);
    expect(r.kind).toBe("field");
    if (r.kind === "field") expect(r.field.id).toBe("options");
  });
});
