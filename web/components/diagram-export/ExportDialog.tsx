"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  buildDiagramSvg,
  downloadBlobFile,
  downloadTextFile,
  readDiagramTheme,
  svgToPngBlob,
} from "@/lib/diagram-export";
import { useDrawerFocusTrap } from "@/components/import-export/hooks/useDrawerFocusTrap";
import { slugify } from "@/lib/preset-file-io";
import type { Packet, ResolvedLayout } from "@/lib/psml/renderer";

type Props = {
  packet: Packet;
  layout: ResolvedLayout;
  open: boolean;
  onClose: () => void;
};

type DiagramWidth = 24 | 32 | 40;
type SaveFormat = "svg" | "png";
type ExportThemeMode = "follow-ui" | "light" | "dark";
type DiagramExportSettings = {
  format: SaveFormat;
  exportThemeMode: ExportThemeMode;
  pngScale: number;
  diagramWidth: DiagramWidth;
  transparentBackground: boolean;
};

const SETTINGS_STORAGE_KEY = "packet-view-diagram-export-settings-v1";
const DEFAULT_SETTINGS: DiagramExportSettings = {
  format: "svg",
  exportThemeMode: "follow-ui",
  pngScale: 2,
  diagramWidth: 32,
  transparentBackground: false,
};
const PNG_SCALE_MIN = 1;
const PNG_SCALE_MAX = 8;
const PNG_SCALE_STEP = 1;

const SELECT_CLASS =
  "mt-1 h-9 w-full rounded-md border px-2 text-xs bg-bg-elevated text-fg border-border";

function isSaveFormat(value: unknown): value is SaveFormat {
  return value === "svg" || value === "png";
}

function isDiagramWidth(value: unknown): value is DiagramWidth {
  return value === 24 || value === 32 || value === 40;
}

function isExportThemeMode(value: unknown): value is ExportThemeMode {
  return value === "follow-ui" || value === "light" || value === "dark";
}

function isPngScale(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= PNG_SCALE_MIN &&
    value <= PNG_SCALE_MAX &&
    Number.isInteger(value / PNG_SCALE_STEP)
  );
}

function loadSettings(): DiagramExportSettings {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_SETTINGS;
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<DiagramExportSettings> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return DEFAULT_SETTINGS;
    }
    return {
      format: isSaveFormat(parsed.format)
        ? parsed.format
        : DEFAULT_SETTINGS.format,
      exportThemeMode: isExportThemeMode(parsed.exportThemeMode)
        ? parsed.exportThemeMode
        : DEFAULT_SETTINGS.exportThemeMode,
      pngScale: isPngScale(parsed.pngScale)
        ? parsed.pngScale
        : DEFAULT_SETTINGS.pngScale,
      diagramWidth: isDiagramWidth(parsed.diagramWidth)
        ? parsed.diagramWidth
        : DEFAULT_SETTINGS.diagramWidth,
      transparentBackground:
        typeof parsed.transparentBackground === "boolean"
          ? parsed.transparentBackground
          : DEFAULT_SETTINGS.transparentBackground,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: DiagramExportSettings): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore unavailable or quota-limited storage; export still works.
  }
}

export default function ExportDialog({ packet, layout, open, onClose }: Props) {
  const [settings, setSettings] = useState<DiagramExportSettings>(loadSettings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  // Increments on every open/close transition. Used as the single source
  // of truth for "is the in-flight PNG encode still relevant?" — see
  // handlePngDownload.
  const exportSessionRef = useRef(0);
  const titleId = useId();
  const pngScaleId = useId();

  useDrawerFocusTrap({ open, containerRef: cardRef, onClose });

  useEffect(() => {
    exportSessionRef.current += 1;
    setBusy(false);
    if (open) setError(null);
  }, [open]);

  // Coalesce localStorage writes so a single slider drag (which can emit
  // 30-60 onChange events) doesn't trigger that many synchronous
  // JSON.stringify + setItem cycles. The trailing 200ms timeout also
  // collapses rapid select changes during a multi-step settings tweak.
  useEffect(() => {
    const handle = setTimeout(() => saveSettings(settings), 200);
    return () => clearTimeout(handle);
  }, [settings]);

  // SVG generation is O(packet cells) — rebuild only when the inputs that
  // actually change the diagram change. `busy`/`error` etc. must not
  // invalidate the memo.
  const svg = useMemo(() => {
    if (!open) return null;
    return buildDiagramSvg(packet, layout, {
      theme: readDiagramTheme(settings.exportThemeMode),
      bitWidth: settings.diagramWidth,
      transparentBackground: settings.transparentBackground,
    });
  }, [
    open,
    packet,
    layout,
    settings.exportThemeMode,
    settings.diagramWidth,
    settings.transparentBackground,
  ]);

  const handleSvgDownload = useCallback(() => {
    if (!svg) return;
    const filename = `${slugify(packet.name)}-diagram.svg`;
    downloadTextFile(filename, "image/svg+xml", svg);
    onClose();
  }, [packet.name, svg, onClose]);

  const handlePngDownload = useCallback(async () => {
    if (!svg) return;
    // Use the session counter as the sole staleness gate. It increments on
    // every open/close transition, so an in-flight PNG encode that resolves
    // after the dialog has closed or been re-opened will see a session
    // mismatch and bail out.
    const exportSession = exportSessionRef.current;
    const isCurrent = () => exportSessionRef.current === exportSession;
    setBusy(true);
    setError(null);
    try {
      const png = await svgToPngBlob(svg, settings.pngScale);
      if (!isCurrent()) return;
      const filename = `${slugify(packet.name)}-diagram-${settings.pngScale}x.png`;
      downloadBlobFile(filename, png);
      onClose();
    } catch (caught) {
      if (!isCurrent()) return;
      console.error("Failed to export diagram as PNG.", caught);
      setError("PNG export failed. Please try SVG or another browser.");
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }, [packet.name, settings.pngScale, svg, onClose]);

  const handleSave = useCallback(() => {
    if (settings.format === "svg") {
      handleSvgDownload();
      return;
    }
    void handlePngDownload();
  }, [handlePngDownload, handleSvgDownload, settings.format]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: "oklch(18% 0.03 270 / 0.45)" }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(e) => {
        // Only close when the click both starts and ends on the backdrop
        // — `e.target === e.currentTarget` ensures we don't fire when a
        // pointer was pressed inside the card and released on the
        // backdrop (e.g. text-selection drag).
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        className="w-full max-w-xl rounded-xl border p-4 bg-bg-elevated text-fg border-border"
        style={{ boxShadow: "0 10px 25px rgba(0,0,0,0.12)" }}
      >
        <h3 id={titleId} className="m-0 mb-3 text-sm font-semibold">
          Save image
        </h3>
        <div
          className="diagram-export-preview mb-3 overflow-hidden rounded-lg border p-2 bg-bg border-border"
          aria-label="Diagram preview"
          dangerouslySetInnerHTML={{ __html: svg ?? "" }}
        />
        <div className="grid gap-2">
          <label className="text-xs">
            Format
            <select
              value={settings.format}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  format: event.target.value as SaveFormat,
                }))
              }
              className={SELECT_CLASS}
            >
              <option value="svg">SVG</option>
              <option value="png">PNG</option>
            </select>
          </label>
          <label className="text-xs">
            Theme for saved image
            <select
              value={settings.exportThemeMode}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  exportThemeMode: event.target.value as ExportThemeMode,
                }))
              }
              className={SELECT_CLASS}
            >
              <option value="follow-ui">Follow UI theme</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label className="text-xs">
            Width
            <select
              value={settings.diagramWidth}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  diagramWidth: Number(event.target.value) as DiagramWidth,
                }))
              }
              className={SELECT_CLASS}
            >
              <option value={24}>Standard width</option>
              <option value={32}>Wide width</option>
              <option value={40}>Extra wide</option>
            </select>
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2 py-1 text-xs">
            <input
              type="checkbox"
              checked={settings.transparentBackground}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  transparentBackground: event.target.checked,
                }))
              }
              className="pv-switch-input"
            />
            <span className="pv-switch-track" aria-hidden="true" />
            Transparent background
          </label>
        </div>
        {settings.format === "png" ? (
          <div className="mt-3 rounded-lg border p-3 border-border">
            <label className="text-xs" htmlFor={pngScaleId}>
              PNG resolution
            </label>
            <div className="mt-1 flex items-center gap-3">
              <div className="pv-slider-wrap flex-1">
                <input
                  id={pngScaleId}
                  type="range"
                  min={PNG_SCALE_MIN}
                  max={PNG_SCALE_MAX}
                  step={PNG_SCALE_STEP}
                  value={settings.pngScale}
                  aria-valuetext={`${settings.pngScale} times`}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      pngScale: Number(event.target.value),
                    }))
                  }
                  className="pv-slider"
                />
              </div>
              <output
                htmlFor={pngScaleId}
                aria-live="polite"
                className="min-w-10 text-right"
              >
                {settings.pngScale}x
              </output>
            </div>
          </div>
        ) : null}
        {error ? (
          <p
            className="mb-0 mt-3 text-xs text-field-rose-strong"
            role="alert"
          >
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="tb-btn text-sm font-medium px-2.5 py-1.5 rounded-md border bg-bg-elevated text-fg border-border-strong"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={settings.format === "png" && busy}
            aria-disabled={settings.format === "png" && busy}
            className="tb-btn text-sm font-medium px-2.5 py-1.5 rounded-md border bg-accent text-accent-fg border-accent disabled:cursor-not-allowed disabled:opacity-80"
          >
            {settings.format === "svg"
              ? "Save SVG"
              : busy
                ? "Saving…"
                : "Save PNG"}
          </button>
        </div>
      </div>
    </div>
  );
}
