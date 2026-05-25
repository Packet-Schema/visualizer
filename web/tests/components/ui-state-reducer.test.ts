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
      studioView: "source",
      hexStripUserSet: true,
      hexStripVisible: true,
      drawerMode: "export",
      showSaveDialog: true,
    };
    const next = uiReducer(dirty, { type: "preset-switched" });
    expect(next.selectedFieldId).toBeNull();
    expect(next.popoverAnchor).toBeNull();
    expect(next.editMode).toBe(false);
    expect(next.studioView).toBe("form");
    expect(next.hexStripUserSet).toBe(true);
    expect(next.hexStripVisible).toBe(true);
    // Modal-class surfaces are reset so they don't keep pointing at the
    // previous preset after the swap.
    expect(next.drawerMode).toBeNull();
    expect(next.showSaveDialog).toBe(false);
  });

  it("set-studio-view switches between form and source", () => {
    const toSource = uiReducer(seed, {
      type: "set-studio-view",
      view: "source",
    });
    expect(toSource.studioView).toBe("source");
    const back = uiReducer(toSource, {
      type: "set-studio-view",
      view: "form",
    });
    expect(back.studioView).toBe("form");
  });

  it("set-edit-mode false resets studioView back to form", () => {
    const inSource: UiState = { ...seed, editMode: true, studioView: "source" };
    const exited = uiReducer(inSource, {
      type: "set-edit-mode",
      editing: false,
    });
    expect(exited.editMode).toBe(false);
    expect(exited.studioView).toBe("form");
  });

  it("toggle-edit-mode preserves studioView while editing, resets on exit", () => {
    const inSourceEditing: UiState = {
      ...seed,
      editMode: true,
      studioView: "source",
    };
    const exited = uiReducer(inSourceEditing, { type: "toggle-edit-mode" });
    expect(exited.editMode).toBe(false);
    expect(exited.studioView).toBe("form");

    const reEntered = uiReducer(exited, { type: "toggle-edit-mode" });
    expect(reEntered.editMode).toBe(true);
    // 再 entry 時は form から始まる
    expect(reEntered.studioView).toBe("form");
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
