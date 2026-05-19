import { useEffect, useState } from "react";

import type { EditAction } from "@/lib/psml/edit-reducer";
import type { PsmlPacket } from "@/lib/psml/types";

type Props = {
  packet: PsmlPacket;
  dispatch: (a: EditAction) => void;
};

export default function JsonPane({ packet, dispatch }: Props) {
  const upstream = JSON.stringify(packet, null, 2);
  const [text, setText] = useState(upstream);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Sync from upstream when the parent packet changes and we're not actively
  // editing. We compare serialized forms so cosmetic key-order shifts don't
  // clobber unsaved local typing.
  useEffect(() => {
    if (!dirty) setText(upstream);
  }, [upstream, dirty]);

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setText(v);
    setDirty(true);
    try {
      const parsed = JSON.parse(v) as PsmlPacket;
      setError(null);
      dispatch({ type: "replace-packet", packet: parsed });
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section
      aria-label="JSON editor"
      className="flex flex-col gap-1 p-2 border-t"
      style={{
        background: "var(--bg-elevated)",
        borderColor: "var(--border-strong)",
      }}
    >
      <label
        className="text-xs"
        style={{ color: "var(--fg-muted)" }}
        htmlFor="psml-json-pane"
      >
        Packet JSON
      </label>
      <textarea
        id="psml-json-pane"
        aria-label="Packet JSON source"
        spellCheck={false}
        value={text}
        onChange={onChange}
        rows={20}
        className="text-xs font-mono px-2 py-2 rounded border w-full"
        style={{
          background: "var(--bg-subtle)",
          color: "var(--fg)",
          borderColor: error ? "var(--field-rose)" : "var(--border-strong)",
        }}
      />
      {error && (
        <p
          role="alert"
          className="text-xs"
          style={{ color: "var(--field-rose)" }}
        >
          JSON parse error: {error}
        </p>
      )}
    </section>
  );
}
