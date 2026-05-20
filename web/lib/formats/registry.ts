// Format adapter registry.
//
// Each entry plugs an external packet representation into Packet View through
// a uniform shape. The ImportExportDrawer iterates the registry to populate
// its format picker and dispatch import/export, so adding a new format is
// just adding one entry here (and writing the codec module it points at).
//
// Adapters omit `parse` to signal "export only" (e.g. RFC ASCII, which we
// emit but never parse) and omit `render` to signal "import only" (e.g.
// AAD, where we have no canonical writer back to the source text). See the
// `FormatAdapter` definition below for the actual property names.

import { fromAad } from "./aug-ascii";
import { fromJson, toJson } from "./json";
import { fromKsy, toKsy } from "./ksy";
import { toAscii } from "./rfc-ascii";
import type { PacketEnv, Packet as PsmlPacket } from "../psml/types";
import { validatePsmlPacket } from "../psml/validate";

export type FormatKey =
  | "json"
  | "rfc-ascii"
  | "aug-ascii"
  | "ksy"
  | "svg"
  | "png";

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
  /** Whether the adapter should appear in the Export selector even if it
   *  does not use the text-rendering pipeline (e.g. diagram image export). */
  exportable?: boolean;
  /** Extension used by the download workflow. Includes any compound suffix
   *  (e.g. `psml.json`) so the same string round-trips through `extToFormat`. */
  extension: string;
  /** MIME type for `Blob` downloads. */
  mime: string;
  /** Parse text into a PSML packet. Absent → the format is export-only
   *  (the Import tab's selector hides it). */
  parse?: (text: string) => ImportResult;
  /** Render a PSML packet to text. Absent → the format is import-only
   *  (the Export tab's selector hides it). */
  render?: (packet: PsmlPacket, env: PacketEnv) => string;
};

/**
 * Run the structural PSML validator on a parsed packet before handing it
 * downstream. Each adapter's underlying codec (fromJson / fromAad /
 * fromKsy) trusts the structural shape it returns, but the inputs that
 * reach `parse` are user files / drops / pastes that may be malformed;
 * letting them through to `psmlToRenderer` / `normalize` surfaces the
 * error several call sites away. Throwing here keeps the failure
 * adjacent to the user action that caused it.
 */
function validated(result: ImportResult): ImportResult {
  validatePsmlPacket(result.packet);
  return result;
}

export const FORMATS: ReadonlyArray<FormatAdapter> = [
  {
    id: "json",
    label: "JSON",
    extension: "psml.json",
    mime: "application/json",
    parse: (text) => {
      const { packet, env } = fromJson(text);
      return validated({ packet, env });
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
      return validated({ packet, warnings });
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
      return validated({ packet, warnings });
    },
    render: (packet) => toKsy(packet),
  },
  {
    id: "svg",
    label: "Image (SVG)",
    exportable: true,
    extension: "svg",
    mime: "image/svg+xml",
  },
  {
    id: "png",
    label: "Image (PNG)",
    exportable: true,
    extension: "png",
    mime: "image/png",
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
export const EXPORTABLE_FORMATS = FORMATS.filter(
  (f) => f.exportable === true || !!f.render,
).map((f) => f.id);

// Precompute the (`.ext` → FormatKey) lookup once at module load — sorted by
// extension length descending so compound suffixes like `.psml.json` match
// before the friendlier `.json` fallback below. The earlier in-function sort
// allocated a fresh copy of `FORMATS` and re-sorted on every drop / file
// selection; this list is FORMATS-stable so a single shared array is safe.
const EXT_LOOKUP: ReadonlyArray<readonly [string, FormatKey]> = [...FORMATS]
  .sort((a, b) => b.extension.length - a.extension.length)
  .map((f) => [`.${f.extension}`, f.id] as const);

/**
 * File extension → FormatKey for download/upload round-trip. Recognises both
 * the canonical extensions and a couple of friendly aliases ('.json' alone is
 * treated as PSML JSON because that's what users get when they export).
 */
export function extToFormat(filename: string): FormatKey | null {
  if (typeof filename !== "string") return null;
  const lower = filename.toLowerCase();
  for (const [ext, id] of EXT_LOOKUP) {
    if (lower.endsWith(ext)) return id;
  }
  // Friendly aliases.
  if (lower.endsWith(".json")) return "json";
  return null;
}
