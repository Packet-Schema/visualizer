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
//   - Cross-cutting actions are *not* added here. Cases like "preset
//     switch resets selectedFieldId + editMode" are composed in the
//     caller by issuing two dispatches; the reducer keeps single-purpose
//     actions easy to reason about.

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
  showJsonPane: boolean;
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
  showJsonPane: false,
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
  | { type: "toggle-json-pane" }
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
      return { ...state, editMode: action.editing };
    case "toggle-edit-mode":
      return { ...state, editMode: !state.editMode };
    case "toggle-json-pane":
      return { ...state, showJsonPane: !state.showJsonPane };
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
        showJsonPane: false,
        // hexStripUserSet intentionally preserved so the user's hex
        // visibility choice survives a preset change.
      };
  }
}
