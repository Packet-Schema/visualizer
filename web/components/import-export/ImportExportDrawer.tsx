import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  downloadBlobFile,
  downloadTextFile,
  readDiagramTheme,
  svgToPngBlob,
  type DiagramThemeMode,
} from "@/lib/diagram-export";
import { renderToSvgString } from "@/lib/diagram-satori";
import { StaticDiagram } from "@/components/diagram/StaticDiagram";
import {
  EXPORTABLE_FORMATS,
  FORMATS,
  IMPORTABLE_FORMATS,
  getFormat,
  type FormatKey,
} from "@/lib/formats/registry";
import {
  downloadBlob,
  extToFormat,
  readFileAsText,
  slugify,
} from "@/lib/preset-file-io";
import { psmlToRenderer, rendererToPsml } from "@/lib/psml/psml-to-renderer";
import type {
  ControllerState,
  Packet,
  ResolvedLayout,
} from "@/lib/psml/renderer";

import { useFocusTrap } from "@/components/common/hooks/useFocusTrap";
import { useDropzone } from "./hooks/useDropzone";

export type DrawerMode = "import" | "export";
export type { FormatKey } from "@/lib/formats/registry";

type Props = {
  open: boolean;
  mode: DrawerMode;
  /** Current packet (used to seed Export). */
  packet: Packet;
  /** Current controller state (used to seed Export). */
  controllers: ControllerState;
  /** Current resolved layout (used to export the live diagram). */
  layout: ResolvedLayout;
  onClose: () => void;
  onImport: (packet: Packet, controllers: ControllerState) => void;
};

type StatusKind = "ok" | "warn" | "error";
type Status = { msg: string; kind: StatusKind } | null;

const FORMAT_LABELS: Record<FormatKey, string> = Object.fromEntries(
  FORMATS.map((f) => [f.id, f.label]),
) as Record<FormatKey, string>;

function copyTextFallback(text: string): void {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const ok = document.execCommand("copy");
  textarea.remove();
  if (!ok) {
    throw new Error("Copy command was rejected by the browser.");
  }
}

export default function ImportExportDrawer({
  open,
  mode,
  packet,
  controllers,
  layout,
  onClose,
  onImport,
}: Props) {
  const [format, setFormat] = useState<FormatKey>("json");
  const [text, setText] = useState<string>("");
  const [status, setStatus] = useState<Status>(null);
  const [currentMode, setCurrentMode] = useState<DrawerMode>(mode);
  const [exportThemeMode, setExportThemeMode] =
    useState<DiagramThemeMode>("follow-ui");
  const [diagramWidth, setDiagramWidth] = useState<24 | 32 | 40>(32);
  const [transparentBackground, setTransparentBackground] = useState(false);
  const [pngScale, setPngScale] = useState(2);
  const [imageBusy, setImageBusy] = useState(false);
  const [previewSvg, setPreviewSvg] = useState<string | null>(null);

  const drawerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const openRef = useRef(open);
  const exportSessionRef = useRef(0);
  useFocusTrap({ open, containerRef: drawerRef, onClose });

  // Format availability per mode — derived from each adapter's parse/render
  // presence so a new entry in `FORMATS` shows up automatically.
  const availableFormats: FormatKey[] = useMemo(
    () => (currentMode === "import" ? IMPORTABLE_FORMATS : EXPORTABLE_FORMATS),
    [currentMode],
  );

  // Snap `format` into the allowed list for the new mode, preserving the
  // user's pick when it's still legal. Called from both the parent-driven
  // re-open effect and the user-driven mode toggle so the two paths can't
  // drift in what counts as a valid format for a given pane.
  const snapFormatForMode = useCallback((next: DrawerMode) => {
    const allowed = next === "import" ? IMPORTABLE_FORMATS : EXPORTABLE_FORMATS;
    setFormat((prev) => (allowed.includes(prev) ? prev : allowed[0]));
  }, []);

  // Sync mode when the parent re-opens the drawer. Transient state
  // (`text`, `status`) is reset *only* when the requested mode differs
  // from the one we currently show — otherwise a quick detour through
  // another modal and back would wipe
  // text the user had typed or pasted.
  useEffect(() => {
    openRef.current = open;
    exportSessionRef.current += 1;
    if (!open) {
      setImageBusy(false);
      return;
    }
    setCurrentMode((prev) => {
      if (prev !== mode) {
        snapFormatForMode(mode);
        setText("");
        setStatus(null);
      }
      return mode;
    });
  }, [open, mode, snapFormatForMode]);

  // Auto-fill on Export when format / packet / controllers change.
  useEffect(() => {
    if (!open) return;
    if (currentMode !== "export") return;
    if (format === "svg" || format === "png") {
      setText("");
      setStatus(null);
      return;
    }
    try {
      // Lower the runtime packet to PSML for the format hub. controllers is a
      // plain object keyed by controller id; PSML's PacketEnv is a Map.
      const psml = rendererToPsml(packet);
      const env = new Map<string, number>(Object.entries(controllers));
      const adapter = getFormat(format);
      if (!adapter.render) {
        throw new Error(
          `Export to "${adapter.label}" is not supported. Try another format.`,
        );
      }
      setText(adapter.render(psml, env));
      setStatus(null);
    } catch (e) {
      setStatus({
        msg: `Export failed: ${(e as Error).message}`,
        kind: "error",
      });
    }
  }, [open, currentMode, format, packet, controllers]);

  const handleModeChange = useCallback(
    (next: DrawerMode) => {
      setCurrentMode(next);
      snapFormatForMode(next);
      setText("");
      setStatus(null);
    },
    [snapFormatForMode],
  );

  const handleApply = useCallback(() => {
    try {
      const adapter = getFormat(format);
      if (!adapter.parse) {
        throw new Error(
          `Import from "${adapter.label}" is not supported. Try another format.`,
        );
      }
      const { packet: psml, env, warnings } = adapter.parse(text);
      const runtime = psmlToRenderer(psml);
      const controllers: ControllerState = {};
      if (env) for (const [k, v] of env) controllers[k] = v;
      onImport(runtime, controllers);
      if (warnings && warnings.length) {
        const prefix =
          format === "ksy"
            ? `Imported "${psml.name}" with ${warnings.length} warning(s)`
            : "Imported with warnings";
        setStatus({
          msg: `${prefix}: ${warnings.join("; ")}`,
          kind: "warn",
        });
      } else {
        setStatus({ msg: `Imported "${psml.name}".`, kind: "ok" });
      }
    } catch (e) {
      setStatus({
        msg: `Import failed: ${(e as Error).message}`,
        kind: "error",
      });
    }
  }, [format, text, onImport]);

  const handleDownload = useCallback(() => {
    try {
      const adapter = getFormat(format);
      const filename = `${slugify(packet.name)}.${adapter.extension}`;
      downloadBlob(filename, adapter.mime, text);
      setStatus({ msg: `Downloaded ${filename}.`, kind: "ok" });
    } catch (e) {
      setStatus({
        msg: `Download failed: ${(e as Error).message}`,
        kind: "error",
      });
    }
  }, [format, packet.name, text]);

  const isImageExportMode =
    currentMode === "export" && (format === "svg" || format === "png");

  // Generate preview SVG asynchronously using browser-side Satori
  useEffect(() => {
    const renderPreview = async () => {
      if (!isImageExportMode) {
        setPreviewSvg(null);
        return;
      }

      try {
        const theme = readDiagramTheme(exportThemeMode);

        // Calculate preview dimensions based on bitWidth
        const width = packet.rowBits * diagramWidth;
        const height = 300;

        const diagramComponent = (
          <div
            style={{
              width: "100%",
              height: "100%",
              background: transparentBackground
                ? "transparent"
                : theme.background,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <StaticDiagram
              packet={packet}
              layout={layout}
              theme={theme}
              targetHeight={height}
              transparentBackground={transparentBackground}
            />
          </div>
        );

        const svg = await renderToSvgString(diagramComponent, width, height);
        if (isImageExportMode) {
          setPreviewSvg(svg);
        }
      } catch (e) {
        console.error("Failed to render preview SVG:", e);
        setPreviewSvg(null);
      }
    };

    void renderPreview();
  }, [
    diagramWidth,
    exportThemeMode,
    isImageExportMode,
    layout,
    packet,
    transparentBackground,
  ]);

  const handleImageDownload = useCallback(async () => {
    const exportSession = exportSessionRef.current;
    try {
      setImageBusy(true);

      const theme = readDiagramTheme(exportThemeMode);
      const diagramComponent = (
        <div
          style={{
            width: "100%",
            height: "100%",
            background: transparentBackground
              ? "transparent"
              : theme.background,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <StaticDiagram
            packet={packet}
            layout={layout}
            theme={theme}
            targetHeight={transparentBackground ? 400 : 300}
            transparentBackground={transparentBackground}
          />
        </div>
      );

      // Calculate dimensions for full-size export (not preview)
      const width = packet.rowBits * diagramWidth;
      const height = 400;

      const svg = await renderToSvgString(diagramComponent, width, height);

      if (!openRef.current || exportSessionRef.current !== exportSession) {
        return;
      }
      if (format === "svg") {
        const filename = `${slugify(packet.name)}-diagram.svg`;
        downloadTextFile(filename, "image/svg+xml", svg);
        setStatus({ msg: `Downloaded ${filename}.`, kind: "ok" });
        return;
      }
      if (format !== "png") {
        throw new Error(`Format "${format}" is not an image export format.`);
      }
      const blob = await svgToPngBlob(svg, pngScale);
      if (!openRef.current || exportSessionRef.current !== exportSession) {
        return;
      }
      const filename = `${slugify(packet.name)}-diagram-${pngScale}x.png`;
      downloadBlobFile(filename, blob);
      setStatus({ msg: `Downloaded ${filename}.`, kind: "ok" });
    } catch (e) {
      if (!openRef.current || exportSessionRef.current !== exportSession) {
        return;
      }
      setStatus({
        msg: `Image export failed: ${(e as Error).message}`,
        kind: "error",
      });
    } finally {
      if (openRef.current && exportSessionRef.current === exportSession) {
        setImageBusy(false);
      }
    }
  }, [
    diagramWidth,
    exportThemeMode,
    format,
    layout,
    packet,
    pngScale,
    transparentBackground,
  ]);

  // Shared file ingestion used by both the file picker and DnD. Reads the
  // file as text, drops it into the textarea, and snaps the format selector
  // to whatever the extension implies.
  const handleFileSelected = useCallback(
    async (file: File) => {
      try {
        const content = await readFileAsText(file);
        setText(content);
        const detected = extToFormat(file.name);
        if (detected && availableFormats.includes(detected)) {
          setFormat(detected);
        }
        setStatus({ msg: `Loaded ${file.name}.`, kind: "ok" });
      } catch (e) {
        setStatus({
          msg: `Upload failed: ${(e as Error).message}`,
          kind: "error",
        });
      }
    },
    [availableFormats],
  );

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);
  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void handleFileSelected(file);
      // Reset so picking the same file twice still fires onChange.
      e.target.value = "";
    },
    [handleFileSelected],
  );

  const handleCopy = useCallback(async () => {
    try {
      if (isImageExportMode) {
        if (!previewSvg) {
          throw new Error("Image preview is not available.");
        }
        if (format === "svg") {
          let copied = false;
          if (navigator.clipboard?.writeText) {
            try {
              await navigator.clipboard.writeText(previewSvg);
              copied = true;
            } catch {
              // fall through to textarea fallback below
            }
          }
          if (!copied) {
            copyTextFallback(previewSvg);
          }
        } else {
          if (!navigator.clipboard?.write) {
            throw new Error("Clipboard image write was not available.");
          }
          const png = await svgToPngBlob(previewSvg, pngScale);
          await navigator.clipboard.write([
            new ClipboardItem({ "image/png": png }),
          ]);
        }
        setStatus({ msg: "Copied to clipboard.", kind: "ok" });
        return;
      }
      // Try the async Clipboard API first, then fall through to the
      // legacy execCommand path if the API is missing *or* rejected
      // (Permissions-Policy / NotAllowedError / non-secure context).
      let copied = false;
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          copied = true;
        } catch {
          // Swallow the reject and let the fallback below try.
        }
      }
      if (!copied) {
        // The export textarea is already in the DOM with the same content,
        // so selecting it and using legacy `execCommand("copy")` works
        // without requiring a hidden helper element.
        const ta = textareaRef.current;
        if (!ta) {
          throw new Error("Export textarea is not available.");
        }
        const prev = { start: ta.selectionStart, end: ta.selectionEnd };
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        ta.setSelectionRange(prev.start, prev.end);
        if (!ok) {
          throw new Error("Copy command was rejected by the browser.");
        }
      }
      setStatus({ msg: "Copied to clipboard.", kind: "ok" });
    } catch (e) {
      setStatus({ msg: `Copy failed: ${(e as Error).message}`, kind: "error" });
    }
  }, [format, isImageExportMode, pngScale, previewSvg, text]);

  // Slide-and-fade entry is handled by CSS (`@starting-style` on the
  // `.pv-drawer-backdrop` / `.pv-drawer` classes in styles/drawer.css).
  // `prefers-reduced-motion` is honoured by the global override in
  // app/globals.css.
  const backdropRef = useRef<HTMLDivElement | null>(null);

  if (!open) return null;

  return (
    <div
      ref={backdropRef}
      role="presentation"
      className="pv-drawer-backdrop fixed inset-0 z-[100] flex"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex-1" aria-hidden="true" />
      {/* Width: full-width below 900px, 40% at >= 900px (per spec). */}
      <style>{`
        .pv-drawer { width: 100%; }
        @media (min-width: 900px) {
          .pv-drawer { width: 40%; min-width: 480px; }
          .pv-drawer-image { width: 56%; min-width: 640px; }
        }
      `}</style>
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pv-import-export-title"
        className={`pv-drawer h-full max-w-full flex flex-col shadow-2xl ${isImageExportMode ? "pv-drawer-image" : ""}`}
        style={{
          background: "var(--bg-elevated)",
          color: "var(--fg)",
          borderLeft: "1px solid var(--border)",
        }}
      >
        <DrawerInner
          currentMode={currentMode}
          format={format}
          exportThemeMode={exportThemeMode}
          diagramWidth={diagramWidth}
          transparentBackground={transparentBackground}
          pngScale={pngScale}
          imageBusy={imageBusy}
          previewSvg={previewSvg}
          isImageExportMode={isImageExportMode}
          text={text}
          status={status}
          availableFormats={availableFormats}
          textareaRef={textareaRef}
          fileInputRef={fileInputRef}
          onModeChange={handleModeChange}
          onFormatChange={setFormat}
          onExportThemeModeChange={setExportThemeMode}
          onDiagramWidthChange={setDiagramWidth}
          onTransparentBackgroundChange={setTransparentBackground}
          onPngScaleChange={setPngScale}
          onTextChange={setText}
          onApply={handleApply}
          onCopy={handleCopy}
          onDownload={handleDownload}
          onImageDownload={handleImageDownload}
          onUploadClick={handleUploadClick}
          onFileInputChange={handleFileInputChange}
          onFileDropped={handleFileSelected}
          onClose={onClose}
        />
      </aside>
    </div>
  );
}

type InnerProps = {
  currentMode: DrawerMode;
  format: FormatKey;
  exportThemeMode: DiagramThemeMode;
  diagramWidth: 24 | 32 | 40;
  transparentBackground: boolean;
  pngScale: number;
  imageBusy: boolean;
  previewSvg: string | null;
  isImageExportMode: boolean;
  text: string;
  status: Status;
  availableFormats: FormatKey[];
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onModeChange: (mode: DrawerMode) => void;
  onFormatChange: (fmt: FormatKey) => void;
  onExportThemeModeChange: (mode: DiagramThemeMode) => void;
  onDiagramWidthChange: (width: 24 | 32 | 40) => void;
  onTransparentBackgroundChange: (value: boolean) => void;
  onPngScaleChange: (value: number) => void;
  onTextChange: (txt: string) => void;
  onApply: () => void;
  onCopy: () => void;
  onDownload: () => void;
  onImageDownload: () => Promise<void>;
  onUploadClick: () => void;
  onFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onFileDropped: (file: File) => void;
  onClose: () => void;
};

function DrawerInner({
  currentMode,
  format,
  exportThemeMode,
  diagramWidth,
  transparentBackground,
  pngScale,
  imageBusy,
  previewSvg,
  isImageExportMode,
  text,
  status,
  availableFormats,
  textareaRef,
  fileInputRef,
  onModeChange,
  onFormatChange,
  onExportThemeModeChange,
  onDiagramWidthChange,
  onTransparentBackgroundChange,
  onPngScaleChange,
  onTextChange,
  onApply,
  onCopy,
  onDownload,
  onImageDownload,
  onUploadClick,
  onFileInputChange,
  onFileDropped,
  onClose,
}: InnerProps) {
  const { dragActive, handlers: dropHandlers } = useDropzone({
    enabled: currentMode === "import",
    onFile: onFileDropped,
  });
  const previewSize = useMemo(() => {
    if (!previewSvg) return null;
    const svg = new DOMParser().parseFromString(
      previewSvg,
      "image/svg+xml",
    ).documentElement;
    const width = Number(svg.getAttribute("width"));
    const height = Number(svg.getAttribute("height"));
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    return { width, height };
  }, [previewSvg]);
  const pngWidthOptions = useMemo(() => {
    if (!previewSize) return [];
    return [1, 2, 3, 4, 5, 6, 7, 8].map((scale) => ({
      scale,
      label: `${previewSize.width * scale}px x ${previewSize.height * scale}px`,
    }));
  }, [previewSize]);
  return (
    <>
      <header className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h2 id="pv-import-export-title" className="text-base font-semibold m-0">
          {currentMode === "import" ? "Import packet" : "Export packet"}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-md w-8 h-8 flex items-center justify-center text-lg leading-none border"
          style={{
            background: "transparent",
            color: "var(--fg)",
            borderColor: "var(--border)",
          }}
        >
          x
        </button>
      </header>

      <div className="px-4 py-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          <span className="text-fg-muted">Mode:</span>
          <select
            value={currentMode}
            onChange={(e) => onModeChange(e.target.value as DrawerMode)}
            className="text-sm px-2 py-1 rounded-md border"
            style={{
              borderColor: "var(--border-strong)",
              background: "var(--bg-elevated)",
              color: "var(--fg)",
            }}
          >
            <option value="import">Import</option>
            <option value="export">Export</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm font-medium">
          <span className="text-fg-muted">Format:</span>
          <select
            value={format}
            onChange={(e) => onFormatChange(e.target.value as FormatKey)}
            className="text-sm px-2 py-1 rounded-md border"
            style={{
              borderColor: "var(--border-strong)",
              background: "var(--bg-elevated)",
              color: "var(--fg)",
            }}
          >
            {availableFormats.map((f) => (
              <option key={f} value={f}>
                {FORMAT_LABELS[f]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex-1 min-h-0 px-4 pb-2 flex flex-col gap-2">
        {currentMode === "import" ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onUploadClick}
              className="text-xs px-2 py-1 rounded-md border"
              style={{
                background: "transparent",
                color: "var(--fg)",
                borderColor: "var(--border-strong)",
              }}
            >
              Upload file
            </button>
            <span className="text-xs text-fg-muted">
              or drop a file on the textarea
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.psml.json,.txt,.ksy,.aad"
              onChange={onFileInputChange}
              className="hidden"
              aria-hidden="true"
              tabIndex={-1}
            />
          </div>
        ) : null}
        {isImageExportMode ? (
          <div
            className="rounded-md border p-3 text-sm grid gap-2"
            style={{ borderColor: "var(--border)" }}
          >
            <label className="flex items-center justify-between gap-3">
              <span>Theme</span>
              <select
                value={exportThemeMode}
                onChange={(e) =>
                  onExportThemeModeChange(e.target.value as DiagramThemeMode)
                }
                className="w-28 text-sm px-2 py-1 rounded-md border"
                style={{
                  borderColor: "var(--border-strong)",
                  background: "var(--bg-elevated)",
                  color: "var(--fg)",
                }}
              >
                <option value="follow-ui">Follow UI</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <label className="flex items-center justify-between gap-3">
              <span>Bit width</span>
              <select
                value={String(diagramWidth)}
                onChange={(e) =>
                  onDiagramWidthChange(Number(e.target.value) as 24 | 32 | 40)
                }
                className="text-sm px-2 py-1 rounded-md border"
                style={{
                  borderColor: "var(--border-strong)",
                  background: "var(--bg-elevated)",
                  color: "var(--fg)",
                }}
              >
                <option value="24">24 px</option>
                <option value="32">32 px</option>
                <option value="40">40 px</option>
              </select>
            </label>
            <div className="flex items-center justify-between gap-3">
              <span>Transparent background</span>
              <button
                type="button"
                role="switch"
                aria-checked={transparentBackground}
                onClick={() =>
                  onTransparentBackgroundChange(!transparentBackground)
                }
                className="relative h-6 w-11 rounded-full border transition-colors"
                style={{
                  background: transparentBackground
                    ? "var(--accent)"
                    : "var(--bg-subtle)",
                  borderColor: transparentBackground
                    ? "var(--accent)"
                    : "var(--border-strong)",
                }}
              >
                <span
                  className="absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white transition-transform"
                  style={{ left: transparentBackground ? "22px" : "2px" }}
                />
              </button>
            </div>
            {format === "png" ? (
              <label className="flex items-center justify-between gap-3">
                <span>PNG size</span>
                <select
                  value={pngScale}
                  onChange={(e) => onPngScaleChange(Number(e.target.value))}
                  className="w-44 text-sm px-2 py-1 rounded-md border"
                  style={{
                    borderColor: "var(--border-strong)",
                    background: "var(--bg-elevated)",
                    color: "var(--fg)",
                  }}
                >
                  {pngWidthOptions.map((option) => (
                    <option key={option.scale} value={option.scale}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        ) : null}
        <div
          className={`flex-1 min-h-[200px] flex rounded-md ${dragActive ? "drawer-drop-active" : ""}`}
          onDragOver={dropHandlers?.onDragOver}
          onDragLeave={dropHandlers?.onDragLeave}
          onDrop={dropHandlers?.onDrop}
          style={{
            outline: dragActive ? "2px dashed var(--accent)" : "none",
            outlineOffset: "-2px",
          }}
        >
          {isImageExportMode ? (
            <div
              className="diagram-export-preview w-full min-h-[200px] rounded-md border p-2 overflow-auto"
              style={{
                borderColor: "var(--border)",
                background: "var(--bg-subtle)",
              }}
              dangerouslySetInnerHTML={{ __html: previewSvg ?? "" }}
            />
          ) : (
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => onTextChange(e.target.value)}
              spellCheck={false}
              placeholder={
                currentMode === "import"
                  ? "Paste packet definition here, then click Apply."
                  : ""
              }
              className="flex-1 min-h-[200px] resize-none text-xs font-mono rounded-md border p-2"
              style={{
                background: "var(--bg-subtle)",
                color: "var(--fg)",
                borderColor: "var(--border)",
              }}
            />
          )}
        </div>
        <div
          className={`text-xs min-h-[1.25rem] ${
            status?.kind === "error"
              ? "text-field-rose"
              : status?.kind === "warn"
                ? "text-field-amber"
                : status?.kind === "ok"
                  ? "text-field-green"
                  : "text-fg-muted"
          }`}
          role="status"
          aria-live="polite"
        >
          {status?.msg ?? ""}
        </div>
      </div>

      <footer className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
        <button
          type="button"
          onClick={onClose}
          className="text-sm px-3 py-1.5 rounded-md border"
          style={{
            background: "transparent",
            color: "var(--fg)",
            borderColor: "var(--border-strong)",
          }}
        >
          Close
        </button>
        {currentMode === "import" ? (
          <button
            type="button"
            onClick={onApply}
            className="text-sm px-3 py-1.5 rounded-md border font-semibold bg-accent text-accent-fg border-accent"
          >
            Apply
          </button>
        ) : isImageExportMode ? (
          <>
            <button
              type="button"
              onClick={onCopy}
              className="text-sm px-3 py-1.5 rounded-md border font-semibold"
              style={{
                background: "transparent",
                color: "var(--fg)",
                borderColor: "var(--border-strong)",
              }}
            >
              Copy
            </button>
            <button
              type="button"
              onClick={() => void onImageDownload()}
              disabled={imageBusy}
              className="text-sm px-3 py-1.5 rounded-md border font-semibold bg-accent text-accent-fg border-accent"
              style={{ opacity: imageBusy ? 0.7 : 1 }}
            >
              {imageBusy ? "Exporting..." : "Download"}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onCopy}
              className="text-sm px-3 py-1.5 rounded-md border font-semibold"
              style={{
                background: "transparent",
                color: "var(--fg)",
                borderColor: "var(--border-strong)",
              }}
            >
              Copy
            </button>
            <button
              type="button"
              onClick={onDownload}
              className="text-sm px-3 py-1.5 rounded-md border font-semibold bg-accent text-accent-fg border-accent"
            >
              Download
            </button>
          </>
        )}
      </footer>
    </>
  );
}
