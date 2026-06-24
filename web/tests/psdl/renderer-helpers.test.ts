import { describe, expect, it } from "vitest";

import { PRESETS } from "../../lib/psdl/presets.server";
import {
  initialState,
  syncChainControllers,
} from "../../lib/psdl/renderer-helpers";
import { psdlToRenderer } from "../../lib/psdl/psdl-to-renderer";
import { lookup, op, ref } from "../../lib/psdl/expr";
import type { Packet } from "../../lib/psdl/types";

describe("renderer helper controller state", () => {
  it("seeds IPv6 chain repeat count refs", () => {
    const packet = psdlToRenderer(PRESETS.ipv6);
    const state = initialState(packet);

    expect(state.nextHeader_chainCount).toBe(0);
    expect(state.nextHeader_proto).toBe(59);
  });

  it("syncs IPv6 chain edits into PSDL env keys", () => {
    const packet = psdlToRenderer(PRESETS.ipv6);
    const chainField = packet.fields.find((field) => field.chainCatalog);
    expect(chainField).toBeDefined();

    chainField!.chainInstances = [{ proto: 0 }];
    const state = syncChainControllers(packet, {});

    expect(state.nextHeader_chainCount).toBe(1);
    expect(state.nextHeader_proto).toBe(0);
  });
});

describe("psdlToRenderer — 0.5 bounded.bytes lookup controller", () => {
  // A `bounded` whose byte budget is `lookup(ref("lenCode"), …)` nominates
  // `lenCode` as its single length controller. Before exprRefs the
  // controller collector only descended op/cond/peek, so the ref hidden
  // inside the lookup key was invisible and no `controlsLength` was attached.
  const mkLookupPacket = (): Packet => ({
    name: "LookupLen",
    rowBits: 32,
    body: [
      { id: "lenCode", name: "Len Code", type: { kind: "bits", n: 8 } },
      {
        kind: "bounded",
        id: "payloadArea",
        bytes: lookup(ref("lenCode"), { 0: 4, 1: 8, 2: 16 }),
        fields: [
          { id: "payload", name: "Payload", type: { kind: "bits", n: 8 } },
        ],
      },
    ],
  });

  it("attaches controlsLength on the lookup-key field", () => {
    const packet = psdlToRenderer(mkLookupPacket());
    const lenCode = packet.fields.find((f) => f.id === "lenCode");
    expect(lenCode).toBeDefined();
    expect(lenCode!.controlsLength).toBe("lenCode");
    // bits=8 → max widened to 2**8 - 1.
    expect(lenCode!.max).toBe(255);
  });

  it("leaves no controller when the bounded.bytes mentions two refs", () => {
    const packet = psdlToRenderer({
      name: "TwoRef",
      rowBits: 32,
      body: [
        { id: "a", name: "A", type: { kind: "bits", n: 8 } },
        { id: "b", name: "B", type: { kind: "bits", n: 8 } },
        {
          kind: "bounded",
          id: "area",
          bytes: op("+", lookup(ref("a"), { 0: 1 }), ref("b")),
          fields: [{ id: "p", name: "P", type: { kind: "bits", n: 8 } }],
        },
      ],
    });
    expect(packet.fields.find((f) => f.id === "a")?.controlsLength).toBe(
      undefined,
    );
    expect(packet.fields.find((f) => f.id === "b")?.controlsLength).toBe(
      undefined,
    );
  });
});
