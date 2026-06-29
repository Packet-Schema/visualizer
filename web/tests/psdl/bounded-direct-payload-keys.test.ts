// Unit coverage for `boundedKeysWithDirectPayload` — the AST detector that
// distinguishes a DUAL-ROLE boundedRepeat length key (one that budgets a
// `bounded` scope AND directly sizes a `bytes(ref X)` payload in another arm)
// from a PURE bounded length key (budget only). PacketViewer caps only the
// former, so the detector must not over- or under-report.

import { describe, it, expect } from "vitest";

import { boundedKeysWithDirectPayload } from "@/lib/psdl/bounded-direct-payload-keys";
import { lit, ref } from "@/lib/psdl/expr";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

function pkt(body: PsdlPacket["body"]): PsdlPacket {
  return { name: "t", body } as PsdlPacket;
}

const lenField = {
  id: "len",
  name: "Length",
  type: { kind: "int", bits: 16 },
  category: "length",
} as const;

describe("boundedKeysWithDirectPayload", () => {
  it("returns a key whose `bytes(ref X)` payload sits OUTSIDE its bounded scope", () => {
    // switch: arm A wraps the payload in `bounded(ref len)`; arm B is a direct
    // `bytes(ref len)` payload (the generic/raw arm) — dual-role.
    const src = pkt([
      lenField as never,
      {
        kind: "switch",
        id: "sw",
        on: ref("kind"),
        cases: {
          "0": {
            id: "armA",
            fields: [
              {
                kind: "bounded",
                id: "scope",
                bytes: ref("len"),
                fields: [
                  {
                    id: "recs",
                    name: "Records",
                    type: { kind: "bytes", n: lit(4) },
                    category: "payload",
                  } as never,
                ],
              } as never,
            ],
          },
          "1": {
            id: "armB",
            fields: [
              {
                id: "raw",
                name: "Raw",
                type: { kind: "bytes", n: ref("len") },
                category: "payload",
              } as never,
            ],
          },
        },
      } as never,
    ]);
    expect([...boundedKeysWithDirectPayload(src, ["len"])]).toEqual(["len"]);
  });

  it("does NOT return a key whose ONLY `bytes(ref X)` is inside its own bounded scope", () => {
    // The payload is `bytes(ref len)` but it is the bounded scope's OWN budgeted
    // child — pure bounded, not a separate direct arm.
    const src = pkt([
      lenField as never,
      {
        kind: "bounded",
        id: "scope",
        bytes: ref("len"),
        fields: [
          {
            id: "payload",
            name: "Payload",
            type: { kind: "bytes", n: ref("len") },
            category: "payload",
          } as never,
        ],
      } as never,
    ]);
    expect([...boundedKeysWithDirectPayload(src, ["len"])]).toEqual([]);
  });

  it("restricts the result to the supplied bounded keys", () => {
    // `other` directly sizes a payload but is not in the supplied bounded keys,
    // so it must not be returned.
    const src = pkt([
      {
        id: "raw",
        name: "Raw",
        type: { kind: "bytes", n: ref("other") },
        category: "payload",
      } as never,
    ]);
    expect([...boundedKeysWithDirectPayload(src, ["len"])]).toEqual([]);
    expect([...boundedKeysWithDirectPayload(src, ["other"])]).toEqual([
      "other",
    ]);
  });
});
