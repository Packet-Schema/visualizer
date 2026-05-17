import { describe, expect, it } from "vitest";

import { PRESETS } from "../../lib/psml/presets";
import {
  initialState,
  syncChainControllers,
} from "../../lib/psml/renderer-helpers";
import { psmlToRenderer } from "../../lib/psml/psml-to-renderer";

describe("renderer helper controller state", () => {
  it("seeds IPv6 chain repeat count refs", () => {
    const packet = psmlToRenderer(PRESETS.ipv6);
    const state = initialState(packet);

    expect(state.nextHeader_chainCount).toBe(0);
    expect(state.nextHeader_proto).toBe(59);
  });

  it("syncs IPv6 chain edits into PSML env keys", () => {
    const packet = psmlToRenderer(PRESETS.ipv6);
    const chainField = packet.fields.find((field) => field.chainCatalog);
    expect(chainField).toBeDefined();

    chainField!.chainInstances = [{ proto: 0 }];
    const state = syncChainControllers(packet, {});

    expect(state.nextHeader_chainCount).toBe(1);
    expect(state.nextHeader_proto).toBe(0);
  });
});
