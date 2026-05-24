// @vitest-environment jsdom
//
// SourcePane (= Custom Packet Studio の source view) のスモークテスト。
//
// 観点
// - mount → 既定 packet の YAML が textarea に出る、 textarea に focus が
//   当たる、 内部に diagram preview は描かない
// - YAML 編集 → debounce 後 dispatch が "replace-packet" を発行
// - 不正な YAML 入力時に alert が表示され dispatch されない
// - 親 dispatch reference が変わっても debounce が壊れない (useRef cache)
// - 空 YAML で固有のエラー文が出る
// - Discard ボタンで未保存編集を捨てて upstream に戻す
// - upstream packet 変化 (preset 切替 / undo / form 編集) で dirty=false
//   なら textarea が自動同期する

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// jsdom は CodeMirror の DOM API (selection range など) を一部欠くので、
// SourcePane の動作テストでは内部の SourceCodeMirror を「素の textarea」
// に差し替える。 lint / 構文ハイライトの挙動自体は library 側に任せて、
// ここでは SourcePane の dispatch / dirty 管理 / Discard / sync を verify。
vi.mock("@/components/source-editor/SourceCodeMirror", () => ({
  default: ({
    id,
    value,
    onChange,
    ariaLabel,
  }: {
    id: string;
    value: string;
    onChange: (v: string) => void;
    ariaLabel: string;
  }) => (
    <textarea
      id={id}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      autoFocus
    />
  ),
}));

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
  it("renders the upstream packet as YAML by default and focuses the textarea", async () => {
    const dispatch = vi.fn();
    const { container, cleanup } = await mount(sample, dispatch);
    try {
      const textarea =
        container.querySelector<HTMLTextAreaElement>("#psml-source-pane");
      expect(textarea).not.toBeNull();
      expect(textarea?.value.startsWith("name:")).toBe(true);
      expect(document.activeElement).toBe(textarea);
      // SourcePane 内には preview diagram は描かない (上部の本物 diagram
      // が live preview を兼ねる設計)。 textarea だけ並んでいることを確認。
      const cells = container.querySelectorAll(".field-cell");
      expect(cells.length).toBe(0);
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

  it("uses the latest dispatch ref even if the parent passes a new function each render", async () => {
    // 親が dispatch を毎 render 違う reference で渡してきても、 debounce
    // が再 attach されて pending edit が消えるなどの事故が起きないこと。
    let calls = 0;
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root | null = null;
    const renderWith = async (handler: (a: EditAction) => void) => {
      await act(async () => {
        if (!root) {
          root = createRoot(container);
        }
        root!.render(<SourcePane packet={sample} dispatch={handler} />);
      });
      await act(async () => {
        await Promise.resolve();
      });
    };
    const make = () => (a: EditAction) => {
      if (a.type === "replace-packet") calls += 1;
    };
    await renderWith(make());
    const textarea =
      container.querySelector<HTMLTextAreaElement>("#psml-source-pane")!;
    await act(async () => {
      nativeSetTextareaValue(
        textarea,
        'name: "Stable"\nrowBits: 8\nbody:\n  - { id: x, name: X, type: { kind: bits, n: 8 } }\n',
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // 編集途中に親が re-render して dispatch reference を変えても、
    // debounce は再 attach されない (useRef cache のおかげ)。
    await renderWith(make());
    await settleDebounce();
    expect(calls).toBe(1);
    await act(async () => {
      root?.unmount();
    });
    container.remove();
  });

  it("surfaces a friendly error for empty YAML source", async () => {
    const dispatch = vi.fn();
    const { container, cleanup } = await mount(sample, dispatch);
    try {
      const textarea =
        container.querySelector<HTMLTextAreaElement>("#psml-source-pane")!;
      await act(async () => {
        nativeSetTextareaValue(textarea, "");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settleDebounce();
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent ?? "").toMatch(/empty/i);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("Discard button restores the textarea to upstream and skips dispatch", async () => {
    const dispatch = vi.fn();
    const { container, cleanup } = await mount(sample, dispatch);
    try {
      const textarea =
        container.querySelector<HTMLTextAreaElement>("#psml-source-pane")!;
      // dirty にする
      await act(async () => {
        nativeSetTextareaValue(textarea, "name: dirty\nrowBits: 8\nbody: []\n");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const discardBtn = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
      ).find((b) => b.textContent === "Discard");
      expect(discardBtn).toBeDefined();
      expect(discardBtn?.disabled).toBe(false);
      await act(async () => {
        discardBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      // textarea が upstream の YAML に戻り、 dispatch は呼ばれない
      const ta2 =
        container.querySelector<HTMLTextAreaElement>("#psml-source-pane")!;
      expect(ta2.value.startsWith("name:")).toBe(true);
      expect(ta2.value).toContain('"Sample"');
      // debounce の余地を残しても dispatch されないこと
      await settleDebounce();
      expect(dispatch).not.toHaveBeenCalled();
      // 戻った直後の Discard ボタンは disabled (dirty=false)
      const discardAfter = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
      ).find((b) => b.textContent === "Discard");
      expect(discardAfter?.disabled).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("syncs the textarea from upstream when not dirty (e.g. preset switch / undo)", async () => {
    const dispatch = vi.fn();
    // 親が packet を別物に差し替える状況を mount → 再 render で再現する。
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root | null = null;
    await act(async () => {
      root = createRoot(container);
      root.render(<SourcePane packet={sample} dispatch={dispatch} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    const swapped: PsmlPacket = {
      name: "Swapped",
      rowBits: 16,
      body: [{ id: "y", name: "Y", type: { kind: "bits", n: 16 } }],
    };
    await act(async () => {
      root!.render(<SourcePane packet={swapped} dispatch={dispatch} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    const textarea =
      container.querySelector<HTMLTextAreaElement>("#psml-source-pane")!;
    expect(textarea.value).toContain('"Swapped"');
    expect(textarea.value).toContain("rowBits: 16");
    await act(async () => {
      root?.unmount();
    });
    container.remove();
  });
});
