import { describe, expect, it } from "vitest";

import { PRESETS } from "../../lib/psdl/presets";
import {
  initialState,
  syncChainControllers,
} from "../../lib/psdl/renderer-helpers";
import { psdlToRenderer } from "../../lib/psdl/psdl-to-renderer";

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
