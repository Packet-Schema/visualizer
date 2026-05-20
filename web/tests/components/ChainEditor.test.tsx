// @vitest-environment jsdom
//
// ChainEditor unit tests. Drives the add / reorder / remove / final-proto
// buttons directly and asserts on the `onChange` payload, mirroring
// TlvEditor.test.tsx's approach.

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import ChainEditor from "@/components/field-details/ChainEditor";
import type {
  ChainCatalogEntry,
  ChainInstance,
  Field,
} from "@/lib/psml/renderer";

let containers: HTMLDivElement[] = [];

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

afterEach(() => {
  for (const c of containers) c.remove();
  containers = [];
});

const catalog: ChainCatalogEntry[] = [
  {
    proto: 0,
    name: "Hop-by-Hop Options",
    fields: [{ id: "nh", name: "Next Header", bits: 8 }],
  },
  {
    proto: 43,
    name: "Routing",
    fields: [{ id: "nh", name: "Next Header", bits: 8 }],
  },
  {
    proto: 44,
    name: "Fragment",
    fields: [{ id: "nh", name: "Next Header", bits: 8 }],
  },
];

function mkField(instances: ChainInstance[] = [], finalProto?: number): Field {
  return {
    id: "nextHeader_chain",
    name: "Next Header (chain)",
    bits: 0,
    chainCatalog: catalog,
    chainInstances: instances,
    chainFinalProto: finalProto,
  };
}

describe("ChainEditor", () => {
  let last: { instances: ChainInstance[]; finalProto?: number } | null = null;
  beforeEach(() => {
    last = null;
  });
  const onChange = (next: {
    instances: ChainInstance[];
    finalProto?: number;
  }) => {
    last = next;
  };

  it("adds an instance for the selected proto", () => {
    const { container } = mount(
      <ChainEditor field={mkField()} onChange={onChange} />,
    );
    const selects = container.querySelectorAll<HTMLSelectElement>("select");
    expect(selects.length).toBeGreaterThanOrEqual(1);
    act(() => {
      selects[0].value = "43";
      selects[0].dispatchEvent(new Event("change", { bubbles: true }));
    });
    const addBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent === "Add");
    expect(addBtn).toBeDefined();
    expect(addBtn!.disabled).toBe(false);
    act(() => {
      addBtn!.click();
    });
    expect(last?.instances).toEqual([{ proto: 43 }]);
  });

  it("removes instances and reorders them", () => {
    const { container } = mount(
      <ChainEditor
        field={mkField([{ proto: 0 }, { proto: 43 }, { proto: 44 }])}
        onChange={onChange}
      />,
    );

    // Move kind=0 down
    const moveDown = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Move down"]',
      ),
    );
    act(() => {
      moveDown[0].click();
    });
    expect(last?.instances).toEqual([
      { proto: 43 },
      { proto: 0 },
      { proto: 44 },
    ]);

    // Remove the middle item (kind=0)
    const removeBtns = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).filter((b) => b.textContent === "Remove");
    act(() => {
      removeBtns[1].click();
    });
    expect(last?.instances.length).toBe(2);
  });

  it("changes the final upper-layer protocol", () => {
    const { container } = mount(
      <ChainEditor field={mkField([], 59)} onChange={onChange} />,
    );
    // The final-proto picker is the second <select> (the first is the
    // 'Add extension header' selector).
    const selects = container.querySelectorAll<HTMLSelectElement>("select");
    const finalSelect = selects[selects.length - 1];
    act(() => {
      finalSelect.value = "6";
      finalSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(last?.finalProto).toBe(6);
  });

  it("Add button is disabled until a proto is selected", () => {
    const { container } = mount(
      <ChainEditor field={mkField()} onChange={onChange} />,
    );
    const addBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent === "Add");
    expect(addBtn?.disabled).toBe(true);
  });
});
