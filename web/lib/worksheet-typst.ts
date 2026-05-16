// Worksheet PDF generator (Typst.ts).
//
// Compiles `data/worksheet.typ` with the resolved packet data passed via
// `sys.inputs`. Uses the `$typst` snippet API; we lazy-import the WASM
// modules so they don't bloat the initial bundle.
//
// Browser-only: `@myriaddreamin/typst.ts` ships WASM that fetches assets
// from a CDN at runtime. Node-side smoke tests will catch the helper's
// signature and Typst template parse but cannot actually run the WASM
// renderer headlessly without additional plumbing.

import type { ControllerState, Packet } from "./types";
import { resolvePacket } from "./packet-resolver";
import { WORKSHEET_TYPST_SOURCE } from "./worksheet-template";

export type WorksheetOpts = {
  answers?: boolean;
};

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
  packet: Packet,
  controllers: ControllerState,
): { name: string; description: string; fields: FieldSummary[] } {
  const layout = resolvePacket(packet, controllers);
  const cellsByFieldId = new Map<string, typeof layout.cells>();
  for (const cell of layout.cells) {
    if (!cellsByFieldId.has(cell.field.id)) cellsByFieldId.set(cell.field.id, []);
    cellsByFieldId.get(cell.field.id)!.push(cell);
  }

  const fields: FieldSummary[] = [];
  let bitOffset = 0;
  for (const field of packet.fields) {
    const cells = cellsByFieldId.get(field.id);
    if (!cells || cells.length === 0) continue;
    const bits = cells.reduce(
      (acc, c) => acc + (c.endBit - c.startBit + 1),
      0,
    );
    fields.push({
      id: field.id,
      name: field.name,
      bits,
      offset: bitOffset,
      description: field.description || "",
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
 * Generate a PDF Blob for the current packet. Lazy-loads `@myriaddreamin/typst.ts`
 * so the WASM bundle is only fetched when the user clicks the worksheet button.
 *
 * Browser-only — throws if `typeof window` is undefined.
 */
export async function generateWorksheetPdf(
  packet: Packet,
  controllers: ControllerState,
  opts: WorksheetOpts = {},
): Promise<Blob> {
  if (typeof window === "undefined") {
    throw new Error(
      "generateWorksheetPdf: WASM-backed compilation requires a browser environment.",
    );
  }
  const payload = buildWorksheetPayload(packet, controllers);

  // Dynamically import; keeps the WASM bundle out of the initial chunk.
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
  // Copy the bytes into a plain ArrayBuffer slice so we don't keep WASM
  // memory pinned via the returned view.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return new Blob([copy.buffer], { type: "application/pdf" });
}
