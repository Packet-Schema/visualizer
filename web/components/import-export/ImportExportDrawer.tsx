import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  EXPORTABLE_FORMATS,
  FORMATS,
  IMPORTABLE_FORMATS,
  getFormat,
  type FormatKey,
} from "@/lib/formats/registry";
import {
  downloadBlob,
  extensionToFormat,
  readFileAsText,
  slugify,
} from "@/lib/preset-file-io";
import { psmlToRenderer, rendererToPsml } from "@/lib/psml/psml-to-renderer";
import type { ControllerState, Packet } from "@/lib/psml/renderer";

export type DrawerMode = "import" | "export";
export type { FormatKey } from "@/lib/formats/registry";

type Props = {
  open: boolean;
  mode: DrawerMode;
  /** Current packet (used to seed Export). */
  packet: Packet;
  /** Current controller state (used to seed Export). */
  controllers: ControllerState;
  onClose: () => void;
  onImport: (packet: Packet, controllers: ControllerState) => void;
};

type StatusKind = "ok" | "warn" | "error";
type Status = { msg: string; kind: StatusKind } | null;

const FORMAT_LABELS: Record<FormatKey, string> = Object.fromEntries(
  FORMATS.map((f) => [f.id, f.label]),
) as Record<FormatKey, string>;

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export default function ImportExportDrawer({
  open,
  mode,
  packet,
  controllers,
  onClose,
  onImport,
}: Props) {
  const [format, setFormat] = useState<FormatKey>("json");
  const [text, setText] = useState<string>("");
  const [status, setStatus] = useState<Status>(null);
  const [currentMode, setCurrentMode] = useState<DrawerMode>(mode);

  const drawerRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Format availability per mode — derived from each adapter's parse/render
  // presence so a new entry in `FORMATS` shows up automatically.
  const availableFormats: FormatKey[] = useMemo(
    () => (currentMode === "import" ? IMPORTABLE_FORMATS : EXPORTABLE_FORMATS),
    [currentMode],
  );

  // Sync mode when parent re-opens with a different mode.
  useEffect(() => {
    if (open) {
      setCurrentMode(mode);
      // Default sensible format per mode.
      setFormat(mode === "import" ? "json" : "json");
      setText("");
      setStatus(null);
    }
  }, [open, mode]);

  // Snap to a valid format when mode changes.
  useEffect(() => {
    if (!availableFormats.includes(format)) {
      setFormat(availableFormats[0]);
    }
  }, [availableFormats, format]);

  // Auto-fill on Export when format / packet / controllers change.
  useEffect(() => {
    if (!open) return;
    if (currentMode !== "export") return;
    try {
      // Lower the runtime packet to PSML for the format hub. controllers is a
      // plain object keyed by controller id; PSML's PacketEnv is a Map.
      const psml = rendererToPsml(packet);
      const env = new Map<string, number>(Object.entries(controllers));
      const adapter = getFormat(format);
      if (!adapter.render) {
        throw new Error(`Format "${format}" has no exporter.`);
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

  // Capture / restore focus + Esc + focus trap.
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    // Move focus into the drawer.
    const focusables = getFocusables(drawerRef.current);
    if (focusables.length > 0) focusables[0].focus();

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab" && drawerRef.current) {
        const list = getFocusables(drawerRef.current);
        if (list.length === 0) {
          e.preventDefault();
          return;
        }
        const first = list[0];
        const last = list[list.length - 1];
        const active = document.activeElement;
        if (e.shiftKey) {
          if (active === first || !drawerRef.current.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last || !drawerRef.current.contains(active)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, onClose]);

  // Restore focus on close.
  useEffect(() => {
    if (open) return;
    const el = returnFocusRef.current;
    if (el && document.contains(el)) {
      try {
        el.focus();
      } catch {
        /* ignore */
      }
    }
    returnFocusRef.current = null;
  }, [open]);

  const handleModeChange = useCallback((next: DrawerMode) => {
    setCurrentMode(next);
    setText("");
    setStatus(null);
  }, []);

  const handleApply = useCallback(() => {
    try {
      const adapter = getFormat(format);
      if (!adapter.parse) {
        throw new Error(`Format "${format}" cannot be imported.`);
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

  // Shared file ingestion used by both the file picker and DnD. Reads the
  // file as text, drops it into the textarea, and snaps the format selector
  // to whatever the extension implies.
  const handleFileSelected = useCallback(
    async (file: File) => {
      try {
        const content = await readFileAsText(file);
        setText(content);
        const detected = extensionToFormat(file.name);
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
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API is not available in this browser.");
      }
      await navigator.clipboard.writeText(text);
      setStatus({ msg: "Copied to clipboard.", kind: "ok" });
    } catch (e) {
      setStatus({ msg: `Copy failed: ${(e as Error).message}`, kind: "error" });
    }
  }, [text]);

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
        }
      `}</style>
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pv-import-export-title"
        className="pv-drawer h-full max-w-full flex flex-col shadow-2xl"
        style={{
          background: "var(--bg-elevated)",
          color: "var(--fg)",
          borderLeft: "1px solid var(--border)",
        }}
      >
        <DrawerInner
          currentMode={currentMode}
          format={format}
          text={text}
          status={status}
          availableFormats={availableFormats}
          textareaRef={textareaRef}
          fileInputRef={fileInputRef}
          onModeChange={handleModeChange}
          onFormatChange={setFormat}
          onTextChange={setText}
          onApply={handleApply}
          onCopy={handleCopy}
          onDownload={handleDownload}
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
  text: string;
  status: Status;
  availableFormats: FormatKey[];
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onModeChange: (mode: DrawerMode) => void;
  onFormatChange: (fmt: FormatKey) => void;
  onTextChange: (txt: string) => void;
  onApply: () => void;
  onCopy: () => void;
  onDownload: () => void;
  onUploadClick: () => void;
  onFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onFileDropped: (file: File) => void;
  onClose: () => void;
};

function DrawerInner({
  currentMode,
  format,
  text,
  status,
  availableFormats,
  textareaRef,
  fileInputRef,
  onModeChange,
  onFormatChange,
  onTextChange,
  onApply,
  onCopy,
  onDownload,
  onUploadClick,
  onFileInputChange,
  onFileDropped,
  onClose,
}: InnerProps) {
  const [dragActive, setDragActive] = useState(false);
  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  }, []);
  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) onFileDropped(file);
    },
    [onFileDropped],
  );
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
        <div
          className={`flex-1 min-h-[200px] flex rounded-md ${dragActive ? "drawer-drop-active" : ""}`}
          onDragOver={currentMode === "import" ? handleDragOver : undefined}
          onDragLeave={currentMode === "import" ? handleDragLeave : undefined}
          onDrop={currentMode === "import" ? handleDrop : undefined}
          style={{
            outline: dragActive ? "2px dashed var(--accent)" : "none",
            outlineOffset: "-2px",
          }}
        >
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

function getFocusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((el) => {
    if (el.hidden) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return true;
  });
}
