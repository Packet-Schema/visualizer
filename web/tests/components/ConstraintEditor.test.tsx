// @vitest-environment jsdom
//
// ConstraintEditor unit tests. The component dispatches edit-reducer actions
// (add-constraint / update-constraint / delete-constraint) through a `dispatch`
// prop, so we drive the rendered buttons and assert on the dispatched action
// shapes.

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import ConstraintEditor from "@/components/custom-packet-studio/ConstraintEditor";
import type { EditAction } from "@/lib/psdl/edit-reducer";
import type { Constraint } from "@/lib/psdl/types";

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
  for (const { root, container } of mounted) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  mounted = [];
});

describe("ConstraintEditor", () => {
  let actions: EditAction[] = [];
  beforeEach(() => {
    actions = [];
  });
  const dispatch = (a: EditAction) => {
    actions.push(a);
  };

  const constraints: Constraint[] = [
    {
      lhs: {
        kind: "op",
        op: "*",
        a: { kind: "ref", field: "ihl" },
        b: { kind: "lit", value: 4 },
      },
      rhs: { kind: "ref", field: "headerBytes" },
    },
    {
      lhs: { kind: "ref", field: "totalLength" },
      rhs: { kind: "ref", field: "byteCount" },
    },
  ];

  it("renders one row per constraint and exposes a status badge", () => {
    const { container } = mount(
      <ConstraintEditor
        constraints={constraints}
        fieldIds={["ihl", "headerBytes", "totalLength", "byteCount"]}
        dispatch={dispatch}
      />,
    );
    expect(container.querySelectorAll("li").length).toBe(2);
    // Status badge is one of the spans inside the header.
    const badge = container.querySelector("h3 + span");
    expect(badge).not.toBeNull();
  });

  it("dispatches delete-constraint with the row index", () => {
    const { container } = mount(
      <ConstraintEditor
        constraints={constraints}
        fieldIds={["ihl", "headerBytes", "totalLength", "byteCount"]}
        dispatch={dispatch}
      />,
    );
    const delBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete constraint 2"]',
    );
    expect(delBtn).not.toBeNull();
    act(() => {
      delBtn!.click();
    });
    expect(actions).toEqual([{ type: "delete-constraint", index: 1 }]);
  });

  it("dispatches add-constraint when the draft row's button is clicked", () => {
    const { container } = mount(
      <ConstraintEditor constraints={[]} fieldIds={[]} dispatch={dispatch} />,
    );
    const addBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Add constraint"]',
    );
    expect(addBtn).not.toBeNull();
    act(() => {
      addBtn!.click();
    });
    expect(actions.length).toBe(1);
    expect(actions[0]).toMatchObject({
      type: "add-constraint",
      constraint: {
        lhs: { kind: "lit", value: 0 },
        rhs: { kind: "lit", value: 0 },
      },
    });
  });

  it("renders 'cannot verify' status when env is omitted", () => {
    const { container } = mount(
      <ConstraintEditor
        constraints={constraints}
        fieldIds={["ihl", "headerBytes"]}
        dispatch={dispatch}
      />,
    );
    expect(container.textContent).toContain("cannot verify");
  });

  it("renders 'ok' when constraints hold against the env", () => {
    const env = new Map([
      ["ihl", 5],
      ["headerBytes", 20],
      ["totalLength", 100],
      ["byteCount", 100],
    ]);
    const { container } = mount(
      <ConstraintEditor
        constraints={constraints}
        fieldIds={["ihl", "headerBytes", "totalLength", "byteCount"]}
        dispatch={dispatch}
        env={env}
      />,
    );
    expect(container.textContent).toContain("ok");
  });

  it("renders 'conflict' when the env contradicts the constraint", () => {
    const env = new Map([
      ["ihl", 5],
      ["headerBytes", 999],
      ["totalLength", 100],
      ["byteCount", 100],
    ]);
    const { container } = mount(
      <ConstraintEditor
        constraints={constraints}
        fieldIds={["ihl", "headerBytes", "totalLength", "byteCount"]}
        dispatch={dispatch}
        env={env}
      />,
    );
    expect(container.textContent).toContain("conflict");
  });
});
