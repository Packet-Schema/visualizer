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
};

export default function PresetPicker({
  value,
  onChange,
  imported,
  customPresets,
}: Props) {
  const assigned = new Set<string>();
  for (const group of PRESET_GROUPS) {
    for (const k of group.keys) assigned.add(k);
  }
  const otherKeys = Object.keys(PRESETS).filter((k) => !assigned.has(k));
  const importedEntries = imported ? Object.entries(imported) : [];
  const customEntries = customPresets ? Object.entries(customPresets) : [];

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
    </label>
  );
}
