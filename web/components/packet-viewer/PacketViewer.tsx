"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import { PRESETS } from "@/lib/psdl/presets";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { setupDerivedCounts } from "@/lib/psdl/setup-derived-counts";
import {
  initialState,
  packetCategories,
  syncChainControllers,
  syncTlvControllers,
} from "@/lib/psdl/renderer-helpers";
import {
  applyTlvInstances,
  mergeInstancesIntoPsdl,
  psdlToRenderer,
  rendererToPsdl,
} from "@/lib/psdl/psdl-to-renderer";
import type { TlvSlotBytes } from "@/lib/psdl/psdl-to-renderer/apply-tlv";
import { updatePacketField } from "@/lib/psdl/packet-update";
import { DEFAULT_BYTE_ORDER } from "@/lib/constants";
import { editReducer, makeInitialState } from "@/lib/psdl/edit-reducer";
import {
  loadCustomPresets,
  saveCustomPreset,
  deleteCustomPreset,
} from "@/lib/psdl/custom-presets";
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
  SubField,
  TlvInstance,
} from "@/lib/psdl/renderer";
import type { PsdlPacket } from "@/lib/psdl/types";
import { EnrichedText } from "@/components/common/EnrichedText";
import DetailPanel from "@/components/field-details/DetailPanel";
import OverridePanel from "@/components/field-details/OverridePanel";
import DiagramRuler from "@/components/diagram/DiagramRuler";
import FieldPopover from "@/components/diagram/FieldPopover";
import HexStrip from "@/components/diagram/HexStrip";
import HybridDiagram from "@/components/diagram/HybridDiagram";
import ImportExportDrawer from "@/components/import-export/ImportExportDrawer";
import Legend from "@/components/diagram/Legend";
import OnboardingTour, {
  hasSeenTour,
  type TourStep,
} from "@/components/onboarding/OnboardingTour";
import PacketToolbar from "./PacketToolbar";
import SavePresetDialog from "./SavePresetDialog";
import StudioPanel from "./StudioPanel";
import {
  useAutoClearStatus,
  useDelayedOnce,
  useFieldHighlight,
  useIsWideViewport,
  useRovingTabindex,
  useUndoRedoShortcuts,
} from "./hooks";
import { initialUiState, uiReducer } from "./ui-state-reducer";

const DEFAULT_PACKET_KEY = "ipv4";
const BUILT_IN_PRESET_KEYS = Object.keys(PRESETS);
const CUSTOM_PRESET_NAME_MAX = 80;
const SHARED_CUSTOM_PRESET_FALLBACK_NAME = "Shared packet";

// Mapping from a length-controller slider to its TLV Options *slot*: the
// number of bytes the user has carved out by setting the controller.
// `applyTlvInstances` reads this to size the Stage 1 placeholder and the
// Stage 2 trailing-remaining cell, so the diagram closes cleanly on the
// controller boundary even when `tlv.instances` is empty or partial.
// Matched by packet shape (TLV field id + controller presence), not by
// preset key — so a `custom:<name>` copy of IPv4/TCP keeps the slot sync.
const TLV_LENGTH_SYNC: Array<{
  controllerKey: string;
  tlvFieldId: string;
  offset: number;
}> = [
  {
    controllerKey: "ihl",
    tlvFieldId: "options",
    offset: 5,
  },
  {
    controllerKey: "dataOffset",
    tlvFieldId: "options",
    offset: 5,
  },
];

// Width threshold at which the floating field popover is enabled. Below this
// we rely on the inline DetailPanel only.
const POPOVER_MIN_WIDTH = 900;

// Synthetic key used during SSR / pre-hydration when the URL carries a
// PSDL-encoded custom packet. The hydration effect replaces it with the
// canonical `custom:<name>` key once the packet is persisted to localStorage.
const PSDL_INITIAL_KEY = "__psdl_initial__";

type PacketViewerProps = {
  initialPacketKey?: string;
  initialControllers?: ControllerState;
  initialPsdlPacket?: PsdlPacket;
};

export default function PacketViewer({
  initialPacketKey = DEFAULT_PACKET_KEY,
  initialControllers,
  initialPsdlPacket,
}: PacketViewerProps) {
  const [packetKey, setPacketKey] = useState<string>(
    initialPsdlPacket ? PSDL_INITIAL_KEY : initialPacketKey,
  );
  // source ビュー (SourcePane) の未反映編集フラグ。 debounce 前 / parse
  // エラー中のテキストは studio reducer の history に乗らないので、 Discard
  // 確認をこのフラグでも引っ掛ける (Codex P2)。
  const [sourceDirty, setSourceDirty] = useState(false);
  // Imported packets are kept in the renderer shape so the editors can mutate
  // their TLV/Chain/subfield state directly. Built-in presets live in PSDL
  // and are lowered to the renderer shape on demand.
  const [importedPackets, setImportedPackets] = useState<PacketRegistry>(() => {
    if (!initialPsdlPacket) return {} as PacketRegistry;
    return {
      [PSDL_INITIAL_KEY]: psdlToRenderer(initialPsdlPacket),
    } as PacketRegistry;
  });
  // The renderer-shape mirror of every built-in PSDL preset. Lowered once on
  // mount; TLV/Chain edits replace the relevant packet entry immutably via
  // `updatePacketField` (the format hub re-lifts back to PSDL at export time).
  const [renderedPresets, setRenderedPresets] = useState<PacketRegistry>(() => {
    const out: PacketRegistry = {};
    for (const [k, v] of Object.entries(PRESETS)) {
      out[k] = psdlToRenderer(v);
    }
    return out;
  });

  // Custom Packet Studio — user-saved presets pulled out of localStorage.
  // Keyed `custom:<name>`; PresetPicker renders these under a 'My presets'
  // optgroup.
  const [customPresets, setCustomPresets] = useState<
    Record<string, PsdlPacket>
  >(() =>
    initialPsdlPacket
      ? { [PSDL_INITIAL_KEY]: initialPsdlPacket }
      : ({} as Record<string, PsdlPacket>),
  );
  // Lowered renderer mirror of the active custom preset, if any.
  const customRenderer: Packet | null = useMemo(() => {
    const cp = customPresets[packetKey];
    return cp ? psdlToRenderer(cp) : null;
  }, [customPresets, packetKey]);

  // Renderer mirror — the shape the UI editors / detail panels consume.
  const packet: Packet =
    renderedPresets[packetKey] ??
    importedPackets[packetKey] ??
    customRenderer ??
    renderedPresets[DEFAULT_PACKET_KEY];

  const [controllers, setControllers] = useState<ControllerState>(() => {
    if (initialPsdlPacket) {
      const rendered = psdlToRenderer(initialPsdlPacket);
      return { ...initialState(rendered), ...(initialControllers ?? {}) };
    }
    const packet = PRESETS[initialPacketKey] ?? PRESETS[DEFAULT_PACKET_KEY];
    return initialControllers ?? initialState(psdlToRenderer(packet));
  });

  // Custom Packet Studio reducer. Seeded from the default preset; we
  // reseed via 'replace-packet' on preset switch so history doesn't span
  // unrelated packets.
  const [studioState, dispatch] = useReducer(
    editReducer,
    initialPsdlPacket ??
      PRESETS[initialPacketKey] ??
      PRESETS[DEFAULT_PACKET_KEY],
    makeInitialState,
  );
  // UI shell state — visibility toggles, selection, drawer mode, etc.
  // The reducer lives in `ui-state-reducer.ts`; keeping it pure and away
  // from the data flow above makes intent of each transition (e.g.
  // "preset-switched" resets edit + json pane) explicit.
  const [ui, uiDispatch] = useReducer(uiReducer, initialUiState);
  const {
    editMode,
    studioView,
    showSaveDialog,
    selectedFieldId,
    popoverAnchor,
    drawerMode,
    tourOpen,
    hexStripVisible,
    viewMode,
    shareStatus,
  } = ui;
  // Export must follow the same source of truth as the live diagram. While the
  // studio is open, layout is derived from in-progress PSDL edits rather than
  // the last selected preset/import, so lower that edited packet for consumers
  // that still need renderer metadata such as `name` and `rowBits`.
  const exportPacket = useMemo(
    () => (editMode ? psdlToRenderer(studioState.packet) : packet),
    [editMode, packet, studioState.packet],
  );
  const isWideViewport = useIsWideViewport(POPOVER_MIN_WIDTH);
  const [urlHydrated, setUrlHydrated] = useState(false);

  const diagramRef = useRef<HTMLDivElement | null>(null);

  // Pull user-saved presets from localStorage, then apply shared URL state.
  // URL hydration must run exactly once at mount: subsequent edits flow
  // through `setRenderedPresets` (TLV / chain edits on a built-in preset),
  // which would otherwise re-trigger this effect via `[renderedPresets]`
  // and clobber the user's controller state with the original share URL.
  // The ref gate fires synchronously inside the same effect run as the
  // state update so React's StrictMode double-invocation is also safe.
  const hydrationRanRef = useRef(false);
  useEffect(() => {
    if (hydrationRanRef.current) return;
    hydrationRanRef.current = true;
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
    if (parsed.kind === "psdl") {
      const { key, presets } = persistSharedCustomPreset(parsed.packet, stored);
      setCustomPresets(presets);
      setPacketKey(key);
      setControllers({
        ...initialState(psdlToRenderer(parsed.packet)),
        ...parsed.controllers,
      });
      // Remove the SSR placeholder now that the packet has been promoted to
      // custom:<name>. Without this, the picker shows the same packet twice —
      // once under "My presets" and once under "Imported".
      setImportedPackets((prev) => {
        if (!(PSDL_INITIAL_KEY in prev)) return prev;
        const next = { ...prev };
        delete next[PSDL_INITIAL_KEY];
        return next;
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
        console.warn(
          `Packet Schema Visualizer ignored share URL: ${parsed.error}`,
        );
      }
    }
    setUrlHydrated(true);
    // renderedPresets is intentionally not in the deps — see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The active PSDL packet for the studio reducer. Prefers built-in PSDL,
  // then a custom preset, then a lifted version of the imported renderer
  // packet (lossy but acceptable as a starting point for editing).
  const activePsdlPacket: PsdlPacket = useMemo(() => {
    return (
      PRESETS[packetKey] ??
      customPresets[packetKey] ??
      (importedPackets[packetKey]
        ? rendererToPsdl(importedPackets[packetKey])
        : PRESETS[DEFAULT_PACKET_KEY])
    );
  }, [packetKey, customPresets, importedPackets]);

  // Re-seed the studio reducer in-place when the active PSDL packet swaps
  // (preset change, custom preset selection, import). Detecting the change
  // during render and dispatching synchronously is the React-recommended
  // alternative to a useEffect — it keeps `studioState.packet` aligned with
  // `activePsdlPacket` on the same render that observed the change, avoiding
  // a flash of stale state.
  // See: https://react.dev/learn/you-might-not-need-an-effect
  const lastReducerPacketRef = useRef(activePsdlPacket);
  if (lastReducerPacketRef.current !== activePsdlPacket) {
    lastReducerPacketRef.current = activePsdlPacket;
    dispatch({ type: "replace-packet", packet: activePsdlPacket });
  }

  useUndoRedoShortcuts({
    // editMode の中で GUI / source どちらのビューでも有効。
    enabled: editMode,
    onUndo: () => dispatch({ type: "undo" }),
    onRedo: () => dispatch({ type: "redo" }),
  });

  useDelayedOnce(!hasSeenTour(), 350, () =>
    uiDispatch({ type: "set-tour-open", open: true }),
  );

  // Default the hex strip on for wide viewports the first time we know the
  // viewport size. Once the user toggles, leave their preference alone.
  useEffect(() => {
    if (ui.hexStripUserSet) return;
    uiDispatch({
      type: "set-hex-strip-visible",
      visible: isWideViewport,
      userInitiated: false,
    });
  }, [isWideViewport, ui.hexStripUserSet]);

  // Bidirectional highlight wiring. Both the diagram cells and the hex strip
  // call this; the hook paints `.hex-match` on matching cells and mirrors
  // the active id on the diagram root via `data-highlighted-field`.
  // Implemented imperatively on purpose (hover fires dozens of times per
  // second; re-rendering the entire packet tree each time is wasteful).
  const handleFieldHover = useFieldHighlight(diagramRef);

  const handlePacketChange = useCallback(
    (nextKey: string) => {
      setPacketKey(nextKey);
      const customPreset = customPresets[nextKey];
      const next =
        renderedPresets[nextKey] ??
        importedPackets[nextKey] ??
        (customPreset ? psdlToRenderer(customPreset) : null);
      if (next) setControllers(initialState(next));
      // `preset-switched` resets selection, popover anchor, edit mode, and
      // the json pane in one shot. Otherwise `targetPsdl` would briefly
      // fall back to `studioState.packet` (still pointing at the previous
      // preset) and the diagram would render mixed cells.
      uiDispatch({ type: "preset-switched" });
      // Restore focus to the diagram so an editMode focus inside the
      // editor (now unmounted) doesn't strand the user on `<body>`
      // (sub-agent Round 9 HIGH). Defer one frame for the re-render.
      if (typeof window !== "undefined") {
        window.requestAnimationFrame(() => {
          const grid = diagramRef.current?.querySelector<HTMLElement>(
            '[role="gridcell"][tabindex="0"]',
          );
          grid?.focus();
        });
      }
    },
    [customPresets, importedPackets, renderedPresets],
  );

  // Everything in the hybrid renderer is an HTMLElement, so anchorRect is a
  // straight getBoundingClientRect() — no SVG branching required.
  const handleFieldClick = useCallback(
    (fieldId: string, elem: HTMLElement | null) => {
      const anchor =
        isWideViewport && elem ? elem.getBoundingClientRect() : null;
      uiDispatch({ type: "select-field", id: fieldId, anchor });
    },
    [isWideViewport],
  );

  // Stable callbacks for HybridDiagram. Without these, the JSX-inline
  // arrow functions would mint new identities every render and bypass
  // FieldCell's `memo` equality, so every slider drag would re-render
  // every cell (~ 50+ cells × 60 fps ≈ 3000 reconciliations/s).
  const handleFieldClickWithField = useCallback(
    (field: Field, elem: HTMLElement) => handleFieldClick(field.id, elem),
    [handleFieldClick],
  );
  const handleSubfieldClick = useCallback(
    (parentField: Field, subfield: SubField, elem: HTMLElement) =>
      handleFieldClick(`${parentField.id}:${subfield.id}`, elem),
    [handleFieldClick],
  );

  const handleImport = useCallback(
    (imported: Packet, importedControllers: ControllerState) => {
      const key = `imported:${imported.name}`;
      setImportedPackets((prev) => ({ ...prev, [key]: imported }));
      setPacketKey(key);
      setControllers({ ...initialState(imported), ...importedControllers });
      uiDispatch({ type: "clear-selection" });
      uiDispatch({ type: "close-drawer" });
      // editMode を抜けて新しい packet に視点を合わせる。 set-edit-mode
      // false で studioView も "form" に戻るので、 import 後すぐ Edit
      // packet を ON にし直しても古い source 編集状態は引き継がない。
      uiDispatch({ type: "set-edit-mode", editing: false });
    },
    [],
  );

  // Swap whichever registry currently owns `packetKey` (built-in mirror /
  // imported / custom) for a new Packet. Keeps TLV/Chain edits visible
  // across preset switches without mutating shared field objects.
  const replaceActivePacket = useCallback(
    (nextPacket: Packet) => {
      if (renderedPresets[packetKey]) {
        setRenderedPresets((prev) => ({ ...prev, [packetKey]: nextPacket }));
      } else if (importedPackets[packetKey]) {
        setImportedPackets((prev) => ({ ...prev, [packetKey]: nextPacket }));
      } else {
        // Custom preset edits: keep the source PSDL untouched and
        // persist the renderer-shape edit in `renderedPresets` instead.
        //
        // The earlier approach (`setCustomPresets ← rendererToPsdl(...)`,
        // even with constraints merged back) bakes the renderer model's
        // lossy collapse of Encrypted / Switch / Optional containers
        // into the source PSDL on every TLV / Chain edit (Codex P1).
        // The renderer mirror lookup at the top of this component
        // already falls back to `renderedPresets[packetKey]` ??
        // `customRenderer` (which re-derives from customPresets), so
        // writing the edit to `renderedPresets[packetKey]` lets the UI
        // pick up the change immediately while the canonical PSDL
        // stays intact. A preset switch + return re-derives the
        // renderer view from the source; only an explicit
        // "Save as preset" should rebuild the persisted PSDL.
        setRenderedPresets((prev) => ({ ...prev, [packetKey]: nextPacket }));
      }
    },
    [packetKey, renderedPresets, importedPackets],
  );

  // Plain controller update; the TLV slot size derives from `controllers`
  // inside `tlvSlotBytes` and flows to `applyTlvInstances`, so this hook
  // doesn't need to do anything else.
  const handleControllerChange = useCallback((key: string, value: number) => {
    setControllers((prev) => ({ ...prev, [key]: value }));
  }, []);

  // TLV edits replace the field's `tlv.instances` immutably and re-sync
  // TLV-driven controllers afterwards.
  const handleTlvChange = useCallback(
    (field: Field, next: TlvInstance[]) => {
      if (!field.tlv) return;
      const tlv = field.tlv;
      const nextPacket = updatePacketField(packet, field.id, (f) => ({
        ...f,
        tlv: { ...tlv, instances: next },
      }));
      replaceActivePacket(nextPacket);
      setControllers((prev) => syncTlvControllers(nextPacket, prev));
    },
    [packet, replaceActivePacket],
  );

  const handleByteOrderChange = useCallback(
    (fieldId: string, next: "BE" | "LE") => {
      const nextPacket = updatePacketField(packet, fieldId, (f) => ({
        ...f,
        byteOrder: next,
      }));
      replaceActivePacket(nextPacket);
    },
    [packet, replaceActivePacket],
  );

  const handleChainChange = useCallback(
    (
      field: Field,
      next: { instances: ChainInstance[]; finalProto?: number },
    ) => {
      const nextPacket = updatePacketField(packet, field.id, (f) => ({
        ...f,
        chainInstances: next.instances,
        // Reflect the editor's payload verbatim — ChainEditor's `emit`
        // already defaults `nextFinal` to the current `finalProto`, so
        // an undefined value here means the user explicitly picked
        // "(none)" and wants the terminal proto cleared. Falling back
        // to `f.chainFinalProto` (as the earlier `typeof === "number"`
        // form did) made the clear path silently no-op, leaving stale
        // final-proto state on the packet (Codex P1).
        chainFinalProto: next.finalProto,
      }));
      replaceActivePacket(nextPacket);
      setControllers((prev) => syncChainControllers(nextPacket, prev));
    },
    [packet, replaceActivePacket],
  );

  // Memoise the studio-packet-with-mirror-state merge so it isn't
  // recomputed on every render. Without the memo, every controller drag
  // walks the whole PSDL body and JsonPane re-stringifies its 200+ leaves
  // (sub-agent Round 7 MEDIUM). Save-As and share both reuse this value.
  // Declared above `handleSaveAsPreset` / `buildCurrentShareUrl` so those
  // callbacks can reference it in their dep arrays without a TDZ.
  const mergedStudioPacket: PsdlPacket = useMemo(
    () => mergeInstancesIntoPsdl(studioState.packet, packet),
    [studioState.packet, packet],
  );

  // Save the in-progress edit as a user-owned preset. The `custom:<name>`
  // key namespace keeps user-saved presets separate from built-ins and
  // imports so the picker can group them cleanly.
  const handleSaveAsPreset = useCallback(
    (name: string) => {
      if (!name.trim()) return;
      const normalizedName = normalizeCustomPresetName(name);
      const key = `custom:${normalizedName}`;
      // Merge the renderer mirror's TLV / chain / byteOrder edits onto
      // the studio packet before persistence — without this, diagram-
      // driven edits (which only land on the mirror) silently drop on
      // save (sub-agent CRITICAL).
      const packetToSave: PsdlPacket = {
        ...mergedStudioPacket,
        name: normalizedName,
      };
      saveCustomPreset(key, packetToSave);
      setCustomPresets(loadCustomPresets());
      // Drop any stale renderer-mirror cache for this key. The custom-
      // edit path writes renderer packets into `renderedPresets[key]`
      // for session-only persistence; without this evict, saving over
      // an existing `custom:<name>` keeps the old renderer ahead of
      // the freshly persisted PSDL in `packet`'s resolution order and
      // the UI shows stale data (Codex P2). The next render will
      // re-derive from `customPresets[key]` → `customRenderer`.
      setRenderedPresets((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setPacketKey(key);
      setControllers(initialState(psdlToRenderer(packetToSave)));
      uiDispatch({ type: "clear-selection" });
      uiDispatch({ type: "close-save-dialog" });
      // set-edit-mode false で studioView が "form" にリセットされる
      // (ui-state-reducer 側で同時にハンドリング)。
      uiDispatch({ type: "set-edit-mode", editing: false });
    },
    [mergedStudioPacket],
  );

  // Drop in-progress edits and revert the reducer to the active preset.
  const handleDiscardEdits = useCallback(() => {
    // Confirm before nuking edits if the user has actually changed anything.
    // 2 つの signal を OR で見る:
    //  - studioState.history.length: form 編集 (history-driven)。 diagram-
    //    driven edits は history に乗らないので、 schema を触っていなければ
    //    confirm をスキップする (sub-agent Round 9 HIGH)。
    //  - sourceDirty: source ビューの未反映テキスト (debounce 前 / parse
    //    エラー中)。 history に乗らないので、 これも見ないと入力中の内容を
    //    無警告で失う (Codex P2)。
    const hasUnsavedEdits = studioState.history.length > 0 || sourceDirty;
    if (
      hasUnsavedEdits &&
      typeof window !== "undefined" &&
      !window.confirm("Discard all unsaved edits?")
    ) {
      return;
    }
    dispatch({ type: "replace-packet", packet: activePsdlPacket });
    // Also evict the renderer mirror back to its source-of-truth shape.
    // Without this, diagram-driven edits (TLV / chain instances,
    // byteOrder, controllers) survive on the mirror past the discard,
    // so re-entering editMode still shows the records and a follow-up
    // Save-As resurrects them via `mergeInstancesIntoPsdl` (sub-agent
    // CRITICAL C2). Rebuilding from `activePsdlPacket` is cheap and
    // makes "discard" actually mean discard.
    replaceActivePacket(psdlToRenderer(activePsdlPacket));
    setControllers(initialState(psdlToRenderer(activePsdlPacket)));
    uiDispatch({ type: "clear-selection" });
    // set-edit-mode false で studioView も "form" に戻る (ui-state-reducer)。
    uiDispatch({ type: "set-edit-mode", editing: false });
    // Send focus somewhere reachable — the diagram root — so SR and
    // keyboard users aren't dropped on `<body>` when the editor unmounts
    // (sub-agent Round 9 HIGH). Defer one frame so React has finished
    // unmounting the now-orphaned focus target.
    if (typeof window !== "undefined") {
      window.requestAnimationFrame(() => {
        const grid = diagramRef.current?.querySelector<HTMLElement>(
          '[role="gridcell"][tabindex="0"]',
        );
        grid?.focus();
      });
    }
  }, [
    activePsdlPacket,
    replaceActivePacket,
    studioState.history.length,
    sourceDirty,
  ]);

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
          saveCustomPreset(key, pkt as PsdlPacket);
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
    // Drop any cached renderer mirror for this custom key — `replace
    // ActivePacket` writes edits into `renderedPresets[packetKey]` for
    // custom presets, so a `custom:foo` re-created with the same name
    // after deletion would otherwise re-bind to the stale cached
    // renderer packet instead of the freshly imported one (Codex P2).
    setRenderedPresets((prev) => {
      if (!(packetKey in prev)) return prev;
      const next = { ...prev };
      delete next[packetKey];
      return next;
    });
    setPacketKey(DEFAULT_PACKET_KEY);
    uiDispatch({ type: "set-edit-mode", editing: false });
  }, [packetKey, customPresets]);

  const buildCurrentShareUrl = useCallback(() => {
    if (typeof window === "undefined") return "";
    const builtInPsdl = PRESETS[packetKey];
    const customSource = builtInPsdl ? undefined : customPresets[packetKey];
    // Custom preset edits live in `renderedPresets` (see
    // `replaceActivePacket` custom arm) and the source PSDL in
    // `customPresets[packetKey]` stays untouched. Decide which one to
    // share based on whether the user has actually edited:
    //
    //  - editMode → always share the studio state (the user's draft).
    //  - built-in → share the built-in PSDL (preset key + controllers
    //    are enough, but emitting the PSDL preserves any constraints
    //    we want the recipient to see).
    //  - custom + no renderer override → share the source PSDL so its
    //    `constraints` / Encrypted / Switch / Optional containers
    //    survive (rendererToPsdl would strip them — Codex P1).
    //  - custom + renderer override → lift the renderer packet back to
    //    PSDL so the recipient sees the TLV / Chain edits actually
    //    visible on screen (lossy for non-renderer constructs but
    //    necessary; matching screen-state is the priority once the
    //    user has touched the editor).
    //  - imported → no source PSDL available, lift from renderer.
    const hasCustomRendererOverride =
      !builtInPsdl && renderedPresets[packetKey] !== undefined;
    const sharePacket = editMode
      ? // In editMode the diagram draws from studioState.packet but TLV /
        // chain edits only land on the renderer mirror — without the
        // merge, the shared URL silently drops every record the user
        // added through the diagram (sub-agent CRITICAL #2). Re-uses the
        // memo so we don't walk the body twice per share click.
        mergedStudioPacket
      : builtInPsdl
        ? builtInPsdl
        : hasCustomRendererOverride
          ? rendererToPsdl(packet)
          : (customSource ?? rendererToPsdl(packet));
    const defaultControllers = builtInPsdl
      ? initialState(psdlToRenderer(builtInPsdl))
      : undefined;

    return buildShareUrl({
      baseUrl: window.location.href,
      packetKey,
      packet: sharePacket,
      controllers,
      builtInKeys: BUILT_IN_PRESET_KEYS,
      defaultControllers,
      forcePsdl: editMode || !builtInPsdl,
    });
  }, [
    controllers,
    customPresets,
    editMode,
    mergedStudioPacket,
    packet,
    packetKey,
    renderedPresets,
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
        `Packet Schema Visualizer could not update the share URL: ${(err as Error).message}`,
      );
    }
  }, [buildCurrentShareUrl, urlHydrated]);

  useAutoClearStatus(shareStatus, 2400, () =>
    uiDispatch({ type: "clear-share-status" }),
  );

  const handleShare = useCallback(async () => {
    try {
      const url = buildCurrentShareUrl();
      const bytes = shareUrlByteLength(url);
      if (bytes > SHARE_URL_WARN_BYTES) {
        console.warn(
          `Packet Schema Visualizer share URL is ${bytes} bytes, exceeding ${SHARE_URL_WARN_BYTES}; copied anyway.`,
        );
      }
      // Try the async Clipboard API first, then fall through to the
      // legacy execCommand path if it's missing (non-secure context) *or*
      // rejected at call time (Permissions-Policy / NotAllowedError on
      // background tabs, iframes without `clipboard-write`, etc.).
      let copied = false;
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(url);
          copied = true;
        } catch {
          // Swallow the reject and let the fallback below try.
        }
      }
      if (!copied) {
        // We can't reuse a page textarea like ImportExportDrawer does
        // because the share URL is not rendered anywhere, so spin up a
        // hidden one just for the execCommand call.
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.setAttribute("readonly", "");
        // Hide from assistive tech + tab order so screen readers don't
        // announce the brief mount/unmount and keyboard users can't tab
        // into the throwaway element.
        ta.setAttribute("aria-hidden", "true");
        ta.tabIndex = -1;
        // `position: fixed` + opacity 0 avoids the iOS / Android scroll
        // jump that a plain off-screen textarea would cause.
        ta.style.position = "fixed";
        ta.style.top = "0";
        ta.style.left = "0";
        ta.style.opacity = "0";
        // `ta.select()` steals focus from whatever invoked the share,
        // typically the Share button. Capture and restore it so the
        // user's focus context doesn't jump after the copy.
        const prevFocus = document.activeElement;
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try {
          ok = document.execCommand("copy");
        } finally {
          document.body.removeChild(ta);
          if (prevFocus instanceof HTMLElement) prevFocus.focus();
        }
        if (!ok) {
          throw new Error("Copy command was rejected by the browser.");
        }
      }
      if (typeof window !== "undefined" && window.location.href !== url) {
        window.history.replaceState(null, "", url);
      }
      // Surface oversize URLs through the share-status toast — a console
      // warn alone is invisible to users who don't open devtools, and a
      // share URL pushed past common browser limits (e.g. ~2 KB) silently
      // truncates on paste (sub-agent Round 7 HIGH).
      if (bytes > SHARE_URL_WARN_BYTES) {
        uiDispatch({
          type: "set-share-status",
          status: {
            msg: `Share URL copied — ${bytes} B may exceed browser limits.`,
            kind: "error",
          },
        });
      } else {
        uiDispatch({
          type: "set-share-status",
          status: { msg: "Share URL copied.", kind: "ok" },
        });
      }
    } catch (err) {
      uiDispatch({
        type: "set-share-status",
        status: {
          msg: `Share failed: ${(err as Error).message}`,
          kind: "error",
        },
      });
    }
  }, [buildCurrentShareUrl]);

  const tourSteps: TourStep[] = useMemo(
    () => [
      {
        title: "Welcome to Packet Schema Visualizer",
        body: "Packet Schema Visualizer teaches network protocols visually. Pick a packet, click any field, and tweak sliders to see how the bytes line up.",
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
        body: "Cells with a dot in the corner expose a runtime knob. Click one (e.g. IHL on IPv4) and use the slider in the field detail panel to watch the header reflow.",
        target: () =>
          document.querySelector(
            '.field-cell[data-overridable="true"]',
          ) as HTMLElement | null,
        placement: "bottom",
      },
    ],
    [],
  );

  // NOTE: an earlier revision wrapped `controllers` in `useDeferredValue` to
  // smooth slider drags. That breaks preset switches: when `packetKey`
  // changes, `controllers` is replaced with the new preset's defaults
  // synchronously, but a deferred copy keeps the *previous* preset's keys
  // alive for one or more frames — so e.g. switching from IPv4 to IPv6
  // leaves a stale `ihl` in the env, and the IPv6 diagram is laid out as
  // if IHL were still active. We need `packet`-and-`controllers` to stay
  // in lockstep, so the synchronous value is the only safe choice.
  // The PSDL packet feeding `resolveLayout` — depends only on the active
  // entry, never on the whole `customPresets` map. Pulling this out lets
  // `psdlRefs` (an AST walk) re-run only when the body actually changes,
  // not every time another preset is edited.
  // Memoise the slot-byte vector against only the controllers TLV_LENGTH_SYNC
  // reads, so unrelated slider drags (TTL, Source Address, …) don't invalidate
  // `targetPsdl` and re-walk the whole PSDL body.
  const tlvSlotBytes: TlvSlotBytes = useMemo(() => {
    const slotBytes: TlvSlotBytes = {};
    for (const rule of TLV_LENGTH_SYNC) {
      // Match on the active packet's *shape* rather than the exact preset
      // key: a preset saved as `custom:<name>` keeps the same `options`
      // TLV field + `ihl`/`dataOffset` controller, so a key-equality
      // check (`rule.presetKey === packetKey`) would silently drop the
      // slot sync and make the saved copy lay out differently from the
      // built-in (Codex P2). Require both the TLV field and the
      // controller to be present so the two rules (ipv4 `ihl` / tcp
      // `dataOffset`) don't cross-fire on a packet that has only one.
      const hasTlvField = packet.fields.some(
        (f) => f.id === rule.tlvFieldId && f.tlv,
      );
      const hasController = rule.controllerKey in controllers;
      if (!hasTlvField || !hasController) continue;
      const ctrl = Number(controllers[rule.controllerKey] ?? 0);
      slotBytes[rule.tlvFieldId] = Math.max(0, ctrl - rule.offset) * 4;
    }
    return slotBytes;
    // The TLV_LENGTH_SYNC entries are static, so reading every controller
    // they reference plus the active packet (for the field-presence
    // check) is the right minimum dep set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packet, ...TLV_LENGTH_SYNC.map((r) => controllers[r.controllerKey])]);

  // Narrow the `customPresets` dependency to only the active key —
  // editing another preset in the same map shouldn't re-walk the active
  // packet's PSDL (sub-agent Round 7 MEDIUM). React's strict-equality
  // useMemo dep check is satisfied by the same object reference, so
  // structuring as a hoisted memo keeps the original semantics.
  const activeCustomPreset = customPresets[packetKey];
  const targetPsdl: PsdlPacket = useMemo(() => {
    // editMode (Custom Packet Studio が開いている) なら studio reducer
    // の packet が真値。 GUI / source どちらのビューで編集していても
    // 同じ reducer を経由するので、 上の diagram は常にここを映す。
    const base = editMode
      ? studioState.packet
      : (PRESETS[packetKey] ?? activeCustomPreset ?? rendererToPsdl(packet));
    // Per-TLV slot sizes derived from the upstream length controller (e.g.
    // IPv4 IHL → 8-byte Options slot for IHL=7). `applyTlvInstances`
    // either emits an empty placeholder of this size (when no instances
    // are attached yet) or a trailing "remaining" placeholder after the
    // instance Groups.
    return applyTlvInstances(base, packet, tlvSlotBytes);
  }, [
    editMode,
    studioState.packet,
    packetKey,
    activeCustomPreset,
    packet,
    tlvSlotBytes,
  ]);

  // Set of ref-names that the active packet expects in `env`. Cached against
  // `targetPsdl` so slider drag (which mutates `controllers` every frame but
  // leaves the body untouched) does not re-walk the AST 60×/sec.
  const psdlRefs = useMemo(() => collectPsdlRefs(targetPsdl), [targetPsdl]);

  const layout = useMemo(() => {
    // Every preset is PSDL now — route the diagram through resolveLayout so
    // Encrypted-container decoration and viewMode toggling are uniform.
    // For imported packets the renderer mirror is the source of truth and we
    // lift it back to PSDL on demand (lossy for variable-length payloads
    // without TLV metadata, which is acceptable for layout purposes).
    const env = new Map(
      Object.entries(controllers).map(([k, v]) => [k, Number(v)] as const),
    );
    setupDerivedCounts(env);
    // Default value seed: packet が宣言する Field.defaultValue を env に
    // 入れる (controllers が既に値を持っていれば優先 — UI スライダーの
    // 入力を上書きしない)。 これを fallback seed より先にやらないと、
    // 後段の `if (!env.has(r)) env.set(r, 0)` が defaultValue を 0 で
    // 潰してしまい (例: quicLong の dcidLength / scidLength = 8 → 0)、
    // 既存 preset の variable-length field が zero-length に描かれる
    // regression を起こす (Codex P1 指摘)。
    const packetDefaults = initialEnv(targetPsdl);
    for (const [k, v] of packetDefaults) {
      if (!env.has(k)) env.set(k, v);
    }
    // Fallback seed: packet が使う ref のうち env に未登録のものは 0 で
    // 埋める。 これがないと、 preset 切り替え時に packet が要求する ref を
    // PacketViewer 側が手動で seed しない限り `resolveLayout` が
    // MissingRefError で throw → React render が落ちて "Application error"
    // 画面になる。 issue #91 で追加した 8 個の preset を含め、 controllers
    // と命名が一致しない ref をまとめて吸収する。
    for (const r of psdlRefs) {
      if (!env.has(r)) env.set(r, 0);
    }
    return resolveLayout(targetPsdl, { env, viewMode });
  }, [targetPsdl, psdlRefs, controllers, viewMode]);

  const categories = useMemo(() => packetCategories(packet), [packet]);

  const bytes = layout.totalBits / 8;
  const byteStr = Number.isInteger(bytes)
    ? `${bytes} bytes`
    : `${layout.totalBits} bits`;

  // Roving tabindex keyboard navigation on the diagram. The hook owns the
  // imperative DOM operations (`setAttribute("tabindex", …)` + focus()) so
  // PacketViewer stays declarative.
  const handleDiagramKeyDown = useRovingTabindex(diagramRef);

  useEffect(() => {
    if (!urlHydrated) return;
    const title = exportPacket.name
      ? `${exportPacket.name} | Packet Schema Visualizer`
      : "Packet Schema Visualizer";
    let id2: number | null = null;
    const id1 = requestAnimationFrame(() => {
      id2 = requestAnimationFrame(() => {
        document.title = title;
      });
    });
    return () => {
      cancelAnimationFrame(id1);
      if (id2 !== null) cancelAnimationFrame(id2);
    };
  }, [urlHydrated, exportPacket.name]);

  return (
    <>
      <main className="max-w-[1200px] mx-auto px-6 py-3 pb-10 w-full flex-1">
        <PacketToolbar
          packetKey={packetKey}
          importedPackets={importedPackets}
          customPresets={customPresets}
          hexStripVisible={hexStripVisible}
          editMode={editMode}
          viewMode={viewMode}
          headerSizeLabel={`${layout.totalBits} bits (${byteStr})`}
          shareStatus={shareStatus}
          actions={{
            onPacketChange: handlePacketChange,
            onExportCustomPresets: handleExportCustomPresets,
            onImportCustomPresets: handleImportCustomPresetsClick,
            onOpenImport: () =>
              uiDispatch({ type: "open-drawer", mode: "import" }),
            onOpenExport: () =>
              uiDispatch({ type: "open-drawer", mode: "export" }),
            onShare: handleShare,
            onToggleHexStrip: () => uiDispatch({ type: "toggle-hex-strip" }),
            onToggleViewMode: () => uiDispatch({ type: "toggle-view-mode" }),
            onToggleEditMode: () => uiDispatch({ type: "toggle-edit-mode" }),
            onDeleteCustomPreset: handleDeleteCustomPreset,
          }}
        />
        <input
          ref={bulkImportInputRef}
          type="file"
          accept=".json,application/json"
          onChange={handleImportCustomPresetsFile}
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
        />

        {packet.description ? (
          <p className="text-sm-tight mx-0.5 mt-2 mb-1 text-fg-muted">
            <EnrichedText text={packet.description} />
          </p>
        ) : null}
        <p className="text-xs mx-0.5 mb-3 italic flex items-center gap-1.5 text-fg-faint">
          <span className="not-italic font-bold text-accent" aria-hidden="true">
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
              onFieldClick={handleFieldClickWithField}
              onSubfieldClick={handleSubfieldClick}
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
          </div>
          <Legend categories={categories} />
        </div>

        {editMode ? (
          <StudioPanel
            state={studioState}
            dispatch={dispatch}
            view={studioView}
            onViewChange={(view) =>
              uiDispatch({ type: "set-studio-view", view })
            }
            onSaveAs={() => uiDispatch({ type: "open-save-dialog" })}
            onDiscard={handleDiscardEdits}
            onSourceDirtyChange={setSourceDirty}
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
            <h2 className="text-xs m-0 mb-3 uppercase tracking-wider font-bold text-fg-muted">
              Field detail
            </h2>
            <DetailPanel
              packet={packet}
              selectedFieldId={selectedFieldId}
              controllers={controllers}
            />
          </section>

          <section
            className="rounded-[10px] border px-4 py-3.5"
            style={{
              background: "var(--bg-elevated)",
              borderColor: "var(--border)",
              boxShadow: "0 1px 2px rgba(15,22,50,0.05)",
            }}
          >
            <h2 className="text-xs m-0 mb-3 uppercase tracking-wider font-bold text-fg-muted">
              Override
            </h2>
            <OverridePanel
              packet={packet}
              selectedFieldId={selectedFieldId}
              controllers={controllers}
              onTlvChange={handleTlvChange}
              onChainChange={handleChainChange}
              onControllerChange={handleControllerChange}
              onByteOrderChange={handleByteOrderChange}
              tlvSlotBytes={tlvSlotBytes}
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
          onDismiss={() =>
            uiDispatch({ type: "set-popover-anchor", anchor: null })
          }
        />
      ) : null}

      <ImportExportDrawer
        open={drawerMode !== null}
        mode={drawerMode ?? "export"}
        packet={exportPacket}
        buildShareUrl={buildCurrentShareUrl}
        controllers={controllers}
        layout={layout}
        onClose={() => uiDispatch({ type: "close-drawer" })}
        onImport={handleImport}
      />

      {tourOpen ? (
        <OnboardingTour
          steps={tourSteps}
          onClose={() => uiDispatch({ type: "set-tour-open", open: false })}
        />
      ) : null}

      {showSaveDialog ? (
        <SavePresetDialog
          defaultName={studioState.packet.name}
          onCancel={() => uiDispatch({ type: "close-save-dialog" })}
          onSubmit={handleSaveAsPreset}
        />
      ) : null}
    </>
  );
}
PacketViewer.displayName = "PacketViewer";

function persistSharedCustomPreset(
  packet: PsdlPacket,
  stored: Record<string, PsdlPacket>,
): { key: string; presets: Record<string, PsdlPacket> } {
  const normalizedPacket: PsdlPacket = {
    ...packet,
    name: normalizeCustomPresetName(packet.name),
  };
  const desired = `custom:${normalizedPacket.name}`;

  for (const [key, candidate] of Object.entries(stored)) {
    const normalizedStoredPacket: PsdlPacket = {
      ...candidate,
      name: normalizeCustomPresetName(candidate.name),
    };
    if (samePsdlPacket(normalizedStoredPacket, normalizedPacket)) {
      if (!samePsdlPacket(candidate, normalizedStoredPacket)) {
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

/**
 * Stable JSON comparison without the `safe-stable-stringify` dep — equality
 * only needs key-order independence (the studio reducer deep-clones via
 * `structuredClone`, which preserves key insertion order, but PSDL packets
 * from disparate sources may iterate differently). `JSON.stringify`'s
 * second-arg array form sorts keys at every depth in one pass and is enough
 * for our shallow-name PsdlPacket shape.
 */
function stableStringify(value: unknown): string {
  const keys = new Set<string>();
  // First pass: collect every property name reachable from the value so
  // the replacer-array form of JSON.stringify can sort them globally.
  // The replacer's *first* invocation is the root call with key === ""
  // and val === value, which we skip; every subsequent empty-string key
  // is a legitimate object property (e.g. `switch.cases[""]`, which
  // `validateSwitch` doesn't forbid) and must enter the Set, otherwise
  // `samePsdlPacket` would treat two packets that differ only inside an
  // empty-keyed sub-object as identical and `persistSharedCustomPreset`
  // would silently dedupe them away (Codex P2).
  let seenRoot = false;
  JSON.stringify(value, (key, val) => {
    if (!seenRoot) {
      seenRoot = true;
      return val;
    }
    keys.add(key);
    return val;
  });
  return JSON.stringify(value, Array.from(keys).sort());
}

function samePsdlPacket(a: PsdlPacket, b: PsdlPacket): boolean {
  return stableStringify(a) === stableStringify(b);
}
