"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

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
import { updatePacketField } from "@/lib/psml/packet-update";
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
  SubField,
  TlvInstance,
} from "@/lib/psml/renderer";
import type { Expr, PsmlPacket } from "@/lib/psml/types";
import ControlsPanel from "@/components/controls/ControlsPanel";
import DependencyOverlay from "@/components/diagram/DependencyOverlay";
import DetailPanel from "@/components/field-details/DetailPanel";
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
        // peek.bits は定数 (number) で ref を含まない一方、 peek.offset は
        // Expr なので ref を含み得る (lookahead パターンで、 offset を同
        // packet の長さ field で動かすなど)。 ここを walk しないと該当
        // パケットが MissingRefError で落ちる。
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

type PacketViewerProps = {
  initialPacketKey?: string;
  initialControllers?: ControllerState;
};

export default function PacketViewer({
  initialPacketKey = DEFAULT_PACKET_KEY,
  initialControllers,
}: PacketViewerProps) {
  const [packetKey, setPacketKey] = useState<string>(initialPacketKey);
  // Imported packets are kept in the renderer shape so the editors can mutate
  // their TLV/Chain/subfield state directly. Built-in presets live in PSML
  // and are lowered to the renderer shape on demand.
  const [importedPackets, setImportedPackets] = useState<PacketRegistry>({});
  // The renderer-shape mirror of every built-in PSML preset. Lowered once on
  // mount; TLV/Chain edits replace the relevant packet entry immutably via
  // `updatePacketField` (the format hub re-lifts back to PSML at export time).
  const [renderedPresets, setRenderedPresets] = useState<PacketRegistry>(() => {
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

  const [controllers, setControllers] = useState<ControllerState>(() => {
    const packet = PRESETS[initialPacketKey] ?? PRESETS[DEFAULT_PACKET_KEY];
    return initialControllers ?? initialState(psmlToRenderer(packet));
  });

  // Custom Packet Studio reducer. Seeded from the default preset; we
  // reseed via 'replace-packet' on preset switch so history doesn't span
  // unrelated packets.
  const [studioState, dispatch] = useReducer(
    editReducer,
    PRESETS[initialPacketKey] ?? PRESETS[DEFAULT_PACKET_KEY],
    makeInitialState,
  );
  // UI shell state — visibility toggles, selection, drawer mode, etc.
  // The reducer lives in `ui-state-reducer.ts`; keeping it pure and away
  // from the data flow above makes intent of each transition (e.g.
  // "preset-switched" resets edit + json pane) explicit.
  const [ui, uiDispatch] = useReducer(uiReducer, initialUiState);
  const {
    editMode,
    showJsonPane,
    showSaveDialog,
    selectedFieldId,
    popoverAnchor,
    drawerMode,
    tourOpen,
    hexStripVisible,
    dependenciesVisible,
    viewMode,
    shareStatus,
  } = ui;
  // Export must follow the same source of truth as the live diagram. While the
  // studio is open, layout is derived from in-progress PSML edits rather than
  // the last selected preset/import, so lower that edited packet for consumers
  // that still need renderer metadata such as `name` and `rowBits`.
  const exportPacket = useMemo(
    () => (editMode ? psmlToRenderer(studioState.packet) : packet),
    [editMode, packet, studioState.packet],
  );
  const isWideViewport = useIsWideViewport(POPOVER_MIN_WIDTH);
  const [urlHydrated, setUrlHydrated] = useState(false);

  const diagramRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);

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
    // renderedPresets is intentionally not in the deps — see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Re-seed the studio reducer in-place when the active PSML packet swaps
  // (preset change, custom preset selection, import). Detecting the change
  // during render and dispatching synchronously is the React-recommended
  // alternative to a useEffect — it keeps `studioState.packet` aligned with
  // `activePsmlPacket` on the same render that observed the change, avoiding
  // a flash of stale state.
  // See: https://react.dev/learn/you-might-not-need-an-effect
  const lastReducerPacketRef = useRef(activePsmlPacket);
  if (lastReducerPacketRef.current !== activePsmlPacket) {
    lastReducerPacketRef.current = activePsmlPacket;
    dispatch({ type: "replace-packet", packet: activePsmlPacket });
  }

  useUndoRedoShortcuts({
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
        (customPreset ? psmlToRenderer(customPreset) : null);
      if (next) setControllers(initialState(next));
      // `preset-switched` resets selection, popover anchor, edit mode, and
      // the json pane in one shot. Otherwise `targetPsml` would briefly
      // fall back to `studioState.packet` (still pointing at the previous
      // preset) and the diagram would render mixed cells.
      uiDispatch({ type: "preset-switched" });
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
        // Custom preset edits: keep the source PSML untouched and
        // persist the renderer-shape edit in `renderedPresets` instead.
        //
        // The earlier approach (`setCustomPresets ← rendererToPsml(...)`,
        // even with constraints merged back) bakes the renderer model's
        // lossy collapse of Encrypted / Switch / Optional containers
        // into the source PSML on every TLV / Chain edit (Codex P1).
        // The renderer mirror lookup at the top of this component
        // already falls back to `renderedPresets[packetKey]` ??
        // `customRenderer` (which re-derives from customPresets), so
        // writing the edit to `renderedPresets[packetKey]` lets the UI
        // pick up the change immediately while the canonical PSML
        // stays intact. A preset switch + return re-derives the
        // renderer view from the source; only an explicit
        // "Save as preset" should rebuild the persisted PSML.
        setRenderedPresets((prev) => ({ ...prev, [packetKey]: nextPacket }));
      }
    },
    [packetKey, renderedPresets, importedPackets],
  );

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
      // Drop any stale renderer-mirror cache for this key. The custom-
      // edit path writes renderer packets into `renderedPresets[key]`
      // for session-only persistence; without this evict, saving over
      // an existing `custom:<name>` keeps the old renderer ahead of
      // the freshly persisted PSML in `packet`'s resolution order and
      // the UI shows stale data (Codex P2). The next render will
      // re-derive from `customPresets[key]` → `customRenderer`.
      setRenderedPresets((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setPacketKey(key);
      setControllers(initialState(psmlToRenderer(packetToSave)));
      uiDispatch({ type: "clear-selection" });
      uiDispatch({ type: "close-save-dialog" });
      uiDispatch({ type: "set-edit-mode", editing: false });
    },
    [studioState.packet],
  );

  // Drop in-progress edits and revert the reducer to the active preset.
  const handleDiscardEdits = useCallback(() => {
    dispatch({ type: "replace-packet", packet: activePsmlPacket });
    uiDispatch({ type: "set-edit-mode", editing: false });
    // showJsonPane is part of the same UI shell — keep them in sync by
    // toggling off if it was open.
    if (showJsonPane) uiDispatch({ type: "toggle-json-pane" });
  }, [activePsmlPacket, showJsonPane]);

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
    const builtInPsml = PRESETS[packetKey];
    const customSource = builtInPsml ? undefined : customPresets[packetKey];
    // Custom preset edits live in `renderedPresets` (see
    // `replaceActivePacket` custom arm) and the source PSML in
    // `customPresets[packetKey]` stays untouched. Decide which one to
    // share based on whether the user has actually edited:
    //
    //  - editMode → always share the studio state (the user's draft).
    //  - built-in → share the built-in PSML (preset key + controllers
    //    are enough, but emitting the PSML preserves any constraints
    //    we want the recipient to see).
    //  - custom + no renderer override → share the source PSML so its
    //    `constraints` / Encrypted / Switch / Optional containers
    //    survive (rendererToPsml would strip them — Codex P1).
    //  - custom + renderer override → lift the renderer packet back to
    //    PSML so the recipient sees the TLV / Chain edits actually
    //    visible on screen (lossy for non-renderer constructs but
    //    necessary; matching screen-state is the priority once the
    //    user has touched the editor).
    //  - imported → no source PSML available, lift from renderer.
    const hasCustomRendererOverride =
      !builtInPsml && renderedPresets[packetKey] !== undefined;
    const sharePacket = editMode
      ? studioState.packet
      : builtInPsml
        ? builtInPsml
        : hasCustomRendererOverride
          ? rendererToPsml(packet)
          : (customSource ?? rendererToPsml(packet));
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
    renderedPresets,
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

  useAutoClearStatus(shareStatus, 2400, () =>
    uiDispatch({ type: "clear-share-status" }),
  );

  const handleShare = useCallback(async () => {
    try {
      const url = buildCurrentShareUrl();
      const bytes = shareUrlByteLength(url);
      if (bytes > SHARE_URL_WARN_BYTES) {
        console.warn(
          `Packet View share URL is ${bytes} bytes, exceeding ${SHARE_URL_WARN_BYTES}; copied anyway.`,
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
      uiDispatch({
        type: "set-share-status",
        status: { msg: "Share URL copied.", kind: "ok" },
      });
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

  // NOTE: an earlier revision wrapped `controllers` in `useDeferredValue` to
  // smooth slider drags. That breaks preset switches: when `packetKey`
  // changes, `controllers` is replaced with the new preset's defaults
  // synchronously, but a deferred copy keeps the *previous* preset's keys
  // alive for one or more frames — so e.g. switching from IPv4 to IPv6
  // leaves a stale `ihl` in the env, and the IPv6 diagram is laid out as
  // if IHL were still active. We need `packet`-and-`controllers` to stay
  // in lockstep, so the synchronous value is the only safe choice.
  // The PSML packet feeding `resolveLayout` — depends only on the active
  // entry, never on the whole `customPresets` map. Pulling this out lets
  // `psmlRefs` (an AST walk) re-run only when the body actually changes,
  // not every time another preset is edited.
  const targetPsml: PsmlPacket = useMemo(
    () =>
      editMode
        ? studioState.packet
        : (PRESETS[packetKey] ??
          customPresets[packetKey] ??
          rendererToPsml(packet)),
    [editMode, studioState.packet, packetKey, customPresets, packet],
  );

  // Set of ref-names that the active packet expects in `env`. Cached against
  // `targetPsml` so slider drag (which mutates `controllers` every frame but
  // leaves the body untouched) does not re-walk the AST 60×/sec.
  const psmlRefs = useMemo(() => collectPsmlRefs(targetPsml), [targetPsml]);

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
    for (const r of psmlRefs) {
      if (!env.has(r)) env.set(r, 0);
    }
    return resolveLayout(targetPsml, { env, viewMode });
  }, [targetPsml, psmlRefs, controllers, viewMode]);

  const categories = useMemo(() => packetCategories(packet), [packet]);

  const bytes = layout.totalBits / 8;
  const byteStr = Number.isInteger(bytes)
    ? `${bytes} bytes`
    : `${layout.totalBits} bits`;

  // Roving tabindex keyboard navigation on the diagram. The hook owns the
  // imperative DOM operations (`setAttribute("tabindex", …)` + focus()) so
  // PacketViewer stays declarative.
  const handleDiagramKeyDown = useRovingTabindex(diagramRef);

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
            onToggleDependencies: () =>
              uiDispatch({ type: "toggle-dependencies" }),
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
            {packet.description}
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
            onToggleJsonPane={() => uiDispatch({ type: "toggle-json-pane" })}
            onSaveAs={() => uiDispatch({ type: "open-save-dialog" })}
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
            <h2 className="text-xs m-0 mb-3 uppercase tracking-wider font-bold text-fg-muted">
              Controls
            </h2>
            <div ref={controlsRef}>
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
            <h2 className="text-xs m-0 mb-3 uppercase tracking-wider font-bold text-fg-muted">
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
          onDismiss={() =>
            uiDispatch({ type: "set-popover-anchor", anchor: null })
          }
        />
      ) : null}

      <ImportExportDrawer
        open={drawerMode !== null}
        mode={drawerMode ?? "export"}
        packet={exportPacket}
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

/**
 * Stable JSON comparison without the `safe-stable-stringify` dep — equality
 * only needs key-order independence (the studio reducer deep-clones via
 * `structuredClone`, which preserves key insertion order, but PSML packets
 * from disparate sources may iterate differently). `JSON.stringify`'s
 * second-arg array form sorts keys at every depth in one pass and is enough
 * for our shallow-name PsmlPacket shape.
 */
function stableStringify(value: unknown): string {
  const keys = new Set<string>();
  // First pass: collect every property name reachable from the value so
  // the replacer-array form of JSON.stringify can sort them globally.
  // The replacer's *first* invocation is the root call with key === ""
  // and val === value, which we skip; every subsequent empty-string key
  // is a legitimate object property (e.g. `switch.cases[""]`, which
  // `validateSwitch` doesn't forbid) and must enter the Set, otherwise
  // `samePsmlPacket` would treat two packets that differ only inside an
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

function samePsmlPacket(a: PsmlPacket, b: PsmlPacket): boolean {
  return stableStringify(a) === stableStringify(b);
}
