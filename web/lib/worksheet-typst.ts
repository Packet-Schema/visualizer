// PSML 0.2 — worksheet PDF generator (Typst.ts).
//
// Compiles `data/worksheet.typ` against a PSML Packet via `sys.inputs`. Uses
// the `$typst` snippet API with a lazy WASM import so the Typst runtime is
// only fetched when the user clicks the worksheet button.
//
// Browser-only.

import type { PacketEnv, Packet as PsmlPacket } from "./psml/types";
import { resolveLayout } from "./psml/layout";
import { WORKSHEET_TYPST_SOURCE } from "./worksheet-template";

export type WorksheetOpts = { answers?: boolean };

type FieldSummary = {
  id: string;
  name: string;
  bits: number;
  offset: number;
  description: string;
};

/**
 * Build the JSON payload that the Typst template consumes via `sys.inputs`.
 * Exposed for tests.
 */
export function buildWorksheetPayload(
  packet: PsmlPacket,
  env?: PacketEnv,
): { name: string; description: string; fields: FieldSummary[] } {
  const layout = resolveLayout(packet, { env });
  const cellsByFieldId = new Map<string, typeof layout.cells>();
  for (const cell of layout.cells) {
    if (!cellsByFieldId.has(cell.field.id)) cellsByFieldId.set(cell.field.id, []);
    cellsByFieldId.get(cell.field.id)!.push(cell);
  }

  const fields: FieldSummary[] = [];
  let bitOffset = 0;
  // Collapse cells back to one entry per field id, in first-appearance order.
  const seen = new Set<string>();
  for (const cell of layout.cells) {
    if (seen.has(cell.field.id)) continue;
    seen.add(cell.field.id);
    const cells = cellsByFieldId.get(cell.field.id) ?? [];
    const bits = cells.reduce((acc, c) => acc + (c.endBit - c.startBit + 1), 0);
    fields.push({
      id: cell.field.id,
      name: cell.field.name,
      bits,
      offset: bitOffset,
      description: cell.field.description || "",
    });
    bitOffset += bits;
  }

  return {
    name: packet.name,
    description: packet.description || "",
    fields,
  };
}

/**
 * Generate a PDF Blob for the current packet. Lazy-loads
 * `@myriaddreamin/typst.ts` so the WASM bundle stays out of the initial
 * chunk. Browser-only — throws if `typeof window` is undefined.
 */
export async function generateWorksheetPdf(
  packet: PsmlPacket,
  env: PacketEnv,
  opts: WorksheetOpts = {},
): Promise<Blob> {
  if (typeof window === "undefined") {
    throw new Error(
      "generateWorksheetPdf: WASM-backed compilation requires a browser environment.",
    );
  }
  const payload = buildWorksheetPayload(packet, env);

  const mod = await import("@myriaddreamin/typst.ts");
  const $typst = mod.$typst;

  const bytes = await $typst.pdf({
    mainContent: WORKSHEET_TYPST_SOURCE,
    inputs: {
      packet: JSON.stringify(payload),
      answers: opts.answers ? "true" : "false",
    },
  });

  if (!bytes || bytes.byteLength === 0) {
    throw new Error("generateWorksheetPdf: Typst returned an empty PDF.");
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return new Blob([copy.buffer], { type: "application/pdf" });
}
