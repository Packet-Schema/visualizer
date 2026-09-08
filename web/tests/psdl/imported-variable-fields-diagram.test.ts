// override-design-audit (critical, bar #2): an imported PSDL containing any
// variable-length field (`bytes(ref len)`, `bytes {delimiter}`, `bytes(remaining)`)
// rendered an INCOMPLETE diagram. PacketViewer's `targetPsdl` memo (the source fed
// to `resolveLayout`) did NOT consult `importedSources`: for an imported packet not
// in editMode (the default right after `handleImport`, which sets editMode=false and
// stores the parsed source only in `importedPackets` + `importedSources`, never in
// `customPresets`), `targetPsdl` fell back to the LOSSY `rendererToPsdl(packet)` —
// `to-psdl.ts` returns `[]` for `field.variable`, so every variable-length field was
// dropped from the diagram (see-but-cannot-even-see), and consequently from every
// override surface too.
//
// Fix: the non-editMode branch now prefers the retained import source via
// `mergeInstancesIntoPsdl(importedSource, packet)` before the lossy lift, mirroring
// `activePsdlPacket`. This test pins the load-bearing pipeline decision: for a source
// PSDL with each kind of variable field, the import-aware lift round-trips the field
// into `resolveLayout`'s cells, whereas the lossy `rendererToPsdl` path drops it.

import { describe, it, expect } from "vitest";

import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { rendererToPsdl } from "@/lib/psdl/psdl-to-renderer/to-psdl";
import { mergeInstancesIntoPsdl } from "@/lib/psdl/psdl-to-renderer/merge-instances";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { initialState } from "@/lib/psdl/renderer-helpers";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

/** Load-time env exactly as PacketViewer builds it: mirror seeds, then preset
 *  defaults, then a 0 fallback for every ref, plus test overrides. */
function loadEnv(
  src: PsdlPacket,
  overrides: Record<string, number> = {},
): Map<string, number> {
  const mirror = psdlToRenderer(src);
  const env = new Map<string, number>(
    Object.entries(initialState(mirror)).map(([k, v]) => [k, Number(v)]),
  );
  for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
  for (const [k, v] of Object.entries(overrides)) env.set(k, v);
  return env;
}

/** Distinct field ids present in the resolved diagram cells. */
function diagramFieldIds(
  src: PsdlPacket,
  overrides: Record<string, number> = {},
): Set<string> {
  const env = loadEnv(src, overrides);
  const { cells } = resolveLayout(src, { env });
  return new Set(cells.map((c) => c.field.id));
}

/** Reproduce PacketViewer's non-editMode `targetPsdl` decision for an imported
 *  packet: prefer the retained import source (the FIX), versus the lossy
 *  `rendererToPsdl` fallback (the BUG). */
function importedTargetPsdl(source: PsdlPacket): {
  fixed: PsdlPacket;
  lossy: PsdlPacket;
} {
  // `handleImport` stores the mirror in `importedPackets`; the diagram source is
  // built from that mirror (here `packet`).
  const mirror = psdlToRenderer(source);
  return {
    fixed: mergeInstancesIntoPsdl(source, mirror),
    lossy: rendererToPsdl(mirror),
  };
}

describe("imported PSDL with variable-length fields renders a complete diagram", () => {
  it("retains a bytes(ref len) payload that the lossy lift drops", () => {
    const source: PsdlPacket = {
      name: "Imported RefLen",
      rowBits: 8,
      body: [
        { id: "len", name: "Len", type: { kind: "int", bits: 8 } },
        {
          id: "payload",
          name: "Payload",
          type: { kind: "bytes", n: { kind: "ref", field: "len" } },
        },
      ],
    };
    const { fixed, lossy } = importedTargetPsdl(source);

    // The lossy fallback drops the variable payload entirely.
    expect(diagramFieldIds(lossy, { len: 4 })).not.toContain("payload");
    // The import-aware lift keeps it, so the diagram is complete.
    expect(diagramFieldIds(fixed, { len: 4 })).toContain("payload");
  });

  it("retains a delimiter-terminated bytes field that the lossy lift drops", () => {
    const source: PsdlPacket = {
      name: "Imported Delimited",
      rowBits: 8,
      body: [
        { id: "tag", name: "Tag", type: { kind: "int", bits: 8 } },
        {
          id: "label",
          name: "Label",
          type: { kind: "bytes", n: { delimiter: [0] } },
        },
      ],
    };
    const { fixed } = importedTargetPsdl(source);

    // The import-aware lift keeps the delimited field, so the diagram is
    // complete. (The source-less `rendererToPsdl` lift now also re-emits this
    // intrinsic-shape field rather than dropping it — see
    // sourceless-variable-roundtrip.test.ts — so we no longer assert the lossy
    // path drops it; bytes(ref len) below still demonstrates the lossy drop.)
    expect(diagramFieldIds(fixed)).toContain("label");
  });

  it("retains a bytes(remaining) tail that the lossy lift drops", () => {
    const source: PsdlPacket = {
      name: "Imported Remaining",
      rowBits: 8,
      body: [
        { id: "tag", name: "Tag", type: { kind: "int", bits: 8 } },
        {
          id: "rest",
          name: "Rest",
          type: { kind: "bytes", n: { kind: "remaining" } },
        },
      ],
    };
    const { fixed } = importedTargetPsdl(source);

    // The import-aware lift keeps the remaining tail, so the diagram is
    // complete. (The source-less `rendererToPsdl` lift now also re-emits this
    // intrinsic-shape field rather than dropping it — see
    // sourceless-variable-roundtrip.test.ts — so we no longer assert the lossy
    // path drops it; bytes(ref len) above still demonstrates the lossy drop.)
    expect(diagramFieldIds(fixed)).toContain("rest");
  });
});
