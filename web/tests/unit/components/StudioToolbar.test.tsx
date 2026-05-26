// @vitest-environment jsdom
//
// Custom Packet Studio の Toolbar が view モードによって form-only ボタンを
// 切り替えることを検証する。 source view では +Field / +Struct / +Group /
// +Repeat / +Switch / +Encrypted を全部隠して、 共通の Undo/Redo/Save/
// Discard と View toggle だけ残る、 というのが期待挙動。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import Toolbar from "@/components/custom-packet-studio/Toolbar";
import type { EditAction } from "@/lib/psml/edit-reducer";
import type { StudioView } from "@/components/packet-viewer/ui-state-reducer";

const noopDispatch: (a: EditAction) => void = () => {};
const noop = () => {};

async function mount(view: StudioView) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <Toolbar
        dispatch={noopDispatch}
        insertPath={[0]}
        historyLength={0}
        futureLength={0}
        view={view}
        onViewChange={noop}
        onSaveAs={noop}
        onDiscard={noop}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

const FORM_ONLY_LABELS = [
  "+ Field",
  "+ Struct",
  "+ Group",
  "+ Repeat",
  "+ Switch",
  "+ Encrypted",
];

function buttonByText(container: HTMLElement, label: string) {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent === label);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Custom Packet Studio Toolbar", () => {
  it("renders form-only buttons in form view", async () => {
    const { container, cleanup } = await mount("form");
    try {
      for (const label of FORM_ONLY_LABELS) {
        expect(buttonByText(container, label), label).toBeDefined();
      }
      // 共通も健在
      expect(buttonByText(container, "Undo")).toBeDefined();
      expect(buttonByText(container, "Save as my preset")).toBeDefined();
      expect(buttonByText(container, "Discard")).toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it("hides form-only buttons in source view", async () => {
    const { container, cleanup } = await mount("source");
    try {
      for (const label of FORM_ONLY_LABELS) {
        expect(buttonByText(container, label), label).toBeUndefined();
      }
      // 共通は表示されたまま
      expect(buttonByText(container, "Undo")).toBeDefined();
      expect(buttonByText(container, "Redo")).toBeDefined();
      expect(buttonByText(container, "Save as my preset")).toBeDefined();
      expect(buttonByText(container, "Discard")).toBeDefined();
      // view toggle は両方の選択肢が出ている
      expect(buttonByText(container, "GUI")).toBeDefined();
      expect(buttonByText(container, "Source")).toBeDefined();
    } finally {
      await cleanup();
    }
  });
});
