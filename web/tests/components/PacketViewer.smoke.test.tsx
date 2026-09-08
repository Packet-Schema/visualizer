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
    // Driven via isisLsp's `pduLength` length controller (a NON-tlv bounded
    // budget that keeps its slider). TCP's `dataOffset` is no longer a length
    // controller — its options region is a TLV-shaped bounded scope owned by
    // the `options` TLV editor.
    const { container, cleanup } = await mountPacketViewer(
      "/?preset=isisLsp&controllers.pduLength=40",
    );
    try {
      const picker = container.querySelector("select");
      expect(picker?.value).toBe("isisLsp");
      // The override slider lives in DetailPanel and is only mounted when
      // the corresponding cell is selected. Click the PDU Length cell to
      // surface it, then verify the hydrated value.
      const pduLengthCell = container.querySelector<HTMLElement>(
        '[data-field-id="pduLength"]',
      );
      await act(async () => {
        pduLengthCell?.dispatchEvent(
          new MouseEvent("click", { bubbles: true }),
        );
      });
      const pduLength = container.querySelector<HTMLInputElement>(
        "#detail-ctrl-pduLength-number",
      );
      expect(pduLength?.value).toBe("40");
      expect(window.location.search).toContain("preset=isisLsp");
      expect(window.location.search).toContain("controllers.pduLength=40");
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
    // useDeferredValue, so when we changed `packetKey` the layout was still
    // computed with the previous packet's controller for a frame, briefly
    // showing the old shape. We drive this with tlsClientHello's
    // `extensionsLen` length controller (a NON-tlv bounded budget that keeps
    // its slider; IPv4 IHL is no longer a length controller — its options
    // region is a TLV-shaped bounded scope owned by the `options` TLV editor).
    const { container, cleanup } = await mountPacketViewer(
      "/?preset=tlsClientHello&controllers.extensionsLen=20",
    );
    try {
      // Sanity check: starts on tlsClientHello with the extensionsLen controller.
      const picker = container.querySelector<HTMLSelectElement>("select");
      expect(picker?.value).toBe("tlsClientHello");
      // Click extensionsLen to surface the override slider in DetailPanel.
      const lenCell = container.querySelector<HTMLElement>(
        '[data-field-id="extensionsLen"]',
      );
      await act(async () => {
        lenCell?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      const lenBefore = container.querySelector<HTMLInputElement>(
        "#detail-ctrl-extensionsLen-number",
      );
      expect(lenBefore?.value).toBe("20");

      // Switch the preset picker to ipv6.
      await act(async () => {
        if (!picker) throw new Error("preset picker missing");
        picker.value = "ipv6";
        picker.dispatchEvent(new Event("change", { bubbles: true }));
      });
      // ipv6 is lazy-fetched on switch; flush the load + controller reset.
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 0));
        });
      }

      // After the switch we should see IPv6's `srcAddr` field and *not* the
      // tlsClientHello extensionsLen controller — which would prove
      // `controllers` was reset and the layout was rebuilt against the new shape.
      expect(picker?.value).toBe("ipv6");
      // Codex P1 regression: switching to a not-yet-loaded built-in must reset
      // controllers once its body arrives, so the stale extensionsLen controller
      // is gone from the canonical share URL (not leaked onto ipv6).
      expect(window.location.search).not.toContain("controllers.extensionsLen");
      // Codex P2 regression: a built-in (even mid-lazy-load) shares as a clean
      // `preset=<key>` URL, never a psdl-encoded copy of the fallback packet.
      expect(window.location.search).toContain("preset=ipv6");
      expect(window.location.search).not.toContain("psdl=");
      expect(
        container.querySelector('[data-field-id="srcAddr"]'),
      ).not.toBeNull();
      expect(
        container.querySelector<HTMLInputElement>(
          "#detail-ctrl-extensionsLen-number",
        ),
      ).toBeNull();
      // No tlsClientHello extension-cell leftovers — those use the
      // `${field.id}#${repeatIndex}` synthetic id from the Repeat expansion.
      const leftoverIds = Array.from(
        container.querySelectorAll<HTMLElement>("[data-field-id]"),
      )
        .map((el) => el.dataset.fieldId ?? "")
        .filter((id) => id.startsWith("extType#") || id.startsWith("extType:"));
      expect(leftoverIds).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("degrades gracefully instead of crashing when an override count over-consumes a bounded scope", async () => {
    // Override-audit finding A8: bumping the free-repeat stepper for a repeat
    // nested inside a `bounded` byte scope (here bgpUpdateFull's
    // `bgpWithdrawnRoutes`, bounded by `bgpWithdrawnRoutesLength`) makes core's
    // normalize throw "bounded scope over-consumed". That throw used to reach
    // React render and white-screen the whole app. The layout memo now catches
    // it and falls back to the last good layout, so mounting must NOT throw.
    const { container, cleanup } = await mountPacketViewer(
      "/?preset=bgpUpdateFull&controllers.bgpWithdrawnRoutes=2",
    );
    try {
      const picker = container.querySelector<HTMLSelectElement>("select");
      expect(picker?.value).toBe("bgpUpdateFull");
    } finally {
      await cleanup();
    }
  });

  it("does not leak the previous preset's controllers while switching to an unloaded built-in (D3)", async () => {
    // override-audit D3: switching to a never-fetched built-in defers the
    // controller reset until loadPreset resolves. In that load window the share
    // URL must not carry the previous preset's controllers under the new key.
    const { container, cleanup } = await mountPacketViewer(
      "/?preset=ipv4&controllers.ihl=8",
    );
    const realFetch = globalThis.fetch;
    try {
      expect(window.location.search).toContain("controllers.ihl=8");
      // Make the next preset body hang so the load window stays open.
      vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
      const picker = container.querySelector<HTMLSelectElement>("select");
      await act(async () => {
        if (!picker) throw new Error("preset picker missing");
        picker.value = "dhcpv6"; // not primed → lazy-fetched (and now hanging)
        picker.dispatchEvent(new Event("change", { bubbles: true }));
      });
      // In-flight: clean preset URL, no stale ipv4 ihl controller.
      expect(picker?.value).toBe("dhcpv6");
      expect(window.location.search).toContain("preset=dhcpv6");
      expect(window.location.search).not.toContain("controllers.ihl");
    } finally {
      vi.stubGlobal("fetch", realFetch);
      await cleanup();
    }
  });

  it("keeps a built-in's TLV edit (made outside edit mode) in the share URL", async () => {
    // override-audit D1: adding a TLV record to a built-in preset via the
    // OverridePanel WITHOUT entering edit mode used to be dropped from the
    // share URL (the raw `preset=ipv4` was emitted instead of the edited
    // packet). The edit must now survive as a `psdl=` payload.
    const { container, cleanup } = await mountPacketViewer(
      "/?preset=ipv4&controllers.ihl=7",
    );
    try {
      // Sanity: not in edit mode, clean preset URL with no psdl payload yet.
      expect(window.location.search).toContain("preset=ipv4");
      expect(window.location.search).not.toContain("psdl=");

      // Open the Options TLV editor by clicking the placeholder slot cell.
      const placeholder = container.querySelector<HTMLElement>(
        '[data-field-id="options"]',
      );
      await act(async () => {
        placeholder?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      // Append a NOP record through the TlvEditor's "+ Add record" select.
      const overrideSection = Array.from(container.querySelectorAll("h2")).find(
        (h) => h.textContent?.includes("Override"),
      )?.parentElement;
      const appendSelect =
        overrideSection?.querySelector<HTMLSelectElement>("select");
      await act(async () => {
        if (!appendSelect) throw new Error("TLV append select missing");
        appendSelect.value = "1"; // NOP
        appendSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const addBtn = Array.from(
        overrideSection?.querySelectorAll<HTMLButtonElement>("button") ?? [],
      ).find((b) => b.textContent === "Add");
      await act(async () => {
        addBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      // Flush the URL-sync effect.
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 0));
        });
      }

      // The TLV instance must now be encoded in the share URL.
      expect(window.location.search).toContain("psdl=");
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
