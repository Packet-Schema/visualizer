// Preset file I/O — helpers for downloading exported packet definitions and
// uploading them back through the Import drawer. Also defines the bundle
// envelope used for bulk export/import of the user's custom-preset library
// (see PacketViewer's 'My presets' bulk handlers).
//
// Scope: this module is browser-facing (uses Blob, FileReader, document) but
// all entry points guard for SSR / non-DOM environments so vitest's node
// runner doesn't crash when files import from here transitively.

import { getFormat, type FormatKey } from "./formats/registry";
import type { PsmlPacket } from "./psml/types";

// Re-export so callers don't have to know whether the extension lookup lives
// in the registry or in this preset I/O module — there is only one name.
export { extToFormat } from "./formats/registry";
export type { FormatKey } from "./formats/registry";

export const MY_PRESETS_FILE_FORMAT_VERSION = "psml-0.4" as const;

export type MyPresetsBundle = {
  schemaVersion: typeof MY_PRESETS_FILE_FORMAT_VERSION;
  exportedAt: string;
  presets: Record<string, PsmlPacket>;
};

/* ------------------------------------------------------------------ *
 * Filename helpers
 * ------------------------------------------------------------------ */

/**
 * Convert a packet name into a safe filename slug. Strips non-ASCII letters
 * and digits (so 'IPv4 Header' → 'ipv4-header' and '日本語' → 'untitled'),
 * collapses runs of non-alphanumerics into single hyphens, trims leading and
 * trailing hyphens, and lowercases. Returns 'untitled' when the input would
 * otherwise produce an empty string so downloads always have a filename.
 */
export function slugify(name: string): string {
  if (typeof name !== "string") return "untitled";
  // Allow any Unicode letter / number through (`\p{L}\p{N}` with the `u`
  // flag). The earlier `[^A-Za-z0-9]+` form treated Japanese / accented
  // names as one long run of separators, so 'IPv4ヘッダー' collapsed to
  // `ipv4---` (multiple hyphens) before trimming. The post-pass
  // `replace(/-+/g, "-")` then collapses any incidental runs (e.g. from
  // mixed ASCII / punctuation input) into a single hyphen.
  const replaced = name.replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase();
  const collapsed = replaced.replace(/-+/g, "-");
  const trimmed = collapsed.replace(/^-+|-+$/g, "");
  return trimmed.length > 0 ? trimmed : "untitled";
}

/**
 * Map a FormatKey to the file extension used in downloads. The PSML JSON
 * format takes a compound `.psml.json` extension so it round-trips through
 * `extToFormat` without ambiguity vs. the bulk-export `.json` envelope.
 *
 * Thin wrapper over the format registry — the source of truth is
 * `lib/formats/registry.ts`. Kept here so existing callers (and tests)
 * don't have to know about the adapter shape.
 */
export function formatToExtension(format: FormatKey): string {
  return getFormat(format).extension;
}

/* ------------------------------------------------------------------ *
 * Browser I/O
 * ------------------------------------------------------------------ */

/**
 * Trigger a file download in the browser. Builds a Blob from `content`,
 * creates an object URL, programmatically clicks an anchor, and revokes the
 * URL after a short delay so the browser has time to start the download.
 * No-ops in environments without `document` (SSR / node tests without
 * jsdom).
 */
export function downloadBlob(
  filename: string,
  mime: string,
  content: string,
): void {
  if (typeof document === "undefined" || typeof URL === "undefined") return;
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so Safari has time to actually fetch the blob.
  setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }, 1000);
}

/**
 * Promise-based wrapper around FileReader.readAsText. Rejects when the
 * underlying read errors or when called in a non-browser environment.
 */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof FileReader === "undefined") {
      reject(new Error("FileReader is not available in this environment."));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") {
        resolve(result);
      } else {
        reject(new Error("File could not be read as text."));
      }
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("File read failed."));
    };
    reader.readAsText(file);
  });
}

/* ------------------------------------------------------------------ *
 * Bundle helpers
 * ------------------------------------------------------------------ */

/** Build a MyPresetsBundle from a custom-presets map. */
export function buildMyPresetsBundle(
  presets: Record<string, PsmlPacket>,
): MyPresetsBundle {
  return {
    schemaVersion: MY_PRESETS_FILE_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    presets: { ...presets },
  };
}

/**
 * Validate that an arbitrary parsed-JSON value matches the MyPresetsBundle
 * shape. We're permissive about schemaVersion (accept any string) so older
 * exports still load; the presets map is the load-bearing part.
 */
export function isMyPresetsBundle(value: unknown): value is MyPresetsBundle {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.schemaVersion !== "string") return false;
  if (!v.presets || typeof v.presets !== "object" || Array.isArray(v.presets)) {
    return false;
  }
  return true;
}

/**
 * Resolve key collisions when merging an imported bundle with the existing
 * custom-presets store. Returns a fresh key derived from `desired` by
 * appending `-2`, `-3`, ... until it no longer collides with `existing`.
 */
export function uniqueKey(desired: string, existing: Set<string>): string {
  if (!existing.has(desired)) return desired;
  for (let i = 2; ; i++) {
    const candidate = `${desired}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
}
