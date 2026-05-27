// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import EmbedViewer from "@/components/embed/EmbedViewer";
import { THEME_STORAGE_KEY } from "@/lib/constants";
import { EMBED_SIZE_MESSAGE_TYPE } from "@/lib/embed-url";
import { encodePsdlParam } from "@/lib/share-url";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const originalParentDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "parent",
);
const originalResizeObserverDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "ResizeObserver",
);
const originalMatchMediaDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "matchMedia",
);
const originalRequestAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "requestAnimationFrame",
);
const originalCancelAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "cancelAnimationFrame",
);

beforeEach(() => {
  window.history.replaceState(null, "", "/embed");
  document.documentElement.removeAttribute("data-theme");
  localStorage.removeItem(THEME_STORAGE_KEY);
  mockMatchMedia(false);
  mockResizeObserver();
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value: vi.fn(),
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width: 640,
    height: 180,
    top: 0,
    right: 640,
    bottom: 180,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreWindowProperty("parent", originalParentDescriptor);
  restoreWindowProperty("ResizeObserver", originalResizeObserverDescriptor);
  restoreWindowProperty("matchMedia", originalMatchMediaDescriptor);
  restoreWindowProperty(
    "requestAnimationFrame",
    originalRequestAnimationFrameDescriptor,
  );
  restoreWindowProperty(
    "cancelAnimationFrame",
    originalCancelAnimationFrameDescriptor,
  );
  document.documentElement.removeAttribute("data-theme");
});

describe("EmbedViewer", () => {
  it("renders a shared built-in preset without the full app chrome", async () => {
    const { container, cleanup } = await mountEmbedViewer(
      "/embed?preset=tcp&controllers.dataOffset=10",
    );
    try {
      expect(container.querySelector(".hybrid-diagram")).not.toBeNull();
      expect(
        container.querySelector('[data-field-id="srcPort"]'),
      ).not.toBeNull();
      expect(container.querySelector("select")).toBeNull();
      expect(container.querySelector("#ctrl-dataOffset-number")).toBeNull();
      expect(container.querySelector("header")).toBeNull();
      expect(container.textContent).not.toContain("Field detail");
    } finally {
      await cleanup();
    }
  });

  it("applies URL state before the first size observer pass", async () => {
    const observedLabels: string[] = [];
    mockResizeObserver((target) => {
      observedLabels.push(target.getAttribute("aria-label") ?? "");
    });

    const { cleanup } = await mountEmbedViewer("/embed?preset=tcp");
    try {
      expect(observedLabels[0]).toBe("TCP Header embed");
    } finally {
      await cleanup();
    }
  });

  it("renders an encoded PSDL payload", async () => {
    const shared = mkPacket("Embedded Packet", "embedded-field");
    const { container, cleanup } = await mountEmbedViewer(
      `/embed?psdl=${encodePsdlParam(shared, {})}`,
    );
    try {
      expect(
        container.querySelector('[data-field-id="embedded-field"]'),
      ).not.toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("shows a compact error for an invalid shared payload", async () => {
    const { container, cleanup } = await mountEmbedViewer("/embed?psdl=bad");
    try {
      expect(container.querySelector('[role="alert"]')?.textContent).toMatch(
        /Invalid shared link/,
      );
      expect(container.querySelector(".hybrid-diagram")).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("applies an explicit embed theme", async () => {
    const { cleanup } = await mountEmbedViewer("/embed?theme=dark");
    try {
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    } finally {
      await cleanup();
    }
  });

  it("treats an invalid embed theme as system", async () => {
    mockMatchMedia(true);
    const { cleanup } = await mountEmbedViewer("/embed?theme=nope");
    try {
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    } finally {
      await cleanup();
    }
  });

  it("uses the stored default theme when theme is missing", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    const { cleanup } = await mountEmbedViewer("/embed?preset=ipv4");
    try {
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    } finally {
      await cleanup();
    }
  });

  it("falls back to the system theme when theme and storage are missing", async () => {
    mockMatchMedia(true);
    const { cleanup } = await mountEmbedViewer("/embed?preset=ipv4");
    try {
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    } finally {
      await cleanup();
    }
  });

  it("ignores the stored theme when system is explicitly requested", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    mockMatchMedia(true);
    const { cleanup } = await mountEmbedViewer("/embed?theme=system");
    try {
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    } finally {
      await cleanup();
    }
  });

  it("posts its rendered size to the parent frame", async () => {
    const postMessage = vi.fn();
    setParentWindow({ postMessage });

    const { cleanup } = await mountEmbedViewer("/embed?preset=ipv4");
    try {
      expect(postMessage).toHaveBeenCalledWith(
        {
          type: EMBED_SIZE_MESSAGE_TYPE,
          height: 180,
          width: 640,
        },
        "*",
      );
    } finally {
      await cleanup();
    }
  });
});

async function mountEmbedViewer(path: string): Promise<{
  container: HTMLDivElement;
  cleanup: () => Promise<void>;
}> {
  window.history.replaceState(null, "", path);
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<EmbedViewer />);
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

function mkPacket(name: string, fieldId: string): PsdlPacket {
  return {
    name,
    rowBits: 8,
    body: [{ id: fieldId, name: "Embedded", type: { kind: "bits", n: 8 } }],
  };
}

function mockMatchMedia(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function mockResizeObserver(onObserve?: (target: Element) => void): void {
  class TestResizeObserver implements ResizeObserver {
    private callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    observe(target: Element, _options?: ResizeObserverOptions): void {
      void _options;
      onObserve?.(target);
      this.callback(
        [
          {
            target,
            contentRect: {
              x: 0,
              y: 0,
              width: 640,
              height: 180,
              top: 0,
              right: 640,
              bottom: 180,
              left: 0,
              toJSON: () => ({}),
            } as DOMRectReadOnly,
            borderBoxSize: [],
            contentBoxSize: [],
            devicePixelContentBoxSize: [],
          },
        ],
        this,
      );
    }

    unobserve(_target: Element): void {
      void _target;
    }

    disconnect(): void {}
  }

  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });
}

function setParentWindow(parent: Pick<Window, "postMessage">): void {
  Object.defineProperty(window, "parent", {
    configurable: true,
    value: parent,
  });
}

function restoreWindowProperty(
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(window, key, descriptor);
    return;
  }
  Reflect.deleteProperty(window, key);
}
