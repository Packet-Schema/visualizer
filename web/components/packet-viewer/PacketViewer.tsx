"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import copy from "copy-to-clipboard";
import stableStringify from "safe-stable-stringify";

import { PRESETS } from "@/lib/psml/presets";
import { resolveLayout } from "@/lib/psml/layout";
import { initialEnv } from "@/lib/psml/normalize";
import {
  initialState,
  packetCategories,
  syncChainControllers,
  syncTlvControllers,
} from "@/lib/psml/renderer-helpers";
import { psmlToRenderer, rendererToPsml } from "@/lib/psml/psml-to-renderer";
import { DEFAULT_BYTE_ORDER } from "@/lib/constants";
import { editReducer, makeInitialState } from "@/lib/psml/edit-reducer";
import {
  loadCustomPresets,
  saveCustomPreset,
  deleteCustomPreset,
} from "@/lib/psml/custom-presets";
import {
  buildMyPresetsBundle,
  downloadBlob,
  isMyPresetsBundle,
  readFileAsText,
  uniqueKey,
} from "@/lib/preset-file-io";
import {
  buildShareUrl,
  parseShareParams,
  shareUrlByteLength,
  SHARE_URL_WARN_BYTES,
} from "@/lib/share-url";
import type {
  ChainInstance,
  ControllerState,
  Field,
  Packet,
  PacketRegistry,
  TlvInstance,
} from "@/lib/psml/renderer";
import type { Expr, PsmlPacket, ViewMode } from "@/lib/psml/types";
import ControlsPanel from "@/components/controls/ControlsPanel";
import DependencyOverlay from "@/components/diagram/DependencyOverlay";
import DetailPanel from "@/components/field-details/DetailPanel";
import DiagramRuler from "@/components/diagram/DiagramRuler";
import FieldPopover from "@/components/diagram/FieldPopover";
import HexStrip from "@/components/diagram/HexStrip";
import HybridDiagram from "@/components/diagram/HybridDiagram";
import ImportExportDrawer, {
  type DrawerMode,
} from "@/components/import-export/ImportExportDrawer";
import Legend from "@/components/diagram/Legend";
import OnboardingTour, {
  hasSeenTour,
  type TourStep,
} from "@/components/onboarding/OnboardingTour";
import PacketToolbar from "./PacketToolbar";
import SavePresetDialog from "./SavePresetDialog";
import StudioPanel from "./StudioPanel";
import { cssEscape, findRowNeighbor } from "./navigation";

const DEFAULT_PACKET_KEY = "ipv4";
const BUILT_IN_PRESET_KEYS = Object.keys(PRESETS);
const CUSTOM_PRESET_NAME_MAX = 80;
const SHARED_CUSTOM_PRESET_FALLBACK_NAME = "Shared packet";

// Width threshold at which the floating field popover is enabled. Below this
// we rely on the inline DetailPanel only.
const POPOVER_MIN_WIDTH = 900;

// PSML packet 内で参照されている ref フィールド名を全て集める。
// PacketViewer の env 構築で controllers に無い ref を 0 で fallback seed
// するために使う。 PSML 0.4 の全 Container kind (group / switch / repeat /
// encrypted / optional) を再帰的に walk する。
//
// 動機: 既存設計では preset ごとに PacketViewer.tsx の `if (packetKey ===
// "ipv4")` のような手動 seed を必要としていた (ipv4OptionsCount /
// tcpOptionsCount 等)。 issue #91 で 8 個の preset を追加した時にこの
// wiring を全部 PacketViewer に書くと脆くなるので、 packet 側の式を walk
// して env を自動で補う形に汎化する。
function collectPsmlRefs(packet: PsmlPacket): Set<string> {
  const out = new Set<string>();
  const visit = (e: Expr): void => {
    switch (e.kind) {
      case "lit":
        return;
      case "ref":
        out.add(e.field);
        return;
      case "op":
        visit(e.a);
        visit(e.b);
        return;
      case "cond":
        visit(e.test);
        visit(e.t);
        visit(e.f);
        return;
      case "peek":
        // peek.bits は定数 (number) で ref を含まない一方、
        // peek.offset は Expr なので ref を含み得る (例: offset を
        // 同 packet の長さ field で動かす lookahead パターン)。
        // ここを walk しないと該当パケットが MissingRefError で落ちる
        // (Codex P2 指摘)。
        if (e.offset) visit(e.offset);
        return;
    }
  };
  type AnyNode = {
    kind?: string;
    type?: { kind: string; n?: Expr };
    children?: AnyNode[];
    element?: { fields: AnyNode[] };
    cases?: Record<string, { fields: AnyNode[] }>;
    default?: { fields: AnyNode[] };
    on?: Expr;
    count?: Expr | string | { until: Expr };
    plaintext?: { fields: AnyNode[] };
    wireBits?: Expr;
    when?: Expr;
    field?: AnyNode;
  };
  const walk = (containers: AnyNode[]): void => {
    for (const c of containers) {
      if (!c.kind || c.kind === "field") {
        if (c.type?.kind === "bytes" && c.type.n) visit(c.type.n);
        continue;
      }
      if (c.kind === "group" && c.children) walk(c.children);
      if (c.kind === "switch") {
        if (c.on) visit(c.on);
        for (const v of Object.values(c.cases ?? {})) walk(v.fields);
        if (c.default) walk(c.default.fields);
      }
      if (c.kind === "repeat") {
        if (c.count && typeof c.count === "object" && "kind" in c.count) {
          visit(c.count as Expr);
        } else if (
          c.count &&
          typeof c.count === "object" &&
          "until" in c.count
        ) {
          visit(c.count.until);
        }
        if (c.element) walk(c.element.fields);
      }
      if (c.kind === "encrypted") {
        if (c.wireBits) visit(c.wireBits);
        if (c.plaintext) walk(c.plaintext.fields);
      }
      if (c.kind === "optional") {
        if (c.when) visit(c.when);
        if (c.field) walk([c.field]);
      }
    }
  };
  walk(packet.body as AnyNode[]);
  return out;
}

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

  // Custom Packet Studio — user-saved presets pulled out of localStorage.
  // Keyed `custom:<name>`; PresetPicker renders these under a 'My presets'
  // optgroup.
  const [customPresets, setCustomPresets] = useState<
    Record<string, PsmlPacket>
  >({});
  // Lowered renderer mirror of the active custom preset, if any.
  const customRenderer: Packet | null = useMemo(() => {
    const cp = customPresets[packetKey];
    return cp ? psmlToRenderer(cp) : null;
  }, [customPresets, packetKey]);

  // Renderer mirror — the shape the UI editors / detail panels consume.
  const packet: Packet =
    renderedPresets[packetKey] ??
    importedPackets[packetKey] ??
    customRenderer ??
    renderedPresets[DEFAULT_PACKET_KEY];

  const [controllers, setControllers] = useState<ControllerState>(() =>
    initialState(psmlToRenderer(PRESETS[DEFAULT_PACKET_KEY])),
  );

  // Custom Packet Studio reducer. Seeded from the default preset; we
  // reseed via 'replace-packet' on preset switch so history doesn't span
  // unrelated packets.
  const [studioState, dispatch] = useReducer(
    editReducer,
    PRESETS[DEFAULT_PACKET_KEY],
    makeInitialState,
  );
  const [editMode, setEditMode] = useState(false);
  const [showJsonPane, setShowJsonPane] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
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
  const [urlHydrated, setUrlHydrated] = useState(false);
  const [shareStatus, setShareStatus] = useState<{
    msg: string;
    kind: "ok" | "error";
  } | null>(null);

  const diagramRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<HTMLElement | null>(null);

  // Pull user-saved presets from localStorage, then apply shared URL state.
  // URL hydration is one-shot; later state changes update the address bar.
  useEffect(() => {
    const stored = loadCustomPresets();
    if (typeof window === "undefined") {
      setCustomPresets(stored);
      setUrlHydrated(true);
      return;
    }

    const parsed = parseShareParams(
      window.location.search,
      BUILT_IN_PRESET_KEYS,
    );
    if (parsed.kind === "psml") {
      const { key, presets } = persistSharedCustomPreset(parsed.packet, stored);
      setCustomPresets(presets);
      setPacketKey(key);
      setControllers({
        ...initialState(psmlToRenderer(parsed.packet)),
        ...parsed.controllers,
      });
    } else if (parsed.kind === "preset") {
      setCustomPresets(stored);
      setPacketKey(parsed.presetKey);
      setControllers({
        ...initialState(renderedPresets[parsed.presetKey]),
        ...parsed.controllers,
      });
    } else {
      setCustomPresets(stored);
      if (Object.keys(parsed.controllers).length > 0) {
        setControllers({
          ...initialState(renderedPresets[DEFAULT_PACKET_KEY]),
          ...parsed.controllers,
        });
      }
      if (parsed.error) {
        console.warn(`Packet View ignored share URL: ${parsed.error}`);
      }
    }
    setUrlHydrated(true);
  }, [renderedPresets]);

  // The active PSML packet for the studio reducer. Prefers built-in PSML,
  // then a custom preset, then a lifted version of the imported renderer
  // packet (lossy but acceptable as a starting point for editing).
  const activePsmlPacket: PsmlPacket = useMemo(() => {
    return (
      PRESETS[packetKey] ??
      customPresets[packetKey] ??
      (importedPackets[packetKey]
        ? rendererToPsml(importedPackets[packetKey])
        : PRESETS[DEFAULT_PACKET_KEY])
    );
  }, [packetKey, customPresets, importedPackets]);

  // When the user changes preset, reseed the reducer so undo doesn't span
  // unrelated packets.
  useEffect(() => {
    dispatch({ type: "replace-packet", packet: activePsmlPacket });
  }, [activePsmlPacket]);

  // Keyboard shortcuts while editing. Skip when focus is on an input/textarea
  // so the browser's native text-undo still works inside FieldRow inputs.
  useEffect(() => {
    if (!editMode) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) {
          return;
        }
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "undo" });
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        dispatch({ type: "redo" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editMode]);

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
      const customPreset = customPresets[nextKey];
      const next =
        renderedPresets[nextKey] ??
        importedPackets[nextKey] ??
        (customPreset ? psmlToRenderer(customPreset) : null);
      if (next) setControllers(initialState(next));
      setSelectedFieldId(null);
      setPopoverAnchor(null);
    },
    [customPresets, importedPackets, renderedPresets],
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
      setControllers((prev) => syncChainControllers(packet, { ...prev }));
    },
    [packet],
  );

  // Save the in-progress edit as a user-owned preset. The `custom:<name>`
  // key namespace keeps user-saved presets separate from built-ins and
  // imports so the picker can group them cleanly.
  const handleSaveAsPreset = useCallback(
    (name: string) => {
      if (!name.trim()) return;
      const normalizedName = normalizeCustomPresetName(name);
      const key = `custom:${normalizedName}`;
      const packetToSave: PsmlPacket = {
        ...studioState.packet,
        name: normalizedName,
      };
      saveCustomPreset(key, packetToSave);
      setCustomPresets(loadCustomPresets());
      setPacketKey(key);
      setControllers(initialState(psmlToRenderer(packetToSave)));
      setSelectedFieldId(null);
      setShowSaveDialog(false);
      setEditMode(false);
    },
    [studioState.packet],
  );

  // Drop in-progress edits and revert the reducer to the active preset.
  const handleDiscardEdits = useCallback(() => {
    dispatch({ type: "replace-packet", packet: activePsmlPacket });
    setEditMode(false);
    setShowJsonPane(false);
  }, [activePsmlPacket]);

  // Bulk export every `custom:<name>` preset into a single JSON envelope so
  // users can move their library between browsers / devices.
  const handleExportCustomPresets = useCallback(() => {
    const bundle = buildMyPresetsBundle(customPresets);
    downloadBlob(
      "my-presets.json",
      "application/json",
      JSON.stringify(bundle, null, 2),
    );
  }, [customPresets]);

  // Hidden input used by the bulk-import flow. The PresetPicker icon button
  // delegates to a click on this element so the file picker stays a single
  // OS-native dialog without dragging in another modal.
  const bulkImportInputRef = useRef<HTMLInputElement | null>(null);
  const handleImportCustomPresetsClick = useCallback(() => {
    bulkImportInputRef.current?.click();
  }, []);
  const handleImportCustomPresetsFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      try {
        const text = await readFileAsText(file);
        const parsed = JSON.parse(text);
        if (!isMyPresetsBundle(parsed)) {
          if (typeof window !== "undefined") {
            window.alert(
              "That file doesn't look like a my-presets bundle (missing 'presets' map).",
            );
          }
          return;
        }
        const existing = new Set(Object.keys(loadCustomPresets()));
        let imported = 0;
        for (const [rawKey, pkt] of Object.entries(parsed.presets)) {
          if (!pkt || typeof pkt !== "object") continue;
          const key = uniqueKey(rawKey, existing);
          existing.add(key);
          saveCustomPreset(key, pkt as PsmlPacket);
          imported++;
        }
        setCustomPresets(loadCustomPresets());
        if (typeof window !== "undefined") {
          window.alert(
            `Imported ${imported} preset${imported === 1 ? "" : "s"}.`,
          );
        }
      } catch (err) {
        if (typeof window !== "undefined") {
          window.alert(`Bulk import failed: ${(err as Error).message}`);
        }
      }
    },
    [],
  );

  // Delete the currently selected custom preset (toolbar shortcut). Wrapped
  // in a confirm dialog because there's no undo for this in localStorage.
  const handleDeleteCustomPreset = useCallback(() => {
    if (!packetKey.startsWith("custom:")) return;
    if (typeof window !== "undefined") {
      const label = customPresets[packetKey]?.name ?? packetKey;
      const ok = window.confirm(`Delete custom preset “${label}”?`);
      if (!ok) return;
    }
    deleteCustomPreset(packetKey);
    setCustomPresets(loadCustomPresets());
    setPacketKey(DEFAULT_PACKET_KEY);
    setEditMode(false);
  }, [packetKey, customPresets]);

  const buildCurrentShareUrl = useCallback(() => {
    if (typeof window === "undefined") return "";
    const builtInPsml = PRESETS[packetKey];
    const sharePacket = editMode
      ? studioState.packet
      : (builtInPsml ?? customPresets[packetKey] ?? rendererToPsml(packet));
    const defaultControllers = builtInPsml
      ? initialState(psmlToRenderer(builtInPsml))
      : undefined;

    return buildShareUrl({
      baseUrl: window.location.href,
      packetKey,
      packet: sharePacket,
      controllers,
      builtInKeys: BUILT_IN_PRESET_KEYS,
      defaultPacketKey: DEFAULT_PACKET_KEY,
      defaultControllers,
      forcePsml: editMode || !builtInPsml,
    });
  }, [
    controllers,
    customPresets,
    editMode,
    packet,
    packetKey,
    studioState.packet,
  ]);

  useEffect(() => {
    if (!urlHydrated || typeof window === "undefined") return;
    try {
      const nextUrl = buildCurrentShareUrl();
      if (nextUrl && nextUrl !== window.location.href) {
        window.history.replaceState(null, "", nextUrl);
      }
    } catch (err) {
      console.warn(
        `Packet View could not update the share URL: ${(err as Error).message}`,
      );
    }
  }, [buildCurrentShareUrl, urlHydrated]);

  useEffect(() => {
    if (!shareStatus) return;
    const id = window.setTimeout(() => setShareStatus(null), 2400);
    return () => window.clearTimeout(id);
  }, [shareStatus]);

  const handleShare = useCallback(() => {
    try {
      const url = buildCurrentShareUrl();
      const bytes = shareUrlByteLength(url);
      if (bytes > SHARE_URL_WARN_BYTES) {
        console.warn(
          `Packet View share URL is ${bytes} bytes, exceeding ${SHARE_URL_WARN_BYTES}; copied anyway.`,
        );
      }
      const ok = copy(url);
      if (!ok) throw new Error("Clipboard copy was not available.");
      if (typeof window !== "undefined" && window.location.href !== url) {
        window.history.replaceState(null, "", url);
      }
      setShareStatus({ msg: "Share URL copied.", kind: "ok" });
    } catch (err) {
      setShareStatus({
        msg: `Share failed: ${(err as Error).message}`,
        kind: "error",
      });
    }
  }, [buildCurrentShareUrl]);

  const tourSteps: TourStep[] = useMemo(
    () => [
      {
        title: "Welcome to Packet View",
        body: "Packet View teaches network protocols visually. Pick a packet, click any field, and tweak sliders to see how the bytes line up.",
      },
      {
        title: "The bit ruler",
        body: "Each row is 32 bits wide. The numbers across the top mark bit positions — useful for matching up with RFC diagrams.",
        target: () =>
          diagramRef.current?.querySelector(".diagram-ruler") ?? null,
        placement: "bottom",
      },
      {
        title: "Click any field",
        body: "Cells are interactive. Click one to see its size, category, and full description in the field detail panel.",
        target: () => diagramRef.current?.querySelector(".field-cell") ?? null,
        placement: "bottom",
      },
      {
        title: "Drag to grow",
        body: "Variable-length fields like IPv4 Options have a slider. Drag it to see the Options grow and the header reflow.",
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
    // We compute these generically based on the environment so that custom
    // presets (with different packetKeys) can still resolve their layout refs.
    const ihl = env.get("ihl") ?? 5;
    env.set("ipv4OptionsCount", Math.max(0, ihl - 5));
    const off = env.get("dataOffset") ?? 5;
    env.set("tcpOptionsCount", Math.max(0, off - 5));
    // 描画対象の PSML packet を一旦変数で持つ — editMode / built-in /
    // custom / imported のいずれも resolveLayout には PsmlPacket を渡す
    // ので、 ref fallback seed を一箇所に集約できる。
    const targetPsml: PsmlPacket = editMode
      ? studioState.packet
      : (PRESETS[packetKey] ??
        customPresets[packetKey] ??
        rendererToPsml(packet));
    // Default value seed: packet が宣言する Field.defaultValue を env に
    // 入れる (controllers が既に値を持っていれば優先 — UI スライダーの
    // 入力を上書きしない)。 これを fallback seed より先にやらないと、
    // 後段の `if (!env.has(r)) env.set(r, 0)` が defaultValue を 0 で
    // 潰してしまい (例: quicLong の dcidLength / scidLength = 8 → 0)、
    // 既存 preset の variable-length field が zero-length に描かれる
    // regression を起こす (Codex P1 指摘)。
    const packetDefaults = initialEnv(targetPsml);
    for (const [k, v] of packetDefaults) {
      if (!env.has(k)) env.set(k, v);
    }
    // Fallback seed: packet が使う ref のうち env に未登録のものは 0 で
    // 埋める。 これがないと、 preset 切り替え時に packet が要求する ref を
    // PacketViewer 側が手動で seed しない限り `resolveLayout` が
    // MissingRefError で throw → React render が落ちて "Application error"
    // 画面になる。 issue #91 で追加した 8 個の preset を含め、 controllers
    // と命名が一致しない ref をまとめて吸収する。
    for (const r of collectPsmlRefs(targetPsml)) {
      if (!env.has(r)) env.set(r, 0);
    }
    return resolveLayout(targetPsml, { env, viewMode });
  }, [
    packet,
    packetKey,
    controllers,
    viewMode,
    editMode,
    studioState.packet,
    customPresets,
  ]);

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
    <>
      <main className="max-w-[1200px] mx-auto px-6 py-3 pb-10 w-full flex-1">
        <PacketToolbar
          packetKey={packetKey}
          importedPackets={importedPackets}
          customPresets={customPresets}
          hexStripVisible={hexStripVisible}
          dependenciesVisible={dependenciesVisible}
          editMode={editMode}
          viewMode={viewMode}
          headerSizeLabel={`${layout.totalBits} bits (${byteStr})`}
          shareStatus={shareStatus}
          onPacketChange={handlePacketChange}
          onExportCustomPresets={handleExportCustomPresets}
          onImportCustomPresets={handleImportCustomPresetsClick}
          onOpenImport={() => setDrawerMode("import")}
          onOpenExport={() => setDrawerMode("export")}
          onShare={handleShare}
          onToggleHexStrip={() => {
            hexStripUserSetRef.current = true;
            setHexStripVisible((v) => !v);
          }}
          onToggleDependencies={() => setDependenciesVisible((v) => !v)}
          onToggleViewMode={() =>
            setViewMode((v) => (v === "semantic" ? "wire" : "semantic"))
          }
          onToggleEditMode={() => setEditMode((v) => !v)}
          onDeleteCustomPreset={handleDeleteCustomPreset}
        />
        <input
          ref={bulkImportInputRef}
          type="file"
          accept=".json,application/json"
          onChange={handleImportCustomPresetsFile}
          style={{ display: "none" }}
          aria-hidden="true"
          tabIndex={-1}
        />

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
              onFieldClick={handleFieldClick}
              onSubfieldClick={(parentField, subfield, elem) =>
                handleFieldClick(`${parentField.id}:${subfield.id}`, elem)
              }
              onFieldHover={hexStripVisible ? handleFieldHover : undefined}
            />
            {hexStripVisible ? (
              <HexStrip
                packet={packet}
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

        {editMode ? (
          <StudioPanel
            state={studioState}
            dispatch={dispatch}
            showJsonPane={showJsonPane}
            onToggleJsonPane={() => setShowJsonPane((v) => !v)}
            onSaveAs={() => setShowSaveDialog(true)}
            onDiscard={handleDiscardEdits}
          />
        ) : null}

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
            <div
              ref={controlsRef as unknown as React.RefObject<HTMLDivElement>}
            >
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
        <OnboardingTour steps={tourSteps} onClose={() => setTourOpen(false)} />
      ) : null}

      {showSaveDialog ? (
        <SavePresetDialog
          defaultName={studioState.packet.name}
          onCancel={() => setShowSaveDialog(false)}
          onSubmit={handleSaveAsPreset}
        />
      ) : null}
    </>
  );
}

function persistSharedCustomPreset(
  packet: PsmlPacket,
  stored: Record<string, PsmlPacket>,
): { key: string; presets: Record<string, PsmlPacket> } {
  const normalizedPacket: PsmlPacket = {
    ...packet,
    name: normalizeCustomPresetName(packet.name),
  };
  const desired = `custom:${normalizedPacket.name}`;

  for (const [key, candidate] of Object.entries(stored)) {
    const normalizedStoredPacket: PsmlPacket = {
      ...candidate,
      name: normalizeCustomPresetName(candidate.name),
    };
    if (samePsmlPacket(normalizedStoredPacket, normalizedPacket)) {
      if (!samePsmlPacket(candidate, normalizedStoredPacket)) {
        saveCustomPreset(key, normalizedStoredPacket);
        const presets = loadCustomPresets();
        return {
          key,
          presets: presets[key]
            ? presets
            : { ...stored, [key]: normalizedStoredPacket },
        };
      }
      return { key, presets: stored };
    }
  }

  const existing = new Set(Object.keys(stored));
  const key = stored[desired] ? uniqueKey(desired, existing) : desired;
  saveCustomPreset(key, normalizedPacket);
  const presets = loadCustomPresets();
  return {
    key,
    presets: presets[key] ? presets : { ...stored, [key]: normalizedPacket },
  };
}

function normalizeCustomPresetName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return SHARED_CUSTOM_PRESET_FALLBACK_NAME;
  return normalized.slice(0, CUSTOM_PRESET_NAME_MAX).trimEnd();
}

function samePsmlPacket(a: PsmlPacket, b: PsmlPacket): boolean {
  return stableStringify(a) === stableStringify(b);
}
