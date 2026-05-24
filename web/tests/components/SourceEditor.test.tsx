// @vitest-environment jsdom
//
// SourceEditor smoke / behaviour test.
//
// - render → 既定 preset の YAML が textarea に出ること
// - 入力 (typo) でエラー banner が表示されること
// - その間 preview は最後に成功した packet を保ち続けること (規模を bit数
//   で比較)
// - format toggle で YAML → JSON 変換が機能すること

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import SourceEditor from "@/components/source-editor/SourceEditor";

// React は controlled textarea の `value` 直接代入を hook 経由で見ない。
// HTMLInputElement.prototype の setter を借りて、React の change event
// に拾わせる。
function nativeSetTextareaValue(el: HTMLTextAreaElement, v: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(el, v);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function mount(): Promise<{
  container: HTMLDivElement;
  cleanup: () => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<SourceEditor />);
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

// debounce (200ms) を抜けた状態にする。 fakeTimers は React schedule と
// 干渉するので、実時間で短く待つだけにする。
async function settleDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 260));
  });
}

describe("SourceEditor", () => {
  it("renders the default preset's YAML and a diagram preview", async () => {
    const { container, cleanup } = await mount();
    try {
      const textarea =
        container.querySelector<HTMLTextAreaElement>("#psml-source");
      expect(textarea).not.toBeNull();
      expect(textarea?.value.length).toBeGreaterThan(0);
      // 既定 (ipv4) は "name:" を YAML 先頭に持つ。
      expect(textarea?.value.startsWith("name:")).toBe(true);
      const cells = container.querySelectorAll(".field-cell");
      expect(cells.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  it("shows a parse error banner when the YAML becomes invalid", async () => {
    const { container, cleanup } = await mount();
    try {
      const textarea =
        container.querySelector<HTMLTextAreaElement>("#psml-source")!;
      // 値全消し → 空文字は YAML として "null" にパースされるので validate
      // が "must be a top-level object" or similar を投げる。
      // YAML scalar 単独は PsmlPacket としては object でないので reject される。
      await act(async () => {
        nativeSetTextareaValue(textarea, "just a string scalar");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settleDebounce();
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent ?? "").toMatch(/.+/);
    } finally {
      await cleanup();
    }
  });

  it("keeps the previous diagram while text is mid-typing / invalid", async () => {
    const { container, cleanup } = await mount();
    try {
      const cellsBefore = container.querySelectorAll(".field-cell").length;
      expect(cellsBefore).toBeGreaterThan(0);

      const textarea =
        container.querySelector<HTMLTextAreaElement>("#psml-source")!;
      await act(async () => {
        nativeSetTextareaValue(textarea, "{ broken yaml ]]");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settleDebounce();
      // diagram は前回の packet を保持する。
      const cellsAfter = container.querySelectorAll(".field-cell").length;
      expect(cellsAfter).toBe(cellsBefore);
    } finally {
      await cleanup();
    }
  });

  it("toggles to JSON and emits the on-wire format/version markers", async () => {
    const { container, cleanup } = await mount();
    try {
      const jsonBtn = Array.from(
        container.querySelectorAll<HTMLButtonElement>('button[role="radio"]'),
      ).find((b) => b.textContent?.toLowerCase().includes("json"));
      expect(jsonBtn).toBeDefined();
      await act(async () => {
        jsonBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await settleDebounce();
      const textarea =
        container.querySelector<HTMLTextAreaElement>("#psml-source")!;
      expect(textarea.value).toContain('"format": "psml"');
      expect(textarea.value).toContain('"version": "0.4"');
    } finally {
      await cleanup();
    }
  });
});
