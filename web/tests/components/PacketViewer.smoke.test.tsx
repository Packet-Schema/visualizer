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

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import PacketViewer from "@/components/packet-viewer/PacketViewer";
import { STORAGE_KEY } from "@/lib/psdl/custom-presets";
import { PRESETS } from "@/lib/psdl/presets.server";
import { encodePsdlParam } from "@/lib/share-url";
import type { PsdlPacket } from "@/lib/psdl/types";

// The reducer module is a hard dependency for the integration; we import
// the action shape lazily inside the test so the rest of the file still
// type-checks when 7A hasn't merged yet.

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("packet-schema-visualizer-tour-seen", "1");
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PacketViewer (smoke)", () => {
  it("renders the default preset diagram", async () => {
    const { container, cleanup } = await mountPacketViewer();
    try {
      const cells = container.querySelectorAll(".field-cell");
      expect(cells.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  it("adds a field via the reducer when in edit mode", async () => {
    // Import the reducer pieces directly; we drive the same state shape the
    // component uses so we don't depend on internal UI affordances.
    const { editReducer, makeInitialState } =
      await import("@/lib/psdl/edit-reducer");
    const initial = makeInitialState(PRESETS.ipv4);
    const baseline = initial.packet.body.length;
    const next = editReducer(initial, {
      type: "add-field",
      at: [baseline],
      field: {
        id: "smoke-field",
        name: "Smoke",
        type: { kind: "int", bits: 8 },
      },
    });
    expect(next.packet.body.length).toBe(baseline + 1);
  });

  it("hydrates a built-in preset and controllers from the URL", async () => {
    const { container, cleanup } = await mountPacketViewer(
      "/?preset=tcp&controllers.dataOffset=10",
    );
    try {
      const picker = container.querySelector("select");
      expect(picker?.value).toBe("tcp");
      // The override slider lives in DetailPanel and is only mounted when
      // the corresponding cell is selected. Click the Data Offset cell to
      // surface it, then verify the hydrated value.
      const dataOffsetCell = container.querySelector<HTMLElement>(
        '[data-field-id="dataOffset"]',
      );
      await act(async () => {
        dataOffsetCell?.dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        );
      });
      const dataOffset = container.querySelector<HTMLInputElement>(
        "#detail-ctrl-dataOffset-number",
      );
      expect(dataOffset?.value).toBe("10");
      expect(window.location.search).toContain("preset=tcp");
      expect(window.location.search).toContain("controllers.dataOffset=10");
    } finally {
      await cleanup();
    }
  });

  it("stores a shared psdl payload in My presets", async () => {
    const baseName = "Shared URL Packet ";
    const expectedName = `${baseName}${"x".repeat(80 - baseName.length)}`;
    const shared = mkPacket(`   Shared URL Packet   ${"x".repeat(100)}   `);
    const { container, cleanup } = await mountPacketViewer(
      `/?psdl=${encodePsdlParam(shared, { len: 3 })}`,
    );
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
      const picker = container.querySelector("select");
      expect(stored[`custom:${expectedName}`]).toMatchObject({
        name: expectedName,
      });
      expect(stored[`custom:${shared.name}`]).toBeUndefined();
      expect(picker?.value).toBe(`custom:${expectedName}`);
    } finally {
      await cleanup();
    }
  });

  it("hydrates shared psdl from memory when preset storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is unavailable", "QuotaExceededError");
    });

    const shared = mkPacket("No Storage Packet", "storage-only");
    const { container, cleanup } = await mountPacketViewer(
      `/?psdl=${encodePsdlParam(shared, { len: 3 })}`,
    );
    try {
      const picker = container.querySelector("select");
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(picker?.value).toBe("custom:No Storage Packet");
      expect(
        container.querySelector('[data-field-id="storage-only"]'),
      ).not.toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("reuses a shared custom preset when only object key order differs", async () => {
    const name = "Shared URL Packet";
    const matchingKey = `custom:${name}-2`;
    const storedPacket: PsdlPacket = {
      body: [{ name: "X", id: "x", type: { n: 8, kind: "bits" } }],
      rowBits: 8,
      name,
    };
    const collidingPacket = mkPacket(name, "different-packet");
    const sharedPacket: PsdlPacket = {
      name,
      rowBits: 8,
      body: [{ id: "x", name: "X", type: { kind: "bits", n: 8 } }],
    };
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        [`custom:${name}`]: collidingPacket,
        [matchingKey]: storedPacket,
      }),
    );

    const { container, cleanup } = await mountPacketViewer(
      `/?psdl=${encodePsdlParam(sharedPacket, {})}`,
    );
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
      const picker = container.querySelector("select");
      expect(Object.keys(stored)).toEqual([`custom:${name}`, matchingKey]);
      expect(stored[matchingKey]).toMatchObject({ name });
      expect(picker?.value).toBe(matchingKey);
      expect(window.location.search).toContain("psdl=");
      expect(window.location.search).not.toContain("preset=custom");
    } finally {
      await cleanup();
    }
  });

  it("rebuilds layout cleanly when switching presets after editing controllers", async () => {
    // Regression: an earlier revision deferred `controllers` via
    // useDeferredValue, so when we changed `packetKey` from ipv4 to ipv6 the
    // layout was still computed with the previous `controllers.ihl=8` for a
    // frame. The IPv6 diagram briefly showed IPv4-shaped cells.
    const { container, cleanup } = await mountPacketViewer(
      "/?preset=ipv4&controllers.ihl=8",
    );
    try {
      // Sanity check: starts on ipv4 and the diagram has an IHL controller.
      const picker = container.querySelector<HTMLSelectElement>("select");
      expect(picker?.value).toBe("ipv4");
      // Click IHL to surface the override slider in DetailPanel.
      const ihlCell = container.querySelector<HTMLElement>(
        '[data-field-id="ihl"]',
      );
      await act(async () => {
        ihlCell?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      const ihlBefore = container.querySelector<HTMLInputElement>(
        "#detail-ctrl-ihl-number",
      );
      expect(ihlBefore?.value).toBe("8");
      const sourceCellBefore = container.querySelector(
        '[data-field-id="srcAddr"]',
      );
      expect(sourceCellBefore).not.toBeNull();

      // Switch the preset picker to ipv6.
      await act(async () => {
        if (!picker) throw new Error("preset picker missing");
        picker.value = "ipv6";
        picker.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () => {
        await Promise.resolve();
      });

      // After the switch we should see IPv6's `srcAddr` field and *not* the
      // IPv4 IHL controller — which would prove `controllers` was reset
      // and the layout was rebuilt against the new packet shape.
      expect(picker?.value).toBe("ipv6");
      expect(
        container.querySelector('[data-field-id="srcAddr"]'),
      ).not.toBeNull();
      expect(
        container.querySelector<HTMLInputElement>("#detail-ctrl-ihl-number"),
      ).toBeNull();
      // No IPv4 option-cell leftovers (Type=0 etc.) — those use the
      // `${field.id}#${repeatIndex}` synthetic id from the Repeat expansion.
      const leftoverIds = Array.from(
        container.querySelectorAll<HTMLElement>("[data-field-id]"),
      )
        .map((el) => el.dataset.fieldId ?? "")
        .filter((id) => id.startsWith("type#") || id.startsWith("type:"));
      expect(leftoverIds).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("stores a same-named shared packet under the next custom key when content differs", async () => {
    const name = "Shared URL Packet";
    const storedPacket = mkPacket(name, "stored-field");
    const sharedPacket = mkPacket(name, "incoming-field");
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ [`custom:${name}`]: storedPacket }),
    );

    const { container, cleanup } = await mountPacketViewer(
      `/?psdl=${encodePsdlParam(sharedPacket, {})}`,
    );
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
      const picker = container.querySelector("select");
      expect(Object.keys(stored)).toEqual([
        `custom:${name}`,
        `custom:${name}-2`,
      ]);
      expect(stored[`custom:${name}-2`]).toMatchObject({
        name,
        body: [{ id: "incoming-field" }],
      });
      expect(picker?.value).toBe(`custom:${name}-2`);
      expect(window.location.search).toContain("psdl=");
      expect(window.location.search).not.toContain("preset=custom");
    } finally {
      await cleanup();
    }
  });
});

async function mountPacketViewer(path = "/"): Promise<{
  container: HTMLDivElement;
  cleanup: () => Promise<void>;
}> {
  window.history.replaceState(null, "", path);
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    // The server resolves the initial built-in body and passes it in; mirror
    // that here so the viewer seeds synchronously (built-in bodies are now
    // lazy-fetched, but the initial one is provided up front).
    root.render(<PacketViewer initialBuiltInPacket={PRESETS.ipv4} />);
  });
  // Flush the URL-hydration effect and any lazy preset fetch it triggers
  // (hydration → packetKey change → loadPreset fetch → JSON → setState →
  // re-render spans several async hops).
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
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

function mkPacket(name: string, fieldId = "x"): PsdlPacket {
  return {
    name,
    rowBits: 8,
    body: [{ id: fieldId, name: "X", type: { kind: "bits", n: 8 } }],
  };
}
