// PSDL 0.4 — per-field byteOrder tests.
//
// Verifies:
//   * Field.byteOrder propagates onto NormalizedField and the resolved Cell;
//   * fields without byteOrder produce no cell.byteOrder (renderer default);
//   * BE and LE can coexist on different fields within the same packet;
//   * validator rejects values other than 'BE' or 'LE'.

import { describe, expect, it } from "vitest";
import { normalize } from "../../lib/psdl/normalize";
import { resolveLayout } from "../../lib/psdl/layout";
import { validatePsdlPacket } from "../../lib/psdl/validate";
import type { Field, Packet } from "../../lib/psdl/types";
import {
  psdlToRenderer,
  mergeInstancesIntoPsdl,
} from "../../lib/psdl/psdl-to-renderer";
import { toJson, fromJson } from "../../lib/formats/json";
import { PRESETS } from "../../lib/psdl/presets.server";
import type { Packet as RendererPacket } from "../../lib/psdl/renderer";

const bits = (n: number) => ({ kind: "bits" as const, n });

/** Find a Field's byteOrder anywhere in a PSDL body (deep walk). */
function findByteOrder(packet: Packet, id: string): string | undefined {
  let found: string | undefined;
  const walk = (c: unknown): void => {
    if (found !== undefined || !c || typeof c !== "object") return;
    const o = c as Record<string, unknown>;
    if (o.id === id && "byteOrder" in o) {
      found = o.byteOrder as string | undefined;
      return;
    }
    for (const key of ["fields", "children", "body"]) {
      const arr = o[key];
      if (Array.isArray(arr)) arr.forEach(walk);
    }
    if (o.element) walk(o.element);
    if (o.container) walk(o.container);
    if (o.plaintext) walk(o.plaintext);
    if (o.cases) Object.values(o.cases as object).forEach(walk);
  };
  packet.body.forEach(walk);
  return found;
}

describe("per-field byteOrder", () => {
  it("LE on a Field propagates onto NormalizedField and Cell", () => {
    const p: Packet = {
      name: "LeField",
      rowBits: 32,
      body: [{ id: "le", name: "LE", type: bits(16), byteOrder: "LE" }],
    };
    const n = normalize(p);
    expect(n.fields[0].byteOrder).toBe("LE");
    const layout = resolveLayout(p);
    expect(layout.cells[0].byteOrder).toBe("LE");
  });

  it("absent byteOrder leaves NormalizedField.byteOrder and Cell.byteOrder undefined", () => {
    const p: Packet = {
      name: "DefField",
      rowBits: 32,
      body: [{ id: "f", name: "F", type: bits(16) }],
    };
    const n = normalize(p);
    expect(n.fields[0].byteOrder).toBeUndefined();
    const layout = resolveLayout(p);
    expect(layout.cells[0].byteOrder).toBeUndefined();
  });

  it("mixes BE and LE fields in the same packet", () => {
    const beField: Field = {
      id: "be",
      name: "BE",
      type: bits(16),
      byteOrder: "BE",
    };
    const leField: Field = {
      id: "le",
      name: "LE",
      type: bits(16),
      byteOrder: "LE",
    };
    const plainField: Field = { id: "x", name: "X", type: bits(16) };
    const p: Packet = {
      name: "Mixed",
      rowBits: 64,
      body: [beField, leField, plainField],
    };
    const n = normalize(p);
    expect(n.fields.map((f) => f.byteOrder)).toEqual(["BE", "LE", undefined]);
    const layout = resolveLayout(p);
    expect(layout.cells.map((c) => c.byteOrder)).toEqual([
      "BE",
      "LE",
      undefined,
    ]);
  });

  it("a switch-case-nested byteOrder flip survives lift → JSON → re-import", () => {
    // A multi-byte int inside a Switch case (BE default), flipped to LE via the
    // diagram. The flip is recorded on the mirror's `byteOrderOverrides` map
    // (nested fields never reach `mirror.fields`). `mergeInstancesIntoPsdl` must
    // source it from there and stamp it on the PSDL field; the JSON round-trip
    // must then preserve it.
    const src: Packet = {
      name: "SwitchByteOrder",
      rowBits: 32,
      body: [
        { id: "kind", name: "Kind", type: bits(8) },
        {
          kind: "switch",
          id: "kindSwitch",
          on: { kind: "ref", field: "kind" },
          cases: {
            "0": {
              id: "kind0",
              fields: [{ id: "streamId", name: "Stream ID", type: bits(32) }],
            },
          },
        },
      ],
    };
    // The nested field is NOT a top-level mirror field.
    const mirror = psdlToRenderer(src) as RendererPacket;
    expect(mirror.fields.some((f) => f.id === "streamId")).toBe(false);

    // Diagram flip → recorded on the override map.
    const flipped: RendererPacket = {
      ...mirror,
      byteOrderOverrides: { streamId: "LE" },
    };

    // Lift onto the source PSDL.
    const lifted = mergeInstancesIntoPsdl(src, flipped);
    expect(findByteOrder(lifted, "streamId")).toBe("LE");

    // JSON export → re-import is lossless.
    const reimported = fromJson(toJson(lifted)).packet;
    expect(findByteOrder(reimported, "streamId")).toBe("LE");

    // And the re-imported PSDL lays the field out as LE.
    const layout = resolveLayout(reimported, {});
    expect(layout.cells.find((c) => c.field.id === "streamId")?.byteOrder).toBe(
      "LE",
    );
  });

  it("rtmp.messageStreamId (built-in LE) survives a BE flip through lift → JSON → re-import", () => {
    const src = PRESETS.rtmp!;
    const mirror = psdlToRenderer(src) as RendererPacket;
    // It renders LE by default and is NOT a top-level mirror field.
    expect(mirror.fields.some((f) => f.id === "messageStreamId")).toBe(false);
    expect(findByteOrder(src, "messageStreamId")).toBe("LE");

    const flipped: RendererPacket = {
      ...mirror,
      byteOrderOverrides: { messageStreamId: "BE" },
    };
    const lifted = mergeInstancesIntoPsdl(src, flipped);
    expect(findByteOrder(lifted, "messageStreamId")).toBe("BE");

    const reimported = fromJson(toJson(lifted)).packet;
    expect(findByteOrder(reimported, "messageStreamId")).toBe("BE");
    const layout = resolveLayout(reimported, {});
    expect(
      layout.cells.find((c) => c.field.id === "messageStreamId")?.byteOrder,
    ).toBe("BE");
  });

  it("validator rejects an invalid byteOrder string", () => {
    const p: Packet = {
      name: "Bad",
      rowBits: 32,
      body: [
        {
          id: "f",
          name: "F",
          type: bits(16),
          byteOrder: "MIDDLE" as unknown as "BE",
        },
      ],
    };
    expect(() => validatePsdlPacket(p)).toThrow(
      /byteOrder must be 'BE' or 'LE'/,
    );
  });
});
