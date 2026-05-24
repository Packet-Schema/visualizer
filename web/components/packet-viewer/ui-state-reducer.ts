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
//     edit mode / source pane together so the next frame can't paint with
//     "old preset's selection on the new preset's body".

import type { DrawerMode } from "@/components/import-export/ImportExportDrawer";
import type { ViewMode } from "@/lib/psml/types";

export type ShareStatus = {
  msg: string;
  kind: "ok" | "error";
};

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
  showSourcePane: boolean;
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
  showSourcePane: false,
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
  | { type: "toggle-source-pane" }
  /** 明示的に source pane を閉じる (toggle と違い必ず false)。
   *  import / save-as / delete のように lifecycle 上 packet が swap して
   *  未保存編集が孤立する場面で使う。 */
  | { type: "close-source-pane" }
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
      // editMode と showSourcePane は同時 ON で edit race が起きるため
      // 排他にする (Round 2 P0)。 editMode を ON にする時は source pane
      // を閉じ、 OFF にする時は触らない (個別 close-source-pane に任せる)。
      return {
        ...state,
        editMode: action.editing,
        showSourcePane: action.editing ? false : state.showSourcePane,
      };
    case "toggle-edit-mode": {
      const nextEditMode = !state.editMode;
      return {
        ...state,
        editMode: nextEditMode,
        // ON にする時のみ source pane を閉じる。 OFF にした瞬間に source
        // pane を勝手に開かない。
        showSourcePane: nextEditMode ? false : state.showSourcePane,
      };
    }
    case "toggle-source-pane": {
      const nextSource = !state.showSourcePane;
      return {
        ...state,
        showSourcePane: nextSource,
        // source pane を ON にする時は editMode を閉じる (排他)。
        editMode: nextSource ? false : state.editMode,
      };
    }
    case "close-source-pane":
      return { ...state, showSourcePane: false };
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
        showSourcePane: false,
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
