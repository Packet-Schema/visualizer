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
  if (typeof localStorage === "undefined") return DEFAULT_SETTINGS;
  try {
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
  if (typeof localStorage === "undefined") return;
  try {
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
  const firstControlRef = useRef<HTMLSelectElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const openRef = useRef(open);
  const exportSessionRef = useRef(0);
  const titleId = useId();

  useEffect(() => {
    openRef.current = open;
    if (!open) {
      exportSessionRef.current += 1;
      setBusy(false);
      return;
    }
    exportSessionRef.current += 1;
    setBusy(false);
    setError(null);
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    firstControlRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }

      if (e.key !== "Tab" || !cardRef.current) return;
      const focusable = cardRef.current.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previousFocusRef.current?.focus();
    };
  }, [open, onClose]);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const svg = useMemo(
    () =>
      open
        ? buildDiagramSvg(packet, layout, {
            theme: readDiagramTheme(settings.exportThemeMode),
            bitWidth: settings.diagramWidth,
            transparentBackground: settings.transparentBackground,
          })
        : null,
    [
      packet,
      layout,
      settings.diagramWidth,
      settings.exportThemeMode,
      settings.transparentBackground,
      open,
    ],
  );

  const handleSvgDownload = useCallback(() => {
    if (!svg) return;
    const filename = `${slugify(packet.name)}-diagram.svg`;
    downloadTextFile(filename, "image/svg+xml", svg);
    onClose();
  }, [packet.name, svg, onClose]);

  const handlePngDownload = useCallback(async () => {
    if (!svg) return;
    const exportSession = exportSessionRef.current;
    setBusy(true);
    setError(null);
    try {
      const png = await svgToPngBlob(svg, settings.pngScale);
      if (!openRef.current || exportSessionRef.current !== exportSession) {
        return;
      }
      const filename = `${slugify(packet.name)}-diagram-${settings.pngScale}x.png`;
      downloadBlobFile(filename, png);
      onClose();
    } catch (caught) {
      if (!openRef.current || exportSessionRef.current !== exportSession) {
        return;
      }
      console.error("Failed to export diagram as PNG.", caught);
      setError("PNG export failed. Please try SVG or another browser.");
    } finally {
      if (openRef.current && exportSessionRef.current === exportSession) {
        setBusy(false);
      }
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={(e) => {
        if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
          onClose();
        }
      }}
    >
      <div
        ref={cardRef}
        className="w-full max-w-xl rounded-xl border p-4"
        style={{
          background: "var(--bg-elevated)",
          borderColor: "var(--border)",
          boxShadow: "0 10px 25px rgba(0,0,0,0.12)",
        }}
      >
        <h3 id={titleId} className="m-0 mb-3 text-sm font-semibold">
          Save image
        </h3>
        <div
          className="diagram-export-preview mb-3 overflow-hidden rounded-lg border p-2"
          style={{
            background: "var(--bg)",
            borderColor: "var(--border)",
          }}
          aria-label="Diagram preview"
          dangerouslySetInnerHTML={{ __html: svg ?? "" }}
        />
        <div className="grid gap-2">
          <label className="text-xs">
            Format
            <select
              ref={firstControlRef}
              value={settings.format}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  format: event.target.value as SaveFormat,
                }))
              }
              className="mt-1 h-9 w-full rounded-md border px-2 text-xs"
              style={{
                background: "var(--bg-elevated)",
                borderColor: "var(--border)",
                color: "var(--fg)",
              }}
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
              className="mt-1 h-9 w-full rounded-md border px-2 text-xs"
              style={{
                background: "var(--bg-elevated)",
                borderColor: "var(--border)",
                color: "var(--fg)",
              }}
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
          <div
            className="mt-3 rounded-lg border p-3"
            style={{ borderColor: "var(--border)" }}
          >
            <label className="text-xs">
              PNG resolution
              <div className="mt-1 flex items-center gap-3">
                <div className="pv-slider-wrap flex-1">
                  <input
                    type="range"
                    min={PNG_SCALE_MIN}
                    max={PNG_SCALE_MAX}
                    step={PNG_SCALE_STEP}
                    value={settings.pngScale}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        pngScale: Number(event.target.value),
                      }))
                    }
                    className="pv-slider"
                  />
                </div>
                <output className="min-w-10 text-right">
                  {settings.pngScale}x
                </output>
              </div>
            </label>
          </div>
        ) : null}
        {error ? (
          <p
            className="mb-0 mt-3 text-xs"
            role="alert"
            style={{ color: "#b42318" }}
          >
            {error}
          </p>
        ) : null}
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
            onClick={handleSave}
            disabled={settings.format === "png" && busy}
            className="h-9 rounded-md border px-3 text-xs disabled:opacity-60"
            style={{ borderColor: "var(--border)" }}
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
