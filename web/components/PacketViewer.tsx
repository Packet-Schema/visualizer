"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { PRESETS } from "@/lib/psml/presets";
import { resolveLayout } from "@/lib/psml/layout";
import {
  initialState,
  packetCategories,
  syncTlvControllers,
} from "@/lib/psml/renderer-helpers";
import { psmlToRenderer, rendererToPsml } from "@/lib/psml/psml-to-renderer";
import { DEFAULT_BYTE_ORDER } from "@/lib/constants";
import type {
  ChainInstance,
  ControllerState,
  Field,
  Packet,
  PacketRegistry,
  TlvInstance,
} from "@/lib/psml/renderer";
import type { ViewMode } from "@/lib/psml/types";
import ControlsPanel from "./ControlsPanel";
import DependencyOverlay from "./DependencyOverlay";
import DetailPanel from "./DetailPanel";
import DiagramRuler from "./DiagramRuler";
import FieldPopover from "./FieldPopover";
import HexStrip from "./HexStrip";
import HybridDiagram from "./HybridDiagram";
import ImportExportDrawer, {
  type DrawerMode,
} from "./ImportExportDrawer";
import Legend from "./Legend";
import OnboardingTour, { hasSeenTour, type TourStep } from "./OnboardingTour";
import PresetPicker from "./PresetPicker";
import ThemeToggle from "./ThemeToggle";
import WorksheetButton from "./WorksheetButton";

const DEFAULT_PACKET_KEY = "ipv4";

// Width threshold at which the floating field popover is enabled. Below this
// we rely on the inline DetailPanel only.
const POPOVER_MIN_WIDTH = 900;

export default function PacketViewer() {
  const [packetKey, setPacketKey] = useState<string>(DEFAULT_PACKET_KEY);
  // Imported packets are kept in the renderer shape so the editors can mutate
  // their TLV/Chain/subfield state directly. Built-in presets live in PSML
  // and are lowered to the renderer shape on demand.
  const [importedPackets, setImportedPackets] = useState<PacketRegistry>({});
  // The renderer-shape mirror of every built-in PSML preset. Lowered once on
  // mount; TLV/Chain mutations mutate the field object identity in-place so
  // the mirror is stable across re-renders (the format hub re-lifts back to
  // PSML at export time).
  const [renderedPresets] = useState<PacketRegistry>(() => {
    const out: PacketRegistry = {};
    for (const [k, v] of Object.entries(PRESETS)) {
      out[k] = psmlToRenderer(v);
    }
    return out;
  });

  // Renderer mirror — the shape the UI editors / detail panels consume.
  const packet: Packet =
    renderedPresets[packetKey] ??
    importedPackets[packetKey] ??
    renderedPresets[DEFAULT_PACKET_KEY];

  const [controllers, setControllers] = useState<ControllerState>(() =>
    initialState(psmlToRenderer(PRESETS[DEFAULT_PACKET_KEY])),
  );
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [popoverAnchor, setPopoverAnchor] = useState<DOMRect | null>(null);
  const [isWideViewport, setIsWideViewport] = useState(false);
  const [drawerMode, setDrawerMode] = useState<DrawerMode | null>(null);
  const [tourOpen, setTourOpen] = useState(false);
  // Hex strip is hidden by default on narrow viewports so phones aren't
  // overwhelmed; users can flip it on via the toolbar regardless.
  const [hexStripVisible, setHexStripVisible] = useState(false);
  // Tracks whether the user has explicitly toggled hex visibility. Without
  // this flag, the wide-viewport effect would keep clobbering their choice.
  const hexStripUserSetRef = useRef(false);
  const [dependenciesVisible, setDependenciesVisible] = useState(false);
  // Wire vs. semantic ('Decrypted') view. Phase 2C will populate the runtime
  // resolver with encrypted blocks; for now the toggle threads state through
  // and HybridDiagram decorates any cell that already carries the flags.
  const [viewMode, setViewMode] = useState<ViewMode>("wire");

  const diagramRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<HTMLElement | null>(null);

  // Auto-launch the tour on first visit. Delay slightly so the diagram is
  // mounted and target elements are visible.
  useEffect(() => {
    if (hasSeenTour()) return;
    const id = window.setTimeout(() => setTourOpen(true), 350);
    return () => window.clearTimeout(id);
  }, []);

  // Track viewport width to gate the popover affordance. Read on mount and on
  // resize; SSR sees `false` so the markup matches the initial client render.
  useEffect(() => {
    if (typeof window === "undefined") return;
    function update() {
      setIsWideViewport(window.innerWidth >= POPOVER_MIN_WIDTH);
    }
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // Default the hex strip on for wide viewports the first time we know the
  // viewport size. Once the user toggles, leave their preference alone.
  useEffect(() => {
    if (hexStripUserSetRef.current) return;
    setHexStripVisible(isWideViewport);
  }, [isWideViewport]);

  // Bidirectional highlight wiring. Both the diagram cells and the hex strip
  // call this; we mirror the active fieldId to the diagram root and tag any
  // matching elements with `.hex-match`. CSS can't compare two attribute
  // values, so we apply the class imperatively — zero re-render churn during
  // hover and the styling rules stay declarative in globals.css.
  const handleFieldHover = useCallback((fieldId: string | null) => {
    const root = diagramRef.current;
    if (!root) return;
    // Always clear the previous highlight first so rapid hover transitions
    // don't leave stale classes behind.
    for (const el of root.querySelectorAll<HTMLElement>(".hex-match")) {
      el.classList.remove("hex-match");
    }
    if (!fieldId) {
      root.removeAttribute("data-highlighted-field");
      return;
    }
    root.setAttribute("data-highlighted-field", fieldId);
    // Subfield ids look like "parent:sub". Highlight both the subfield itself
    // and the parent field cell so the relationship is unambiguous.
    const parentId = fieldId.includes(":") ? fieldId.split(":")[0] : null;
    const matches = root.querySelectorAll<HTMLElement>(
      parentId
        ? `[data-field-id="${cssEscape(fieldId)}"], .field-cell[data-field-id="${cssEscape(parentId)}"]`
        : `[data-field-id="${cssEscape(fieldId)}"]`,
    );
    for (const el of matches) el.classList.add("hex-match");
  }, []);

  const handlePacketChange = useCallback(
    (nextKey: string) => {
      setPacketKey(nextKey);
      const next = renderedPresets[nextKey] ?? importedPackets[nextKey];
      if (next) setControllers(initialState(next));
      setSelectedFieldId(null);
      setPopoverAnchor(null);
    },
    [renderedPresets, importedPackets],
  );

  const handleControllerChange = useCallback((key: string, value: number) => {
    setControllers((prev) => ({ ...prev, [key]: value }));
  }, []);

  // Everything in the hybrid renderer is an HTMLElement, so anchorRect is a
  // straight getBoundingClientRect() — no SVG branching required.
  const handleFieldClick = useCallback(
    (fieldId: string, elem: HTMLElement | null) => {
      setSelectedFieldId(fieldId);
      if (isWideViewport && elem) {
        setPopoverAnchor(elem.getBoundingClientRect());
      } else {
        setPopoverAnchor(null);
      }
    },
    [isWideViewport],
  );

  const handleImport = useCallback(
    (imported: Packet, importedControllers: ControllerState) => {
      const key = `imported:${imported.name}`;
      setImportedPackets((prev) => ({ ...prev, [key]: imported }));
      setPacketKey(key);
      setControllers({ ...initialState(imported), ...importedControllers });
      setSelectedFieldId(null);
      setDrawerMode(null);
    },
    [],
  );

  // TLV edits mutate the field's `tlv.instances` array (matching legacy
  // behaviour where the catalog data is shared with the resolver). We
  // re-sync TLV-driven controllers afterwards.
  const handleTlvChange = useCallback(
    (field: Field, next: TlvInstance[]) => {
      if (!field.tlv) return;
      field.tlv.instances = next;
      setControllers((prev) => syncTlvControllers(packet, prev));
    },
    [packet],
  );

  const handleChainChange = useCallback(
    (
      field: Field,
      next: { instances: ChainInstance[]; finalProto?: number },
    ) => {
      field.chainInstances = next.instances;
      if (typeof next.finalProto === "number") {
        field.chainFinalProto = next.finalProto;
      }
      // Force a re-render even though we mutated the field directly.
      setControllers((prev) => ({ ...prev }));
    },
    [],
  );

  const tourSteps: TourStep[] = useMemo(
    () => [
      {
        title: "Welcome to Packet View",
        body:
          "Packet View teaches network protocols visually. Pick a packet, click any field, and tweak sliders to see how the bytes line up.",
      },
      {
        title: "The bit ruler",
        body:
          "Each row is 32 bits wide. The numbers across the top mark bit positions — useful for matching up with RFC diagrams.",
        target: () => diagramRef.current?.querySelector(".diagram-ruler") ?? null,
        placement: "bottom",
      },
      {
        title: "Click any field",
        body:
          "Cells are interactive. Click one to see its size, category, and full description in the field detail panel.",
        target: () => diagramRef.current?.querySelector(".field-cell") ?? null,
        placement: "bottom",
      },
      {
        title: "Drag to grow",
        body:
          "Variable-length fields like IPv4 Options have a slider. Drag it to see the Options grow and the header reflow.",
        target: () =>
          controlsRef.current?.querySelector('input[type="range"]') ?? null,
        placement: "top",
      },
    ],
    [],
  );

  const layout = useMemo(() => {
    // Every preset is PSML now — route the diagram through resolveLayout so
    // Encrypted-container decoration and viewMode toggling are uniform.
    // For imported packets the renderer mirror is the source of truth and we
    // lift it back to PSML on demand (lossy for variable-length payloads
    // without TLV metadata, which is acceptable for layout purposes).
    const env = new Map(
      Object.entries(controllers).map(([k, v]) => [k, Number(v)] as const),
    );
    // Derive secondary repeat-count keys for presets whose UI slider drives a
    // bytes-counter rather than the PSML count ref. Each TLV editor sets
    // {opts}_count directly via syncTlvControllers; this fallback covers the
    // IHL / Data Offset slider path where the user grows the header without
    // touching the TLV editor.
    if (packetKey === "ipv4") {
      const ihl = env.get("ihl") ?? 5;
      env.set("ipv4OptionsCount", Math.max(0, ihl - 5));
    }
    if (packetKey === "tcp") {
      const off = env.get("dataOffset") ?? 5;
      env.set("tcpOptionsCount", Math.max(0, off - 5));
    }
    const psml = PRESETS[packetKey] ?? null;
    if (psml) {
      return resolveLayout(psml, { env, viewMode });
    }
    // Imported packet — lift renderer → PSML, then resolve.
    const lifted = rendererToPsml(packet);
    return resolveLayout(lifted, { env, viewMode });
  }, [packet, packetKey, controllers, viewMode]);

  const categories = useMemo(() => packetCategories(packet), [packet]);

  const bytes = layout.totalBits / 8;
  const byteStr = Number.isInteger(bytes)
    ? `${bytes} bytes`
    : `${layout.totalBits} bits`;

  // Roving tabindex keyboard navigation on the diagram. We treat field cells
  // (and subfield cells) as a flat list keyed by document order, but Up/Down
  // routes through `data-row` + `data-start-bit` for spatial behaviour.
  const handleDiagramKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const root = diagramRef.current;
      if (!root) return;
      const target = e.target as Element | null;
      if (!target) return;

      const isFieldCell = target.classList.contains("field-cell");
      const isSubfieldCell = target.classList.contains("subfield-cell");
      if (!isFieldCell && !isSubfieldCell) return;

      // All cells are HTMLElements in the hybrid renderer.
      const cells = Array.from(
        root.querySelectorAll<HTMLElement>(
          isSubfieldCell ? ".subfield-cell" : ".field-cell",
        ),
      );
      // Subfields navigate within their parent only.
      const group = isSubfieldCell
        ? cells.filter(
            (c) =>
              c.dataset.parentFieldId ===
              (target as HTMLElement).dataset.parentFieldId,
          )
        : cells;

      const idx = group.indexOf(target as HTMLElement);
      if (idx === -1) return;

      let next: HTMLElement | null = null;
      switch (e.key) {
        case "ArrowRight":
          next = group[Math.min(group.length - 1, idx + 1)] ?? null;
          break;
        case "ArrowLeft":
          next = group[Math.max(0, idx - 1)] ?? null;
          break;
        case "ArrowDown":
          next = isSubfieldCell
            ? null
            : findRowNeighbor(group, target as HTMLElement, +1);
          break;
        case "ArrowUp":
          next = isSubfieldCell
            ? null
            : findRowNeighbor(group, target as HTMLElement, -1);
          break;
        case "Home":
          next = group[0] ?? null;
          break;
        case "End":
          next = group[group.length - 1] ?? null;
          break;
        default:
          return;
      }

      if (next && next !== target) {
        e.preventDefault();
        // Move the single tabindex=0 to the focused element.
        for (const c of group) {
          c.setAttribute("tabindex", c === next ? "0" : "-1");
        }
        next.focus();
      }
    },
    [],
  );

  return (
    <div className="min-h-screen flex flex-col">
      <header
        className="sticky top-0 z-50 shadow-md"
        style={{
          background: "var(--bg-header)",
          color: "var(--header-fg)",
        }}
      >
        <div className="max-w-[1200px] mx-auto px-6 py-2 flex items-center justify-between gap-4">
          <div className="flex flex-wrap items-baseline gap-2.5 min-w-0">
            <h1 className="m-0 text-[18px] font-semibold tracking-wide whitespace-nowrap">
              Packet View
            </h1>
            <p
              className="m-0 text-xs truncate min-w-0"
              style={{ color: "var(--header-fg-muted)" }}
            >
              Visual viewer for common network packet headers.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <WorksheetButton packet={packet} controllers={controllers} />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="max-w-[1200px] mx-auto px-6 py-3 pb-10 w-full flex-1">
        <div
          className="flex flex-wrap items-center gap-3 mb-2 rounded-[10px] border px-3.5 py-2.5"
          style={{
            background: "var(--bg-elevated)",
            borderColor: "var(--border)",
            boxShadow: "0 1px 2px rgba(15,22,50,0.05)",
          }}
        >
          <PresetPicker
            value={packetKey}
            onChange={handlePacketChange}
            imported={importedPackets}
          />
          <div className="flex items-center gap-1.5 ml-2">
            <ToolbarButton onClick={() => setDrawerMode("import")}>
              Import
            </ToolbarButton>
            <ToolbarButton onClick={() => setDrawerMode("export")}>
              Export
            </ToolbarButton>
            <ToolbarButton
              onClick={() => {
                hexStripUserSetRef.current = true;
                setHexStripVisible((v) => !v);
              }}
              pressed={hexStripVisible}
              ariaLabel={`${hexStripVisible ? "Hide" : "Show"} hex byte strip`}
            >
              Hex view
            </ToolbarButton>
            <ToolbarButton
              onClick={() => setDependenciesVisible((v) => !v)}
              pressed={dependenciesVisible}
              ariaLabel={
                dependenciesVisible
                  ? "Hide dependency arrows"
                  : "Show dependency arrows"
              }
            >
              Dependencies
            </ToolbarButton>
            <ToolbarButton
              onClick={() =>
                setViewMode((v) => (v === "semantic" ? "wire" : "semantic"))
              }
              pressed={viewMode === "semantic"}
              ariaLabel={
                viewMode === "semantic"
                  ? "Switch to wire view (collapse encrypted payloads)"
                  : "Switch to decrypted view (expand encrypted payloads)"
              }
            >
              Decrypted view
            </ToolbarButton>
          </div>
          <div
            className="ml-auto text-[13px] font-mono tabular-nums"
            style={{ color: "var(--fg-muted)" }}
          >
            Header size: {layout.totalBits} bits ({byteStr})
          </div>
        </div>

        {packet.description ? (
          <p
            className="text-[13px] mx-0.5 mt-2 mb-1"
            style={{ color: "var(--fg-muted)" }}
          >
            {packet.description}
          </p>
        ) : null}
        <p
          className="text-xs mx-0.5 mb-3 italic flex items-center gap-1.5"
          style={{ color: "var(--fg-faint)" }}
        >
          <span
            className="not-italic font-bold"
            style={{ color: "var(--accent)" }}
            aria-hidden="true"
          >
            ↦
          </span>
          {packet.byteOrder || DEFAULT_BYTE_ORDER}
        </p>

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_max-content] gap-3 items-start">
          <div
            id="diagram"
            ref={diagramRef}
            className="diagram-shell rounded-[10px] border p-3.5 overflow-x-auto"
            style={{
              background: "var(--bg-elevated)",
              borderColor: "var(--border)",
              boxShadow: "0 1px 2px rgba(15,22,50,0.05)",
            }}
            onKeyDown={handleDiagramKeyDown}
          >
            <DiagramRuler rowBits={packet.rowBits} />
            <HybridDiagram
              packet={packet}
              layout={layout}
              selectedFieldId={selectedFieldId}
              onFieldClick={(field, elem) => handleFieldClick(field.id, elem)}
              onSubfieldClick={(parentField, subfield, elem) =>
                handleFieldClick(`${parentField.id}:${subfield.id}`, elem)
              }
              onFieldHover={hexStripVisible ? handleFieldHover : undefined}
            />
            {hexStripVisible ? (
              <HexStrip
                layout={layout}
                rowBits={packet.rowBits}
                selectedFieldId={selectedFieldId}
                onByteHover={handleFieldHover}
              />
            ) : null}
            <DependencyOverlay
              packet={packet}
              containerRef={diagramRef}
              visible={dependenciesVisible}
            />
          </div>
          <Legend categories={categories} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
          <section
            className="rounded-[10px] border px-4 py-3.5"
            style={{
              background: "var(--bg-elevated)",
              borderColor: "var(--border)",
              boxShadow: "0 1px 2px rgba(15,22,50,0.05)",
            }}
          >
            <h2
              className="text-xs m-0 mb-3 uppercase tracking-wider font-bold"
              style={{ color: "var(--fg-muted)" }}
            >
              Controls
            </h2>
            <div ref={controlsRef as unknown as React.RefObject<HTMLDivElement>}>
              <ControlsPanel
                packet={packet}
                controllers={controllers}
                onChange={handleControllerChange}
              />
            </div>
          </section>

          <section
            className="rounded-[10px] border px-4 py-3.5"
            style={{
              background: "var(--bg-elevated)",
              borderColor: "var(--border)",
              boxShadow: "0 1px 2px rgba(15,22,50,0.05)",
            }}
          >
            <h2
              className="text-xs m-0 mb-3 uppercase tracking-wider font-bold"
              style={{ color: "var(--fg-muted)" }}
            >
              Field detail
            </h2>
            <DetailPanel
              packet={packet}
              selectedFieldId={selectedFieldId}
              controllers={controllers}
              onTlvChange={handleTlvChange}
              onChainChange={handleChainChange}
            />
          </section>
        </div>
      </main>

      {isWideViewport && selectedFieldId && popoverAnchor ? (
        <FieldPopover
          packet={packet}
          controllers={controllers}
          selectedFieldId={selectedFieldId}
          anchorRect={popoverAnchor}
          onDismiss={() => setPopoverAnchor(null)}
        />
      ) : null}

      <ImportExportDrawer
        open={drawerMode !== null}
        mode={drawerMode ?? "export"}
        packet={packet}
        controllers={controllers}
        onClose={() => setDrawerMode(null)}
        onImport={handleImport}
      />

      {tourOpen ? (
        <OnboardingTour
          steps={tourSteps}
          onClose={() => setTourOpen(false)}
        />
      ) : null}
    </div>
  );
}

// cssEscape: tolerant wrapper around CSS.escape for environments where the
// global is missing (older test runners, edge SSR shims). Field ids contain
// `:` and `#` (TLV-expanded virtual fields), both of which need escaping
// before dropping into a querySelector.
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

// findRowNeighbor: prefer a cell on the adjacent row whose bit range overlaps
// the currently focused cell, falling back to direct list neighbors.
function findRowNeighbor(
  cells: HTMLElement[],
  current: HTMLElement,
  direction: number,
): HTMLElement | null {
  const curRow = Number(current.dataset.row);
  if (Number.isNaN(curRow)) {
    const idx = cells.indexOf(current);
    return cells[Math.max(0, Math.min(cells.length - 1, idx + direction))] ?? null;
  }
  const curStart = Number(current.dataset.startBit);
  const curEnd = Number(current.dataset.endBit);
  const targetRow = curRow + direction;
  const sameRow = cells.filter((c) => Number(c.dataset.row) === targetRow);
  if (sameRow.length === 0) return null;
  const overlap = sameRow.find((c) => {
    const s = Number(c.dataset.startBit);
    const en = Number(c.dataset.endBit);
    return !(en < curStart || s > curEnd);
  });
  return overlap ?? sameRow[0] ?? null;
}

function ToolbarButton({
  onClick,
  children,
  pressed,
  ariaLabel,
  ...rest
}: {
  onClick: () => void;
  children: React.ReactNode;
  pressed?: boolean;
  ariaLabel?: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children" | "aria-label">) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      aria-label={ariaLabel}
      className="tb-btn text-sm font-medium px-2.5 py-1.5 rounded-md border"
      style={{
        background: pressed ? "var(--accent)" : "var(--bg-elevated)",
        color: pressed ? "var(--accent-fg)" : "var(--fg)",
        borderColor: pressed ? "var(--accent)" : "var(--border-strong)",
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
