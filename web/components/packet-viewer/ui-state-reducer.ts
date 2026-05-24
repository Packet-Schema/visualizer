// Pure reducer for PacketViewer's UI-shell state.
//
// Pulled out of PacketViewer.tsx so the component itself stays focused on
// data flow (packet / controllers) and rendering. The state here is
// session-scoped UI toggles — drawer open/close, selected cell, hex strip
// visibility, etc. — that don't belong in the studio edit reducer (which
// owns the editable packet plus undo history).
//
// Design rules:
//   - The reducer is pure (no DOM, no localStorage). All side effects
//     (URL sync, localStorage, focus) live in PacketViewer or hooks.ts.
//   - Most actions are single-purpose `set-*` / `toggle-*` so callers can
//     reason about them in isolation.
//   - Multi-field actions are allowed *only* when the touched fields must
//     change atomically to avoid intermediate render states. The current
//     example is `preset-switched`, which clears selection / popover /
//     edit mode together so the next frame can't paint with "old preset's
//     selection on the new preset's body".

import type { DrawerMode } from "@/components/import-export/ImportExportDrawer";
import type { ViewMode } from "@/lib/psml/types";

export type ShareStatus = {
  msg: string;
  kind: "ok" | "error";
};

/**
 * Custom Packet Studio の表示モード。
 *
 * - "form":   既存のフォーム編集 (FieldRow / ContainerRow / ConstraintEditor)
 * - "source": PSML テキスト直編集 (YAML / JSON)
 *
 * 上部のメイン diagram が両方の live preview を兼ねる。 form と source は
 * 同じ studio reducer を経由するので、 切替時に packet の値は保持される
 * (排他で同時に走らせない)。
 */
export type StudioView = "form" | "source";

export type UiState = {
  selectedFieldId: string | null;
  popoverAnchor: DOMRect | null;
  drawerMode: DrawerMode | null;
  tourOpen: boolean;
  /** Visible on wide viewports by default; the user may toggle this. */
  hexStripVisible: boolean;
  /** True once the user has explicitly toggled hex visibility — used to
   *  stop the wide-viewport auto-default from clobbering their pick. */
  hexStripUserSet: boolean;
  dependenciesVisible: boolean;
  viewMode: ViewMode;
  editMode: boolean;
  /** editMode 内のサブモード (form / source) — 排他で 1 つだけ表示。 */
  studioView: StudioView;
  showSaveDialog: boolean;
  shareStatus: ShareStatus | null;
};

export const initialUiState: UiState = {
  selectedFieldId: null,
  popoverAnchor: null,
  drawerMode: null,
  tourOpen: false,
  hexStripVisible: false,
  hexStripUserSet: false,
  dependenciesVisible: false,
  viewMode: "wire",
  editMode: false,
  studioView: "form",
  showSaveDialog: false,
  shareStatus: null,
};

export type UiAction =
  | { type: "select-field"; id: string; anchor: DOMRect | null }
  | { type: "clear-selection" }
  | { type: "set-popover-anchor"; anchor: DOMRect | null }
  | { type: "open-drawer"; mode: DrawerMode }
  | { type: "close-drawer" }
  | { type: "set-tour-open"; open: boolean }
  | { type: "set-hex-strip-visible"; visible: boolean; userInitiated: boolean }
  | { type: "toggle-hex-strip" }
  | { type: "toggle-dependencies" }
  | { type: "toggle-view-mode" }
  | { type: "set-edit-mode"; editing: boolean }
  | { type: "toggle-edit-mode" }
  | { type: "set-studio-view"; view: StudioView }
  | { type: "open-save-dialog" }
  | { type: "close-save-dialog" }
  | { type: "set-share-status"; status: ShareStatus }
  | { type: "clear-share-status" }
  /** Reset transient UI when the active packet swaps. Keeps the
   *  hex-strip-userSet bit so the user's choice survives a preset
   *  switch (matching the pre-refactor behaviour). */
  | { type: "preset-switched" };

export function uiReducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "select-field":
      return {
        ...state,
        selectedFieldId: action.id,
        popoverAnchor: action.anchor,
      };
    case "clear-selection":
      return { ...state, selectedFieldId: null, popoverAnchor: null };
    case "set-popover-anchor":
      return { ...state, popoverAnchor: action.anchor };
    case "open-drawer":
      return { ...state, drawerMode: action.mode };
    case "close-drawer":
      return { ...state, drawerMode: null };
    case "set-tour-open":
      return { ...state, tourOpen: action.open };
    case "set-hex-strip-visible":
      return {
        ...state,
        hexStripVisible: action.visible,
        hexStripUserSet: action.userInitiated ? true : state.hexStripUserSet,
      };
    case "toggle-hex-strip":
      return {
        ...state,
        hexStripVisible: !state.hexStripVisible,
        hexStripUserSet: true,
      };
    case "toggle-dependencies":
      return { ...state, dependenciesVisible: !state.dependenciesVisible };
    case "toggle-view-mode":
      return {
        ...state,
        viewMode: state.viewMode === "semantic" ? "wire" : "semantic",
      };
    case "set-edit-mode":
      // editMode を抜ける時は studioView を form に戻す。 次に再度
      // editMode を ON にした時、 source からじゃなく form から始める
      // (source mode で抜けた事故的中断状態を持ち越さない)。
      return {
        ...state,
        editMode: action.editing,
        studioView: action.editing ? state.studioView : "form",
      };
    case "toggle-edit-mode": {
      const nextEditMode = !state.editMode;
      return {
        ...state,
        editMode: nextEditMode,
        studioView: nextEditMode ? state.studioView : "form",
      };
    }
    case "set-studio-view":
      return { ...state, studioView: action.view };
    case "open-save-dialog":
      return { ...state, showSaveDialog: true };
    case "close-save-dialog":
      return { ...state, showSaveDialog: false };
    case "set-share-status":
      return { ...state, shareStatus: action.status };
    case "clear-share-status":
      return { ...state, shareStatus: null };
    case "preset-switched":
      return {
        ...state,
        selectedFieldId: null,
        popoverAnchor: null,
        editMode: false,
        studioView: "form",
        // hexStripUserSet intentionally preserved so the user's hex
        // visibility choice survives a preset change.
      };
    default: {
      // The `never` binding still gives tsc its exhaustiveness check at
      // compile time (a new UiAction variant fails to assign to never).
      // At runtime we fall back to the previous state instead of
      // returning the raw action — an untyped caller dispatching a
      // malformed object would otherwise corrupt the reducer state by
      // replacing UiState with a free-form action object.
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}
