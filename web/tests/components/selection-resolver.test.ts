// Unit tests for resolveSelection — the shared cell-id → Field/SubField
// resolver used by DetailPanel and OverridePanel.

import { describe, it, expect } from "vitest";

import { resolveSelection } from "@/components/field-details/selection-resolver";
import { PRESETS } from "@/lib/psdl/presets";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";

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
});
