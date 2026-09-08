// Regression: a source-less `rendererToPsdl` lift must PRESERVE the on-wire
// shape of variable-length non-TLV / non-chain fields, not silently drop them.
//
// `rendererFieldToPsdl` used to `return []` for every `bits <= 0` /
// `variable:true` leaf. That is reachable on every lift path that has no
// retained source (PacketViewer share/export, the `targetPsdl` diagram path,
// `activePsdlPacket`). Because the mirror still carries these as REAL fields
// (`bytes(remaining)` as `isRemaining`, delimiter-terminated `bytes` as
// `isDelimited`), dropping them produced VALID-but-structurally-smaller PSDL —
// a silent lossy round-trip that `tlv-roundtrip.test.ts` (validity only) never
// caught. These tests pin that the intrinsic-shape variable fields survive a
// source-less round-trip.

import { describe, it, expect } from "vitest";

import { psdlToRenderer, rendererToPsdl } from "@/lib/psdl/psdl-to-renderer";
import { validatePsdlPacket } from "@/lib/psdl/validate";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

function fieldIds(packet: PsdlPacket): (string | undefined)[] {
  return packet.body.map((c) => c.id);
}

describe("source-less rendererToPsdl preserves variable-length fields", () => {
  const src: PsdlPacket = {
    name: "probe",
    rowBits: 32,
    byteOrder: "BE",
    body: [
      { kind: "field", id: "tag", name: "Tag", type: { kind: "bits", n: 8 } },
      {
        kind: "field",
        id: "label",
        name: "Label",
        type: { kind: "bytes", n: { delimiter: [0] } },
      },
      {
        kind: "field",
        id: "rest",
        name: "Rest",
        type: { kind: "bytes", n: { kind: "remaining" } },
      },
    ],
  };

  it("re-emits delimited + remaining fields instead of dropping them", () => {
    const mirror = psdlToRenderer(src);
    // Sanity: the mirror really does carry these as fields (the see-but-cannot-
    // edit precondition the old drop violated).
    expect(mirror.fields.map((f) => f.id)).toEqual(["tag", "label", "rest"]);

    const back = rendererToPsdl(mirror);

    // The packet must NOT shrink: all three fields survive.
    expect(fieldIds(back)).toEqual(["tag", "label", "rest"]);

    const label = back.body.find((c) => c.id === "label");
    expect(label).toMatchObject({
      type: { kind: "bytes", n: { delimiter: [0] } },
    });

    const rest = back.body.find((c) => c.id === "rest");
    expect(rest).toMatchObject({
      type: { kind: "bytes", n: { kind: "remaining" } },
    });

    // And the re-emitted PSDL is still valid.
    expect(() => validatePsdlPacket(back)).not.toThrow();
  });

  it("preserves a multi-byte delimiter verbatim across the lift", () => {
    const withCrlf: PsdlPacket = {
      ...src,
      body: [
        { kind: "field", id: "tag", name: "Tag", type: { kind: "bits", n: 8 } },
        {
          kind: "field",
          id: "line",
          name: "Line",
          type: { kind: "bytes", n: { delimiter: [13, 10] } },
        },
      ],
    };
    const back = rendererToPsdl(psdlToRenderer(withCrlf));
    const line = back.body.find((c) => c.id === "line");
    expect(line).toMatchObject({
      type: { kind: "bytes", n: { delimiter: [13, 10] } },
    });
    expect(() => validatePsdlPacket(back)).not.toThrow();
  });

  it("round-trips delimited + remaining shape stably (lift is idempotent)", () => {
    const once = rendererToPsdl(psdlToRenderer(src));
    const twice = rendererToPsdl(psdlToRenderer(once));
    expect(fieldIds(twice)).toEqual(fieldIds(once));
    expect(twice.body).toEqual(once.body);
  });
});
