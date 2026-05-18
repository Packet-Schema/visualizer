"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildDiagramSvg,
  downloadBlobFile,
  downloadTextFile,
  readDiagramThemeFromDocument,
  svgToPngBlob,
} from "@/lib/diagram-export";
import { slugify } from "@/lib/preset-file-io";
import type { Packet, ResolvedLayout } from "@/lib/psml/renderer";

type Props = {
  packet: Packet;
  layout: ResolvedLayout;
  open: boolean;
  onClose: () => void;
};

type PngScale = 1 | 2 | 3;
type DiagramWidth = 24 | 32 | 40;

export default function DiagramExportPopup({
  packet,
  layout,
  open,
  onClose,
}: Props) {
  const [pngScale, setPngScale] = useState<PngScale>(2);
  const [diagramWidth, setDiagramWidth] = useState<DiagramWidth>(32);
  const [transparentBackground, setTransparentBackground] = useState(false);
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const svg = useMemo(
    () =>
      buildDiagramSvg(packet, layout, {
        theme: readDiagramThemeFromDocument(),
        bitWidth: diagramWidth,
        transparentBackground,
      }),
    [packet, layout, diagramWidth, transparentBackground],
  );

  const handleSvgDownload = useCallback(() => {
    const filename = `${slugify(packet.name)}-diagram.svg`;
    downloadTextFile(filename, "image/svg+xml", svg);
    onClose();
  }, [packet.name, svg, onClose]);

  const handlePngDownload = useCallback(async () => {
    setBusy(true);
    try {
      const png = await svgToPngBlob(svg, pngScale);
      const filename = `${slugify(packet.name)}-diagram-${pngScale}x.png`;
      downloadBlobFile(filename, png);
      onClose();
    } finally {
      setBusy(false);
    }
  }, [packet.name, pngScale, svg, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Diagram save options"
      onMouseDown={(e) => {
        if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
          onClose();
        }
      }}
    >
      <div
        ref={cardRef}
        className="w-full max-w-md rounded-xl border p-4"
        style={{
          background: "var(--bg-elevated)",
          borderColor: "var(--border)",
          boxShadow: "0 10px 25px rgba(0,0,0,0.12)",
        }}
      >
        <h3 className="m-0 mb-3 text-sm font-semibold">Save diagram</h3>
        <div className="grid gap-2">
          <label className="text-xs">
            Width
            <select
              value={diagramWidth}
              onChange={(event) =>
                setDiagramWidth(Number(event.target.value) as DiagramWidth)
              }
              className="mt-1 h-9 w-full rounded-md border px-2 text-xs"
              style={{
                background: "var(--bg-elevated)",
                borderColor: "var(--border)",
                color: "var(--fg)",
              }}
            >
              <option value={24}>Standard width</option>
              <option value={32}>Wide width</option>
              <option value={40}>Extra wide</option>
            </select>
          </label>
          <label className="text-xs">
            PNG resolution
            <select
              value={pngScale}
              onChange={(event) =>
                setPngScale(Number(event.target.value) as PngScale)
              }
              className="mt-1 h-9 w-full rounded-md border px-2 text-xs"
              style={{
                background: "var(--bg-elevated)",
                borderColor: "var(--border)",
                color: "var(--fg)",
              }}
            >
              <option value={1}>PNG 1×</option>
              <option value={2}>PNG 2×</option>
              <option value={3}>PNG 3×</option>
            </select>
          </label>
          <label className="inline-flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={transparentBackground}
              onChange={(event) => setTransparentBackground(event.target.checked)}
            />
            Transparent background
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border px-3 text-xs"
            style={{ borderColor: "var(--border)" }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSvgDownload}
            className="h-9 rounded-md border px-3 text-xs"
            style={{ borderColor: "var(--border)" }}
          >
            Save SVG
          </button>
          <button
            type="button"
            onClick={handlePngDownload}
            disabled={busy}
            className="h-9 rounded-md border px-3 text-xs disabled:opacity-60"
            style={{ borderColor: "var(--border)" }}
          >
            {busy ? "Saving…" : "Save PNG"}
          </button>
        </div>
      </div>
    </div>
  );
}
