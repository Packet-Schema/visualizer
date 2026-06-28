import { describe, expect, it } from "vitest";

import { PRESETS } from "../../lib/psdl/presets.server";
import {
  controllersFromEnv,
  initialState,
  nonDefaultControllerEnv,
  syncChainControllers,
} from "../../lib/psdl/renderer-helpers";
import { psdlToRenderer } from "../../lib/psdl/psdl-to-renderer";
import { lookup, op, ref } from "../../lib/psdl/expr";
import type { Packet, PsdlPacket } from "../../lib/psdl/types";

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

describe("save-as-preset env round-trip (audit MEDIUM #1)", () => {
  // A free eos repeat — surfaced by collectFreeRepeats with defaultCount 1,
  // the same shape as "dnsResponse with dnsAnCount=3".
  const mkRepeatPacket = (): PsdlPacket => ({
    name: "DnsLike",
    rowBits: 8,
    body: [
      {
        kind: "repeat",
        id: "answers",
        element: {
          id: "answer",
          fields: [
            { id: "rtype", name: "RType", type: { kind: "int", bits: 16 } },
          ],
        },
        count: "eos",
      },
    ],
  });

  it("nonDefaultControllerEnv keeps only the user's edits, dropping defaults", () => {
    const rendered = psdlToRenderer(mkRepeatPacket());
    const defaults = initialState(rendered);

    // No edits → no env block.
    expect(nonDefaultControllerEnv(rendered, defaults)).toBeUndefined();

    // User picks a count of 3 → only that key is baked.
    const env = nonDefaultControllerEnv(rendered, { ...defaults, answers: 3 });
    expect(env).toEqual({ answers: 3 });
  });

  it("nonDefaultControllerEnv drops a controller left at its seeded default", () => {
    // isisLsp's `pduLength` length controller seeds a concrete default (its
    // `defaultLength` = prefix + perRecordBytes, now 34 since perRecordBytes also
    // charges the seeded switch-arm value `tlvValue = bytes(ref tlvLength)`); an
    // unchanged value must not be baked (Share skips it the same way). (IPv4's
    // `ihl` is intentionally NOT a length controller anymore — its options
    // region is a TLV-shaped bounded scope owned by the `options` TLV editor.)
    const rendered = psdlToRenderer(PRESETS.isisLsp);
    const defaults = initialState(rendered);
    expect(defaults.pduLength).toBe(34);
    // Unchanged → omitted.
    expect(nonDefaultControllerEnv(rendered, defaults)).toBeUndefined();
    // Edited → only the changed key is baked.
    expect(
      nonDefaultControllerEnv(rendered, { ...defaults, pduLength: 40 }),
    ).toEqual({
      pduLength: 40,
    });
  });

  it("controllersFromEnv restores the saved count", () => {
    const rendered = psdlToRenderer(mkRepeatPacket());
    // Reload path: seed controllers from the persisted env block.
    const restored = controllersFromEnv(rendered, { answers: 3 });
    expect(restored.answers).toBe(3);

    // A missing env falls back to the seeded defaults. A top-level eos repeat
    // seeds a representative count of 1 (defaultCount), so `answers` is 1.
    expect(controllersFromEnv(rendered, undefined).answers).toBe(1);
  });

  it("round-trips an env baked onto the packet through both helpers", () => {
    const rendered = psdlToRenderer(mkRepeatPacket());
    const baked = nonDefaultControllerEnv(rendered, {
      ...initialState(rendered),
      answers: 5,
    });
    expect(baked).toEqual({ answers: 5 });
    const restored = controllersFromEnv(rendered, baked);
    expect(restored.answers).toBe(5);
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
