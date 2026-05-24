// @vitest-environment jsdom
//
// SourcePane (= Custom Packet Studio の source pane) のスモークテスト。
//
// - render → 既定 packet の YAML が textarea に出ること
// - YAML→JSON format toggle が動くこと
// - YAML を編集 → debounce 後 dispatch が "replace-packet" を発行すること
// - 不正な YAML 入力時に alert が表示され、 dispatch が呼ばれないこと

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import SourcePane from "@/components/custom-packet-studio/SourcePane";
import type { EditAction } from "@/lib/psml/edit-reducer";
import type { PsmlPacket } from "@/lib/psml/types";

const sample: PsmlPacket = {
  name: "Sample",
  rowBits: 8,
  body: [{ id: "x", name: "X", type: { kind: "bits", n: 8 } }],
};

function nativeSetTextareaValue(el: HTMLTextAreaElement, v: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(el, v);
}

async function settleDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 260));
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function mount(packet: PsmlPacket, dispatch: (a: EditAction) => void) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<SourcePane packet={packet} dispatch={dispatch} />);
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

describe("SourcePane", () => {
  it("renders the upstream packet as YAML by default", async () => {
    const dispatch = vi.fn();
    const { container, cleanup } = await mount(sample, dispatch);
    try {
      const textarea =
        container.querySelector<HTMLTextAreaElement>("#psml-source-pane");
      expect(textarea).not.toBeNull();
      expect(textarea?.value.startsWith("name:")).toBe(true);
      // diagram preview にも cell が出る
      const cells = container.querySelectorAll(".field-cell");
      expect(cells.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  it("toggles to JSON without dispatching replace-packet", async () => {
    const dispatch = vi.fn();
    const { container, cleanup } = await mount(sample, dispatch);
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
        container.querySelector<HTMLTextAreaElement>("#psml-source-pane")!;
      expect(textarea.value).toContain('"format": "psml"');
      // format toggle 単体では reducer 側を汚さない
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("dispatches replace-packet after a successful YAML edit", async () => {
    const dispatch = vi.fn();
    const { container, cleanup } = await mount(sample, dispatch);
    try {
      const textarea =
        container.querySelector<HTMLTextAreaElement>("#psml-source-pane")!;
      const next =
        'name: "Renamed"\nrowBits: 8\nbody:\n  - { id: x, name: X, type: { kind: bits, n: 8 } }\n';
      await act(async () => {
        nativeSetTextareaValue(textarea, next);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settleDebounce();
      expect(dispatch).toHaveBeenCalled();
      const call = dispatch.mock.calls.at(-1)?.[0] as EditAction;
      expect(call.type).toBe("replace-packet");
      expect(
        (call as Extract<EditAction, { type: "replace-packet" }>).packet.name,
      ).toBe("Renamed");
    } finally {
      await cleanup();
    }
  });

  it("shows a parse-error banner for invalid input and skips dispatch", async () => {
    const dispatch = vi.fn();
    const { container, cleanup } = await mount(sample, dispatch);
    try {
      const textarea =
        container.querySelector<HTMLTextAreaElement>("#psml-source-pane")!;
      await act(async () => {
        nativeSetTextareaValue(textarea, "{ broken yaml ]]");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settleDebounce();
      const alert = container.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });
});
