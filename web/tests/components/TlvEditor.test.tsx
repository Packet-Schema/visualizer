// @vitest-environment jsdom
//
// TlvEditor unit tests. The component owns the per-record kind selector
// + reorder/remove affordances and bubbles the new instance list to the
// parent via `onChange`. These tests drive the buttons directly so we
// cover add / move / remove / extras-change without going through the
// full packet viewer plumbing.

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import TlvEditor from "@/components/field-details/TlvEditor";
import type { Field, TlvCatalogEntry, TlvInstance } from "@/lib/psml/renderer";

let mounted: { container: HTMLDivElement; root: Root }[] = [];

function mount(node: React.ReactNode): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  const entry = { container, root };
  mounted.push(entry);
  return entry;
}

afterEach(() => {
  // Unmount the React tree first so cleanup effects fire before the
  // container is detached. Skipping this leaks timeouts / event listeners
  // into later tests and is what Copilot flagged on this suite.
  for (const { root, container } of mounted) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  mounted = [];
});

const catalog: TlvCatalogEntry[] = [
  {
    kind: 0,
    name: "EOL",
    fields: [{ id: "type", name: "Type=0", bits: 8 }],
  },
  {
    kind: 1,
    name: "NOP",
    fields: [{ id: "type", name: "Type=1", bits: 8 }],
  },
  {
    kind: 7,
    name: "Record Route",
    fields: [
      { id: "type", name: "Type=7", bits: 8 },
      { id: "length", name: "Len", bits: 8 },
    ],
  },
];

function mkField(instances: TlvInstance[] = []): Field {
  return {
    id: "options",
    name: "Options",
    bits: 0,
    tlv: {
      catalog,
      instances,
      drivesController: "options_count",
    },
  };
}

describe("TlvEditor", () => {
  let lastChange: TlvInstance[] | null = null;
  beforeEach(() => {
    lastChange = null;
  });
  const onChange = (next: TlvInstance[]) => {
    lastChange = next;
  };

  it("renders nothing when the field has no TLV spec", () => {
    const { container } = mount(
      <TlvEditor
        field={{ id: "x", name: "x", bits: 8 }}
        controllers={{}}
        onChange={onChange}
      />,
    );
    expect(container.querySelector("h3")).toBeNull();
  });

  it("adds an instance when a kind is picked and Add is clicked", () => {
    const { container } = mount(
      <TlvEditor field={mkField()} controllers={{}} onChange={onChange} />,
    );
    // Staged-add (Round 7 HIGH): the select stages but does NOT add on
    // change. The user must click Add to confirm. Verifies arrow-key
    // navigation through options doesn't append a record per press.
    const appendSelect = container.querySelector<HTMLSelectElement>("select")!;
    act(() => {
      appendSelect.value = "1";
      appendSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(lastChange).toBeNull(); // staged, not committed
    const addBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent === "Add");
    act(() => {
      addBtn?.click();
    });
    expect(lastChange).toEqual([{ kind: 1 }]);
  });

  it("Add button is disabled until a kind is staged", () => {
    const { container } = mount(
      <TlvEditor field={mkField()} controllers={{}} onChange={onChange} />,
    );
    const addBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent === "Add");
    expect(addBtn?.disabled).toBe(true);
    act(() => {
      addBtn?.click();
    });
    expect(lastChange).toBeNull();
  });

  it("removes an instance via the per-row × button", () => {
    const { container } = mount(
      <TlvEditor
        field={mkField([{ kind: 0 }, { kind: 1 }, { kind: 7 }])}
        controllers={{}}
        onChange={onChange}
      />,
    );
    const removeButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).filter((b) => b.getAttribute("aria-label")?.startsWith("Remove record"));
    expect(removeButtons.length).toBe(3);
    act(() => {
      removeButtons[1].click(); // remove middle item
    });
    expect(lastChange).toEqual([{ kind: 0 }, { kind: 7 }]);
  });

  it("changes a record's variant in place via the per-row <select>", () => {
    const { container } = mount(
      <TlvEditor
        field={mkField([{ kind: 1 }])}
        controllers={{}}
        onChange={onChange}
      />,
    );
    // First <select> is the row's kind selector when one row exists.
    const rowSelect = container.querySelector<HTMLSelectElement>("select")!;
    act(() => {
      rowSelect.value = "7";
      rowSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(lastChange).toEqual([{ kind: 7 }]);
  });

  it("moves an instance up / down via the reorder buttons", () => {
    const { container } = mount(
      <TlvEditor
        field={mkField([{ kind: 0 }, { kind: 1 }, { kind: 7 }])}
        controllers={{}}
        onChange={onChange}
      />,
    );
    const moveDown = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        'button[aria-label^="Move record"][aria-label$="down"]',
      ),
    );
    act(() => {
      moveDown[0].click(); // push kind=0 down past kind=1
    });
    expect(lastChange).toEqual([{ kind: 1 }, { kind: 0 }, { kind: 7 }]);

    const moveUp = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        'button[aria-label^="Move record"][aria-label$="up"]',
      ),
    );
    act(() => {
      moveUp[2].click(); // pull kind=7 up
    });
    expect(lastChange).toEqual([{ kind: 0 }, { kind: 7 }, { kind: 1 }]);
  });

  it("disables Move-up on the first row and Move-down on the last row", () => {
    const { container } = mount(
      <TlvEditor
        field={mkField([{ kind: 0 }, { kind: 1 }])}
        controllers={{}}
        onChange={onChange}
      />,
    );
    const moveUpFirst = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Move record"][aria-label$="up"]',
    );
    const moveDownLast = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        'button[aria-label^="Move record"][aria-label$="down"]',
      ),
    ).pop();
    expect(moveUpFirst?.disabled).toBe(true);
    expect(moveDownLast?.disabled).toBe(true);
  });
});
