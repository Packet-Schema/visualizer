// @vitest-environment jsdom
//
// SourcePane (= Custom Packet Studio の source pane) のスモークテスト。
//
// 観点
// - mount → 既定 packet の YAML が textarea に出る、 preview に cell が
//   生える、 textarea に focus が当たる
// - YAML 編集 → debounce 後 dispatch が "replace-packet" を発行
// - 不正な YAML 入力時に alert が表示され dispatch されない
// - format toggle が dispatch を発火しない (dirty=false)
// - format toggle 中の編集 (dirty=true) でも race にならず replace-packet
//   が 1 回だけ走る
// - dispatch reference が変わってもループしない (useRef cache の確認)
// - radiogroup の ArrowRight でフォーカスと format が連動する
// - 空 YAML / 空 JSON で固有のエラー文が出る

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

async function mount(
  packet: PsmlPacket,
  dispatch: (a: EditAction) => void,
  onClose: () => void = () => {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <SourcePane packet={packet} dispatch={dispatch} onClose={onClose} />,
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

function findFormatButton(
  container: HTMLElement,
  label: "yaml" | "json",
): HTMLButtonElement {
  const btn = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button[role="radio"]'),
  ).find((b) => b.textContent?.toLowerCase().includes(label));
  if (!btn) throw new Error(`format button "${label}" not found`);
  return btn;
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
      const jsonBtn = findFormatButton(container, "json");
      await act(async () => {
        jsonBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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

  it("flushes the pending edit exactly once when format toggles mid-debounce", async () => {
    // dirty=true な状態で format toggle すると、 SourcePane は pending
    // 編集を即座に確定 dispatch して text を新 format で再 encode する。
    // 200ms debounce timer が走る前に toggle が起きるシナリオ。
    //
    // 親側で dispatch を受けて packet を update する mini-reducer を作り、
    // 実際の PacketViewer の dispatch チェーンを最小限に模擬する。
    const calls: EditAction[] = [];
    let currentPacket = sample;
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root | null = null;
    const render = async () => {
      await act(async () => {
        if (!root) root = createRoot(container);
        root.render(
          <SourcePane
            packet={currentPacket}
            dispatch={(a) => {
              calls.push(a);
              if (a.type === "replace-packet") {
                currentPacket = a.packet;
                void render();
              }
            }}
            onClose={() => {}}
          />,
        );
      });
    };
    await render();
    await act(async () => {
      await Promise.resolve();
    });

    const textarea =
      container.querySelector<HTMLTextAreaElement>("#psml-source-pane")!;
    const edited =
      'name: "Flushed"\nrowBits: 8\nbody:\n  - { id: x, name: X, type: { kind: bits, n: 8 } }\n';
    await act(async () => {
      nativeSetTextareaValue(textarea, edited);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // debounce が満了する前に format toggle
    const jsonBtn = findFormatButton(container, "json");
    await act(async () => {
      jsonBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settleDebounce();
    // dispatch は format toggle ハンドラ内の 1 回だけ
    const replacePacketCalls = calls.filter((c) => c.type === "replace-packet");
    expect(replacePacketCalls.length).toBe(1);
    expect(
      (replacePacketCalls[0] as Extract<EditAction, { type: "replace-packet" }>)
        .packet.name,
    ).toBe("Flushed");
    // textarea は JSON 形式になっている (親が packet を更新して
    // upstream sync で encode し直された結果も "Flushed" を保持)
    const ta2 =
      container.querySelector<HTMLTextAreaElement>("#psml-source-pane")!;
    expect(ta2.value).toContain('"format": "psml"');
    expect(ta2.value).toContain('"Flushed"');

    await act(async () => {
      root?.unmount();
    });
    container.remove();
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
        root!.render(
          <SourcePane packet={sample} dispatch={handler} onClose={() => {}} />,
        );
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

  it("supports ArrowRight on the radiogroup to move focus and switch format", async () => {
    const dispatch = vi.fn();
    const { container, cleanup } = await mount(sample, dispatch);
    try {
      const yamlBtn = findFormatButton(container, "yaml");
      const jsonBtn = findFormatButton(container, "json");
      yamlBtn.focus();
      await act(async () => {
        yamlBtn.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        );
      });
      await settleDebounce();
      expect(document.activeElement).toBe(jsonBtn);
      const textarea =
        container.querySelector<HTMLTextAreaElement>("#psml-source-pane")!;
      expect(textarea.value).toContain('"format": "psml"');
    } finally {
      await cleanup();
    }
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

  it("Revert button restores the textarea to upstream and skips dispatch", async () => {
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
      const revertBtn = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
      ).find((b) => b.textContent === "Revert");
      expect(revertBtn).toBeDefined();
      expect(revertBtn?.disabled).toBe(false);
      await act(async () => {
        revertBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      // textarea が upstream の YAML に戻り、 dispatch は呼ばれない
      const ta2 =
        container.querySelector<HTMLTextAreaElement>("#psml-source-pane")!;
      expect(ta2.value.startsWith("name:")).toBe(true);
      expect(ta2.value).toContain('"Sample"');
      // debounce の余地を残しても dispatch されないこと
      await settleDebounce();
      expect(dispatch).not.toHaveBeenCalled();
      // 戻った直後の Revert ボタンは disabled (dirty=false)
      const revertAfter = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
      ).find((b) => b.textContent === "Revert");
      expect(revertAfter?.disabled).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("Close button invokes onClose", async () => {
    const dispatch = vi.fn();
    const onClose = vi.fn();
    const { container, cleanup } = await mount(sample, dispatch, onClose);
    try {
      const closeBtn = Array.from(
        container.querySelectorAll<HTMLButtonElement>("button"),
      ).find((b) => b.textContent === "Close");
      expect(closeBtn).toBeDefined();
      await act(async () => {
        closeBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup();
    }
  });

  it("returns a friendly error for an empty JSON object", async () => {
    const dispatch = vi.fn();
    const { container, cleanup } = await mount(sample, dispatch);
    try {
      // JSON モードに切替
      const jsonBtn = findFormatButton(container, "json");
      await act(async () => {
        jsonBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await settleDebounce();
      const textarea =
        container.querySelector<HTMLTextAreaElement>("#psml-source-pane")!;
      await act(async () => {
        nativeSetTextareaValue(textarea, "{}");
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

  it("syncs the textarea from upstream when not dirty (e.g. preset switch / undo)", async () => {
    const dispatch = vi.fn();
    // 親が packet を別物に差し替える状況を mount → 再 render で再現する。
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root | null = null;
    await act(async () => {
      root = createRoot(container);
      root.render(
        <SourcePane packet={sample} dispatch={dispatch} onClose={() => {}} />,
      );
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
      root!.render(
        <SourcePane packet={swapped} dispatch={dispatch} onClose={() => {}} />,
      );
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
