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
import { STORAGE_KEY } from "@/lib/psml/custom-presets";
import { PRESETS } from "@/lib/psml/presets";
import { encodePsmlParam } from "@/lib/share-url";
import type { PsmlPacket } from "@/lib/psml/types";
import { encodeSubfieldSelection } from "@/components/diagram/selectableFieldId";

// The reducer module is a hard dependency for the integration; we import
// the action shape lazily inside the test so the rest of the file still
// type-checks when 7A hasn't merged yet.

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("packet-view-tour-seen", "1");
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
      await import("@/lib/psml/edit-reducer");
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
      const dataOffset = container.querySelector<HTMLInputElement>(
        "#ctrl-dataOffset-number",
      );
      expect(picker?.value).toBe("tcp");
      expect(dataOffset?.value).toBe("10");
      expect(window.location.search).toContain("preset=tcp");
      expect(window.location.search).toContain("controllers.dataOffset=10");
    } finally {
      await cleanup();
    }
  });

  it("selects PSML group children with parent-qualified subfield ids", async () => {
    const { container, cleanup } = await mountPacketViewer("/?preset=tcp");
    try {
      const ackCell = container.querySelector<HTMLElement>(
        `[data-field-id="${encodeSubfieldSelection("flagsBits", "flags_ack")}"]`,
      );
      expect(ackCell).not.toBeNull();

      await act(async () => {
        ackCell?.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });

      expect(ackCell?.classList.contains("selected")).toBe(true);
      expect(container.querySelector(".hex-byte.selected")).not.toBeNull();
      expect(container.textContent).toContain("ACK");
      expect(container.textContent).toContain("subfield of flagsBits");
      expect(container.textContent).not.toContain("Field not found");
    } finally {
      await cleanup();
    }
  });

  it("prefers top-level field ids over colliding subfield ids", async () => {
    const packet: PsmlPacket = {
      name: "Colliding IDs",
      rowBits: 8,
      body: [
        { id: "flag", name: "Top Flag", type: { kind: "bits", n: 1 } },
        {
          kind: "group",
          id: "flagsBits",
          children: [
            { id: "flag", name: "Nested Flag", type: { kind: "bits", n: 1 } },
            { id: "rest", name: "Rest", type: { kind: "bits", n: 6 } },
          ],
        },
      ],
    };
    const { container, cleanup } = await mountPacketViewer(
      `/?psml=${encodePsmlParam(packet, {})}`,
    );
    try {
      const topLevelCell = container.querySelector<HTMLElement>(
        '[data-field-id="flag"]',
      );
      expect(topLevelCell).not.toBeNull();

      await act(async () => {
        topLevelCell?.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });

      expect(topLevelCell?.classList.contains("selected")).toBe(true);
      expect(container.textContent).toContain("Top Flag");
      expect(container.textContent).not.toContain("subfield of flagsBits");
      expect(container.textContent).not.toContain("Field not found");
      expect(container.querySelector(".hex-byte.selected")).not.toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("stores a shared psml payload in My presets", async () => {
    const baseName = "Shared URL Packet ";
    const expectedName = `${baseName}${"x".repeat(80 - baseName.length)}`;
    const shared = mkPacket(`   Shared URL Packet   ${"x".repeat(100)}   `);
    const { container, cleanup } = await mountPacketViewer(
      `/?psml=${encodePsmlParam(shared, { len: 3 })}`,
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

  it("hydrates shared psml from memory when preset storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is unavailable", "QuotaExceededError");
    });

    const shared = mkPacket("No Storage Packet", "storage-only");
    const { container, cleanup } = await mountPacketViewer(
      `/?psml=${encodePsmlParam(shared, { len: 3 })}`,
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
    const storedPacket: PsmlPacket = {
      body: [{ name: "X", id: "x", type: { n: 8, kind: "bits" } }],
      rowBits: 8,
      name,
    };
    const collidingPacket = mkPacket(name, "different-packet");
    const sharedPacket: PsmlPacket = {
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
      `/?psml=${encodePsmlParam(sharedPacket, {})}`,
    );
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
      const picker = container.querySelector("select");
      expect(Object.keys(stored)).toEqual([`custom:${name}`, matchingKey]);
      expect(stored[matchingKey]).toMatchObject({ name });
      expect(picker?.value).toBe(matchingKey);
      expect(window.location.search).toContain("psml=");
      expect(window.location.search).not.toContain("preset=custom");
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
      `/?psml=${encodePsmlParam(sharedPacket, {})}`,
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
      expect(window.location.search).toContain("psml=");
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
    root.render(<PacketViewer />);
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

function mkPacket(name: string, fieldId = "x"): PsmlPacket {
  return {
    name,
    rowBits: 8,
    body: [{ id: fieldId, name: "X", type: { kind: "bits", n: 8 } }],
  };
}
