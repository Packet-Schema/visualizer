"use client";

// Worksheet export button. Compiles the worksheet Typst template via
// typst.ts (WASM) and opens the resulting PDF blob in a new tab.

import { useState } from "react";

import type { ControllerState, Packet } from "@/lib/psml/renderer";
import { rendererToPsml } from "@/lib/psml/psml-to-renderer";

type Props = {
  packet: Packet;
  controllers: ControllerState;
  className?: string;
};

export default function WorksheetButton({
  packet,
  controllers,
  className,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const generate = async (answers: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      // Lazy import keeps the WASM bundle out of the initial page chunk.
      const { generateWorksheetPdf } = await import("@/lib/worksheet-typst");
      // The worksheet generator speaks PSML; lower the runtime packet on the
      // way out and translate the controller state into a PacketEnv map.
      const env = new Map<string, number>(Object.entries(controllers));
      const blob = await generateWorksheetPdf(rendererToPsml(packet), env, { answers });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      // Revoke shortly after open; the new tab has already taken ownership.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={className} style={{ display: "inline-flex", gap: 6 }}>
      <button
        type="button"
        onClick={() => generate(false)}
        disabled={busy}
        title="Generate a blank worksheet PDF for printing"
        className="text-[12px] px-2.5 py-1 rounded border"
        style={{
          borderColor: "var(--border-strong)",
          background: "var(--bg-elevated)",
          color: "var(--fg)",
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? "…" : "Worksheet"}
      </button>
      <button
        type="button"
        onClick={() => generate(true)}
        disabled={busy}
        title="Generate the answer key PDF"
        className="text-[12px] px-2.5 py-1 rounded border"
        style={{
          borderColor: "var(--border-strong)",
          background: "var(--bg-elevated)",
          color: "var(--fg)",
          opacity: busy ? 0.6 : 1,
        }}
      >
        Answer key
      </button>
      {err ? (
        <span
          className="text-[11px] self-center"
          style={{ color: "var(--danger, #c33)" }}
          title={err}
        >
          PDF failed
        </span>
      ) : null}
    </div>
  );
}
