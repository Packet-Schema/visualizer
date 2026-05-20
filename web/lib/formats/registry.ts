// Format adapter registry.
//
// Each entry plugs an external packet representation into Packet View through
// a uniform shape. The ImportExportDrawer iterates the registry to populate
// its format picker and dispatch import/export, so adding a new format is
// just adding one entry here (and writing the codec module it points at).
//
// Adapters omit `import` to signal "export only" (e.g. RFC ASCII, which we
// emit but never parse) and omit `export` to signal "import only" (e.g. AAD,
// where we have no canonical writer back to the source text).

import { fromAad } from "./aug-ascii";
import { fromJson, toJson } from "./json";
import { fromKsy, toKsy } from "./ksy";
import { toAscii } from "./rfc-ascii";
import type { PacketEnv, Packet as PsmlPacket } from "../psml/types";

export type FormatKey = "json" | "rfc-ascii" | "aug-ascii" | "ksy";

export type ImportResult = {
  packet: PsmlPacket;
  /** Controllers reconstructed from the source text, if any. */
  env?: PacketEnv;
  /** Non-fatal lossy notes. */
  warnings?: string[];
};

export type FormatAdapter = {
  id: FormatKey;
  label: string;
  /** Extension used by the download workflow. Includes any compound suffix
   *  (e.g. `psml.json`) so the same string round-trips through `extToFormat`. */
  extension: string;
  /** MIME type for `Blob` downloads. */
  mime: string;
  /** Parse text into a PSML packet. Absent → import-only switch is hidden. */
  parse?: (text: string) => ImportResult;
  /** Render a PSML packet to text. Absent → export-only switch is hidden. */
  render?: (packet: PsmlPacket, env: PacketEnv) => string;
};

export const FORMATS: ReadonlyArray<FormatAdapter> = [
  {
    id: "json",
    label: "JSON",
    extension: "psml.json",
    mime: "application/json",
    parse: (text) => {
      const { packet, env } = fromJson(text);
      return { packet, env };
    },
    render: (packet, env) => toJson(packet, env),
  },
  {
    id: "rfc-ascii",
    label: "RFC ASCII",
    extension: "txt",
    mime: "text/plain",
    // No importer — rfc-ascii is a presentational render-only format.
    render: (packet, env) => toAscii(packet, env),
  },
  {
    id: "aug-ascii",
    label: "AAD (Augmented ASCII)",
    extension: "aad",
    mime: "text/plain",
    parse: (text) => {
      const { packet, warnings } = fromAad(text);
      return { packet, warnings };
    },
    // No exporter — AAD is read-only (no canonical writer yet).
  },
  {
    id: "ksy",
    label: "Kaitai (.ksy)",
    extension: "ksy",
    mime: "text/plain",
    parse: (text) => {
      const { packet, warnings } = fromKsy(text);
      return { packet, warnings };
    },
    render: (packet) => toKsy(packet),
  },
];

const BY_ID = new Map(FORMATS.map((f) => [f.id, f] as const));

export function getFormat(id: FormatKey): FormatAdapter {
  const f = BY_ID.get(id);
  if (!f) throw new Error(`Unknown format: ${id}`);
  return f;
}

export const IMPORTABLE_FORMATS = FORMATS.filter((f) => !!f.parse).map(
  (f) => f.id,
);
export const EXPORTABLE_FORMATS = FORMATS.filter((f) => !!f.render).map(
  (f) => f.id,
);

/**
 * File extension → FormatKey for download/upload round-trip. Recognises both
 * the canonical extensions and a couple of friendly aliases ('.json' alone is
 * treated as PSML JSON because that's what users get when they export).
 */
export function extToFormat(filename: string): FormatKey | null {
  if (typeof filename !== "string") return null;
  const lower = filename.toLowerCase();
  // Compound extensions first so e.g. `*.psml.json` doesn't fall through to `*.json`.
  const sorted = [...FORMATS].sort(
    (a, b) => b.extension.length - a.extension.length,
  );
  for (const f of sorted) {
    if (lower.endsWith(`.${f.extension}`)) return f.id;
  }
  // Friendly aliases.
  if (lower.endsWith(".json")) return "json";
  return null;
}
