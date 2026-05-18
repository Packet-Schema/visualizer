"use client";

import { useState } from "react";
import type { Packet, ResolvedLayout } from "@/lib/psml/renderer";
import DiagramExportPopup from "./DiagramExportPopup";

type Props = {
  packet: Packet;
  layout: ResolvedLayout;
};

export default function DiagramExportControls({ packet, layout }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="tb-btn text-sm font-medium px-2.5 py-1.5 rounded-md border"
        style={{
          background: "var(--bg-elevated)",
          color: "var(--fg)",
          borderColor: "var(--border-strong)",
        }}
      >
        Save diagram
      </button>
      <DiagramExportPopup
        packet={packet}
        layout={layout}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
