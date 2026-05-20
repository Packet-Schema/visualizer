// @vitest-environment jsdom
//
// Unit tests for the PacketViewer hook bundle. We keep these separate from
// the smoke test because they exercise the imperative DOM-touching surface
// (useFieldHighlight, useRovingTabindex) directly rather than going through
// the full app shell.

import { describe, expect, it, beforeEach } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  useAutoClearStatus,
  useFieldHighlight,
  useRovingTabindex,
} from "@/components/packet-viewer/hooks";

let containers: HTMLDivElement[] = [];

/**
 * Build the small subset of `React.KeyboardEvent` that `useRovingTabindex`
 * touches. Centralising the cast keeps the test bodies free of `as unknown`
 * noise while still failing loudly if the hook starts depending on other
 * SyntheticEvent fields.
 */
function mkKeyEvent(
  key: string,
  target: HTMLElement,
): React.KeyboardEvent<HTMLDivElement> {
  const preventDefault = () => {};
  return {
    key,
    target,
    preventDefault,
  } as Pick<
    React.KeyboardEvent<HTMLDivElement>,
    "key" | "target" | "preventDefault"
  > as React.KeyboardEvent<HTMLDivElement>;
}

function mount(node: React.ReactNode): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

beforeEach(() => {
  for (const c of containers) c.remove();
  containers = [];
});

describe("useFieldHighlight", () => {
  function HighlightHarness({ fieldId }: { fieldId: string | null }) {
    const ref = { current: rootElRef };
    const highlight = useFieldHighlight(ref);
    // Re-run on every render so the effect of `fieldId` is observable.
    highlight(fieldId);
    return null;
  }

  // Persistent DOM node we hand to the hook via ref.current.
  let rootElRef: HTMLDivElement | null = null;

  it("paints hex-match on cells matching the field id", () => {
    rootElRef = document.createElement("div");
    rootElRef.innerHTML = `
      <div class="field-cell" data-field-id="srcAddr"></div>
      <div class="field-cell" data-field-id="dstAddr"></div>
    `;
    document.body.appendChild(rootElRef);

    mount(<HighlightHarness fieldId="srcAddr" />);

    expect(rootElRef.getAttribute("data-highlighted-field")).toBe("srcAddr");
    const matched = rootElRef.querySelectorAll(".hex-match");
    expect(matched.length).toBe(1);
    expect(matched[0].getAttribute("data-field-id")).toBe("srcAddr");
    rootElRef.remove();
  });

  it("highlights the parent cell for subfield ids (`parent:sub`)", () => {
    rootElRef = document.createElement("div");
    rootElRef.innerHTML = `
      <div class="field-cell" data-field-id="flagsBits"></div>
      <div class="subfield-cell" data-field-id="flagsBits:df"></div>
    `;
    document.body.appendChild(rootElRef);

    mount(<HighlightHarness fieldId="flagsBits:df" />);

    const matched = rootElRef.querySelectorAll(".hex-match");
    // Both the subfield itself and the parent field cell should light up.
    expect(matched.length).toBe(2);
    rootElRef.remove();
  });

  it("clears the previous highlight when fieldId becomes null", () => {
    rootElRef = document.createElement("div");
    rootElRef.innerHTML = `
      <div class="field-cell hex-match" data-field-id="srcAddr"></div>
    `;
    rootElRef.setAttribute("data-highlighted-field", "srcAddr");
    document.body.appendChild(rootElRef);

    mount(<HighlightHarness fieldId={null} />);

    expect(rootElRef.getAttribute("data-highlighted-field")).toBeNull();
    expect(rootElRef.querySelector(".hex-match")).toBeNull();
    rootElRef.remove();
  });
});

describe("useRovingTabindex", () => {
  let rootEl: HTMLDivElement;

  function Harness() {
    const ref = { current: rootEl };
    useRovingTabindex(ref);
    return null;
  }

  beforeEach(() => {
    rootEl = document.createElement("div");
    rootEl.innerHTML = `
      <div class="field-cell" data-field-id="a" data-row="0" data-start-bit="0" data-end-bit="3" tabindex="0"></div>
      <div class="field-cell" data-field-id="b" data-row="0" data-start-bit="4" data-end-bit="7" tabindex="-1"></div>
      <div class="field-cell" data-field-id="c" data-row="1" data-start-bit="0" data-end-bit="3" tabindex="-1"></div>
    `;
    document.body.appendChild(rootEl);
  });

  it("ArrowRight moves the active tab stop to the next cell", () => {
    mount(<Harness />);
    const handlers: ((e: React.KeyboardEvent<HTMLDivElement>) => void)[] = [];
    const TestHook = () => {
      const ref = { current: rootEl };
      handlers.push(useRovingTabindex(ref));
      return null;
    };
    mount(<TestHook />);

    const onKey = handlers[handlers.length - 1];
    const target = rootEl.querySelector<HTMLElement>('[data-field-id="a"]')!;
    target.focus();
    act(() => {
      onKey(mkKeyEvent("ArrowRight", target));
    });

    expect(
      rootEl.querySelector('[data-field-id="b"]')?.getAttribute("tabindex"),
    ).toBe("0");
    expect(
      rootEl.querySelector('[data-field-id="a"]')?.getAttribute("tabindex"),
    ).toBe("-1");
  });

  it("End jumps to the last cell", () => {
    mount(<Harness />);
    const handlers: ((e: React.KeyboardEvent<HTMLDivElement>) => void)[] = [];
    const TestHook = () => {
      const ref = { current: rootEl };
      handlers.push(useRovingTabindex(ref));
      return null;
    };
    mount(<TestHook />);
    const onKey = handlers[handlers.length - 1];
    const target = rootEl.querySelector<HTMLElement>('[data-field-id="a"]')!;
    target.focus();
    act(() => {
      onKey(mkKeyEvent("End", target));
    });
    expect(
      rootEl.querySelector('[data-field-id="c"]')?.getAttribute("tabindex"),
    ).toBe("0");
  });
});

describe("useAutoClearStatus", () => {
  function Harness({
    seedStatus,
    onCleared,
  }: {
    seedStatus: string;
    onCleared: () => void;
  }) {
    const [status, setStatus] = useState<string | null>(seedStatus);
    useAutoClearStatus(status, 10, () => {
      setStatus(null);
      onCleared();
    });
    return <div data-testid="state">{status ?? "cleared"}</div>;
  }

  it("clears the status after the timeout", async () => {
    let cleared = 0;
    const onCleared = () => {
      cleared += 1;
    };
    const { container } = mount(
      <Harness seedStatus="hello" onCleared={onCleared} />,
    );
    expect(container.querySelector('[data-testid="state"]')?.textContent).toBe(
      "hello",
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });

    expect(cleared).toBe(1);
    expect(container.querySelector('[data-testid="state"]')?.textContent).toBe(
      "cleared",
    );
  });
});
