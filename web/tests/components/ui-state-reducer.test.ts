import { describe, expect, it } from "vitest";

import {
  initialUiState,
  uiReducer,
  type UiState,
} from "@/components/packet-viewer/ui-state-reducer";

const seed: UiState = initialUiState;

describe("uiReducer", () => {
  it("select-field stores the id and anchor together", () => {
    const anchor = { left: 1, top: 2 } as unknown as DOMRect;
    const next = uiReducer(seed, { type: "select-field", id: "ihl", anchor });
    expect(next.selectedFieldId).toBe("ihl");
    expect(next.popoverAnchor).toBe(anchor);
  });

  it("clear-selection drops both fields without touching the rest", () => {
    const anchor = { left: 1 } as unknown as DOMRect;
    const withSel = uiReducer(seed, {
      type: "select-field",
      id: "x",
      anchor,
    });
    const cleared = uiReducer(withSel, { type: "clear-selection" });
    expect(cleared.selectedFieldId).toBeNull();
    expect(cleared.popoverAnchor).toBeNull();
    expect(cleared.editMode).toBe(seed.editMode);
  });

  it("toggle-hex-strip flips visibility and marks the choice as user-initiated", () => {
    const after = uiReducer(seed, { type: "toggle-hex-strip" });
    expect(after.hexStripVisible).toBe(true);
    expect(after.hexStripUserSet).toBe(true);
  });

  it("set-hex-strip-visible respects userInitiated for hexStripUserSet", () => {
    const auto = uiReducer(seed, {
      type: "set-hex-strip-visible",
      visible: true,
      userInitiated: false,
    });
    expect(auto.hexStripVisible).toBe(true);
    expect(auto.hexStripUserSet).toBe(false);
    const manual = uiReducer(auto, {
      type: "set-hex-strip-visible",
      visible: false,
      userInitiated: true,
    });
    expect(manual.hexStripVisible).toBe(false);
    expect(manual.hexStripUserSet).toBe(true);
  });

  it("toggle-view-mode flips wire <-> semantic", () => {
    const semantic = uiReducer(seed, { type: "toggle-view-mode" });
    expect(semantic.viewMode).toBe("semantic");
    const wire = uiReducer(semantic, { type: "toggle-view-mode" });
    expect(wire.viewMode).toBe("wire");
  });

  it("open-drawer / close-drawer juggles the DrawerMode null toggle", () => {
    const opened = uiReducer(seed, { type: "open-drawer", mode: "import" });
    expect(opened.drawerMode).toBe("import");
    const closed = uiReducer(opened, { type: "close-drawer" });
    expect(closed.drawerMode).toBeNull();
  });

  it("preset-switched resets transient UI but preserves hexStripUserSet", () => {
    const dirty: UiState = {
      ...seed,
      selectedFieldId: "x",
      popoverAnchor: { left: 1 } as unknown as DOMRect,
      editMode: true,
      showJsonPane: true,
      hexStripUserSet: true,
      hexStripVisible: true,
      drawerMode: "export",
      showSaveDialog: true,
      showExportImageDialog: true,
    };
    const next = uiReducer(dirty, { type: "preset-switched" });
    expect(next.selectedFieldId).toBeNull();
    expect(next.popoverAnchor).toBeNull();
    expect(next.editMode).toBe(false);
    expect(next.showJsonPane).toBe(false);
    expect(next.hexStripUserSet).toBe(true);
    expect(next.hexStripVisible).toBe(true);
    // Modal-class surfaces are reset so they don't keep pointing at the
    // previous preset after the swap.
    expect(next.drawerMode).toBeNull();
    expect(next.showSaveDialog).toBe(false);
    expect(next.showExportImageDialog).toBe(false);
  });

  it("open-drawer closes any open image-export dialog", () => {
    const withDialog: UiState = { ...seed, showExportImageDialog: true };
    const next = uiReducer(withDialog, {
      type: "open-drawer",
      mode: "export",
    });
    expect(next.drawerMode).toBe("export");
    expect(next.showExportImageDialog).toBe(false);
  });

  it("open-export-image-dialog closes any open drawer", () => {
    const withDrawer: UiState = { ...seed, drawerMode: "import" };
    const next = uiReducer(withDrawer, {
      type: "open-export-image-dialog",
    });
    expect(next.showExportImageDialog).toBe(true);
    expect(next.drawerMode).toBeNull();
  });

  it("close-export-image-dialog only flips its own flag", () => {
    const opened = uiReducer(seed, { type: "open-export-image-dialog" });
    const closed = uiReducer(opened, { type: "close-export-image-dialog" });
    expect(closed.showExportImageDialog).toBe(false);
    expect(closed.drawerMode).toBeNull();
  });

  it("set-share-status / clear-share-status drive the share toast", () => {
    const set = uiReducer(seed, {
      type: "set-share-status",
      status: { msg: "ok", kind: "ok" },
    });
    expect(set.shareStatus).toEqual({ msg: "ok", kind: "ok" });
    const cleared = uiReducer(set, { type: "clear-share-status" });
    expect(cleared.shareStatus).toBeNull();
  });
});
