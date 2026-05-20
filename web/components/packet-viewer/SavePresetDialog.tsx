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
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.45)" }}
      role="dialog"
      aria-modal="true"
      aria-label="Save as my preset"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(name);
        }}
        className="rounded-[10px] border p-4 min-w-[320px]"
        style={{
          background: "var(--bg-elevated)",
          borderColor: "var(--border-strong)",
          color: "var(--fg)",
        }}
      >
        <h3 className="m-0 mb-3 text-sm font-bold">Save as my preset</h3>
        <label className="flex flex-col gap-1 text-sm">
          <span>Preset name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="text-sm px-2.5 py-1.5 rounded-md border"
            style={{
              borderColor: "var(--border-strong)",
              background: "var(--bg)",
              color: "var(--fg)",
            }}
            autoFocus
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="tb-btn text-sm font-medium px-2.5 py-1.5 rounded-md border bg-bg-elevated text-fg border-border-strong"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim()}
            className="tb-btn text-sm font-medium px-2.5 py-1.5 rounded-md border bg-accent text-accent-fg border-accent"
          >
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
