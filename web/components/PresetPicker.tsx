"use client";

import { PRESETS } from "@/lib/presets.generated";
import { PRESET_GROUPS } from "@/lib/constants";

type Props = {
  value: string;
  onChange: (key: string) => void;
};

export default function PresetPicker({ value, onChange }: Props) {
  const assigned = new Set<string>();
  for (const group of PRESET_GROUPS) {
    for (const k of group.keys) assigned.add(k);
  }
  const otherKeys = Object.keys(PRESETS).filter((k) => !assigned.has(k));

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
      </select>
    </label>
  );
}
