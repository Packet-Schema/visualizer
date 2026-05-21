// PSML layout helper regression tests.
//
// Verifies that `resolveLayout` only assigns `sourceTopLevelGroupId` for
// fields that originate directly under a top-level group. Nested groups with
// the same trailing id must not be mistaken for top-level parents.

import { describe, expect, it } from "vitest";

import { resolveLayout } from "../../lib/psml/layout";
import type { Packet } from "../../lib/psml/types";

const bits = (n: number) => ({ kind: "bits" as const, n });

describe("resolveLayout — top-level group detection", () => {
  it("does not treat nested groups as top-level parents when only the suffix matches", () => {
    const packet: Packet = {
      name: "SuffixMatch",
      rowBits: 32,
      body: [
        {
          kind: "group",
          id: "h",
          children: [{ id: "target", name: "Target", type: bits(8) }],
        },
        {
          kind: "group",
          id: "outer",
          children: [
            {
              kind: "group",
              id: "h",
              children: [{ id: "target", name: "Target", type: bits(8) }],
            },
          ],
        },
      ],
    };

    const layout = resolveLayout(packet);
    const targets = layout.cells.filter((c) => c.field.id === "target");
    expect(targets.length).toBe(2);
    expect(targets[0]?.field.sourceTopLevelGroupId).toBe("h");
    expect(targets[1]?.field.sourceTopLevelGroupId).toBeUndefined();
  });

  it("does not depend on slash-free packet names when matching top-level groups", () => {
    const packet: Packet = {
      name: "Custom/Packet",
      rowBits: 32,
      body: [
        {
          kind: "group",
          id: "flagsBits",
          children: [
            { id: "ack", name: "ACK", type: bits(1) },
            { id: "rest", name: "Rest", type: bits(7) },
          ],
        },
      ],
    };

    const layout = resolveLayout(packet);
    const ack = layout.cells.find((c) => c.field.id === "ack");
    expect(ack?.field.sourceTopLevelGroupId).toBe("flagsBits");
  });
});
