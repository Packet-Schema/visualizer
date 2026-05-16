"use client";

import { PRESETS } from "@/lib/psml/presets";
import { PRESET_GROUPS } from "@/lib/constants";
import type { PacketRegistry } from "@/lib/psml/renderer";
import type { PsmlPacket } from "@/lib/psml/types";

type Props = {
  value: string;
  onChange: (key: string) => void;
  /** Runtime registry of imported packets, keyed e.g. as "imported:<name>". */
  imported?: PacketRegistry;
  /** User-saved presets from localStorage; keyed e.g. as "custom:<name>". */
  customPresets?: Record<string, PsmlPacket>;
  /** Bulk-export all custom presets to a single JSON file. */
  onExportCustomPresets?: () => void;
  /** Bulk-import custom presets from a JSON file. */
  onImportCustomPresets?: () => void;
};

export default function PresetPicker({
  value,
  onChange,
  imported,
  customPresets,
  onExportCustomPresets,
  onImportCustomPresets,
}: Props) {
  const assigned = new Set<string>();
  for (const group of PRESET_GROUPS) {
    for (const k of group.keys) assigned.add(k);
  }
  const otherKeys = Object.keys(PRESETS).filter((k) => !assigned.has(k));
  const importedEntries = imported ? Object.entries(imported) : [];
  const customEntries = customPresets ? Object.entries(customPresets) : [];

  // 'My presets' bulk I/O buttons live next to the picker rather than inside
  // the optgroup because <optgroup> can't host arbitrary children. Keeping
  // them adjacent preserves the discoverability the spec calls for without
  // breaking the native <select> semantics.
  const showBulkButtons =
    (onExportCustomPresets || onImportCustomPresets) !== undefined;

  return (
    <label className="flex items-center gap-2 text-sm font-semibold">
      <span>Preset:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="text-sm px-2.5 py-1.5 rounded-md border"
        style={{
          borderColor: "var(--border-strong)",
          background: "var(--bg-elevated)",
          color: "var(--fg)",
        }}
      >
        {PRESET_GROUPS.map((group) => {
          const keys = group.keys.filter((k) => PRESETS[k]);
          if (keys.length === 0) return null;
          return (
            <optgroup key={group.label} label={group.label}>
              {keys.map((key) => (
                <option key={key} value={key}>
                  {PRESETS[key].name}
                </option>
              ))}
            </optgroup>
          );
        })}
        {otherKeys.length > 0 ? (
          <optgroup label="Other">
            {otherKeys.map((key) => (
              <option key={key} value={key}>
                {PRESETS[key].name}
              </option>
            ))}
          </optgroup>
        ) : null}
        {/* My presets — slotted between Built-in and Imported per the
            Round 7 spec so user-owned packets feel first-class without
            displacing built-ins. */}
        {customEntries.length > 0 ? (
          <optgroup label="My presets">
            {customEntries.map(([key, pkt]) => (
              <option key={key} value={key}>
                {pkt.name}
              </option>
            ))}
          </optgroup>
        ) : null}
        {importedEntries.length > 0 ? (
          <optgroup label="Imported">
            {importedEntries.map(([key, pkt]) => (
              <option key={key} value={key}>
                {pkt.name}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
      {showBulkButtons ? (
        <span
          className="flex items-center gap-1 text-xs font-normal"
          style={{ color: "var(--fg-muted)" }}
        >
          <span aria-hidden="true">My presets:</span>
          {onExportCustomPresets ? (
            <button
              type="button"
              onClick={onExportCustomPresets}
              disabled={customEntries.length === 0}
              aria-label="Download all my presets as JSON"
              title="Download all my presets"
              className="rounded-md w-6 h-6 flex items-center justify-center border"
              style={{
                background: "transparent",
                color: "var(--fg)",
                borderColor: "var(--border-strong)",
                opacity: customEntries.length === 0 ? 0.4 : 1,
                cursor: customEntries.length === 0 ? "not-allowed" : "pointer",
              }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
          ) : null}
          {onImportCustomPresets ? (
            <button
              type="button"
              onClick={onImportCustomPresets}
              aria-label="Upload my-presets JSON file"
              title="Upload my-presets JSON"
              className="rounded-md w-6 h-6 flex items-center justify-center border"
              style={{
                background: "transparent",
                color: "var(--fg)",
                borderColor: "var(--border-strong)",
              }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </button>
          ) : null}
        </span>
      ) : null}
    </label>
  );
}
