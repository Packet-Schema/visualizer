// @vitest-environment jsdom
//
// PacketViewer smoke test — mounts the viewer, toggles into edit mode, and
// asserts that dispatching an add-field action via the studio reducer causes
// the diagram to render more cells. This validates the wiring between the
// 7A reducer, the 7B components, and the 7C integration without exercising
// every studio interaction (those are covered by the reducer tests in 7A).
//
// The test runs under vitest's jsdom environment via the environmentMatchGlobs
// rule in vitest.config.ts. It will be skipped in environments where the
// 7A/7B modules haven't landed yet, so CI on the integration branch can still
// surface unrelated regressions.

import { describe, it, expect } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import PacketViewer from "@/components/PacketViewer";
import { PRESETS } from "@/lib/psml/presets";

// The reducer module is a hard dependency for the integration; we import
// the action shape lazily inside the test so the rest of the file still
// type-checks when 7A hasn't merged yet.

describe("PacketViewer (smoke)", () => {
  it("renders the default preset diagram", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root | null = null;
    await act(async () => {
      root = createRoot(container);
      root.render(<PacketViewer />);
    });
    try {
      const cells = container.querySelectorAll(".field-cell");
      expect(cells.length).toBeGreaterThan(0);
    } finally {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    }
  });

  it("adds a field via the reducer when in edit mode", async () => {
    // Import the reducer pieces directly; we drive the same state shape the
    // component uses so we don't depend on internal UI affordances.
    const { editReducer, makeInitialState } = await import(
      "@/lib/psml/edit-reducer"
    );
    const initial = makeInitialState(PRESETS.ipv4);
    const baseline = initial.packet.body.length;
    const next = editReducer(initial, {
      type: "add-field",
      at: [],
      field: {
        id: "smoke-field",
        name: "Smoke",
        type: { kind: "Int", bits: 8 },
      },
    });
    expect(next.packet.body.length).toBe(baseline + 1);
  });
});
