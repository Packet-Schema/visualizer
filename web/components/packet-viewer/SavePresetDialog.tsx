import { useState } from "react";

type Props = {
  defaultName: string;
  onCancel: () => void;
  onSubmit: (name: string) => void;
};

export default function SavePresetDialog({
  defaultName,
  onCancel,
  onSubmit,
}: Props) {
  const [name, setName] = useState(defaultName);
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: "oklch(18% 0.03 270 / 0.45)" }}
      role="dialog"
      aria-modal="true"
      aria-label="Save as my preset"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(name);
        }}
        className="w-full max-w-sm rounded-xl border p-4"
        style={{
          background: "var(--bg-elevated)",
          borderColor: "var(--border)",
          color: "var(--fg)",
          boxShadow: "0 10px 25px rgba(0,0,0,0.12)",
        }}
      >
        <h3 className="m-0 mb-3 text-sm font-semibold">Save as my preset</h3>
        <label className="block text-xs">
          <span>Preset name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 h-9 w-full rounded-md border px-2 text-sm"
            style={{
              borderColor: "var(--border)",
              background: "var(--bg-elevated)",
              color: "var(--fg)",
            }}
            autoFocus
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="tb-btn rounded-md border px-2.5 py-1.5 text-sm font-medium"
            style={{
              background: "var(--bg-elevated)",
              color: "var(--fg)",
              borderColor: "var(--border)",
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim()}
            className="tb-btn rounded-md border px-2.5 py-1.5 text-sm font-medium"
            style={{
              background: "var(--accent)",
              color: "var(--accent-fg)",
              borderColor: "var(--accent)",
            }}
          >
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
