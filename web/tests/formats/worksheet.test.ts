// Worksheet helpers — covers buildWorksheetPayload's flattening and offset
// math, the WORKSHEET_TYPST_SOURCE template's structural contents (packet
// name placeholder, the fill-row table), and the Node-side guard that
// generateWorksheetPdf throws when no browser environment is available.

import { describe, expect, it } from "vitest";

import {
  buildWorksheetPayload,
  generateWorksheetPdf,
} from "../../lib/worksheet-typst";
import { WORKSHEET_TYPST_SOURCE } from "../../lib/worksheet-template";
import { initialEnv } from "../../lib/psml/normalize";
import { MANUAL_PRESETS } from "../../lib/psml/presets";
import { GENERATED_PRESETS } from "../../lib/psml/presets.generated";

describe("buildWorksheetPayload", () => {
  it("emits name, description, and a flat field list for UDP", () => {
    const udp = MANUAL_PRESETS.udp;
    const payload = buildWorksheetPayload(udp, initialEnv(udp));
    expect(payload.name).toBe(udp.name);
    expect(payload.description).toBe(udp.description);
    expect(payload.fields).toHaveLength(4);
    expect(payload.fields.map((f) => f.id)).toEqual([
      "srcPort",
      "dstPort",
      "length",
      "checksum",
    ]);
    expect(payload.fields.map((f) => f.bits)).toEqual([16, 16, 16, 16]);
    expect(payload.fields.map((f) => f.offset)).toEqual([0, 16, 32, 48]);
  });

  it("includes per-field bits and offsets (the answer-key payload)", () => {
    const ethernet = MANUAL_PRESETS.ethernet;
    const payload = buildWorksheetPayload(ethernet);
    // dstMac (48), srcMac (48), etherType (16)
    expect(payload.fields).toHaveLength(3);
    expect(payload.fields[0]).toMatchObject({
      id: "dstMac",
      bits: 48,
      offset: 0,
    });
    expect(payload.fields[2]).toMatchObject({
      id: "etherType",
      bits: 16,
      offset: 96,
    });
  });

  it("handles a preset whose layout segments span row boundaries", () => {
    // IPv6 has 64-bit srcAddr / dstAddr spanning two 32-bit rows each.
    const ipv6 = GENERATED_PRESETS.ipv6;
    const env = initialEnv(ipv6);
    env.set("nextHeader_chainCount", 0);
    env.set("nextHeader_proto", 0);
    const payload = buildWorksheetPayload(ipv6, env);
    // Field offsets are monotonically increasing.
    let prev = -1;
    for (const f of payload.fields) {
      expect(f.offset).toBeGreaterThan(prev);
      prev = f.offset;
    }
    // The sum of bits equals the total layout bits.
    const total = payload.fields.reduce((a, f) => a + f.bits, 0);
    expect(total).toBe(320);
  });

  it("preserves an empty description when the packet has none", () => {
    const payload = buildWorksheetPayload({
      name: "Bare",
      rowBits: 8,
      body: [{ id: "x", name: "X", type: { kind: "bits", n: 8 } }],
    });
    expect(payload.description).toBe("");
  });
});

describe("WORKSHEET_TYPST_SOURCE template", () => {
  it("references the packet name and a fields list", () => {
    expect(WORKSHEET_TYPST_SOURCE).toContain("packet.name");
    expect(WORKSHEET_TYPST_SOURCE).toContain("packet.fields");
  });

  it("renders a fill-in table with as many rows as fields (via enumerate)", () => {
    // The template uses `packet.fields.enumerate().map(...)` to produce one
    // table row per field, plus a header row.
    expect(WORKSHEET_TYPST_SOURCE).toContain("packet.fields.enumerate()");
    expect(WORKSHEET_TYPST_SOURCE).toContain("table.header");
  });

  it("toggles the worksheet/answer-key badge from the answers flag", () => {
    expect(WORKSHEET_TYPST_SOURCE).toContain('ANSWER KEY');
    expect(WORKSHEET_TYPST_SOURCE).toContain('WORKSHEET');
    expect(WORKSHEET_TYPST_SOURCE).toContain("answers");
  });

  it("uses a blank fill string for the worksheet mode", () => {
    expect(WORKSHEET_TYPST_SOURCE).toContain('let blank = "______"');
  });
});

describe("generateWorksheetPdf — Node guard", () => {
  it("throws the documented browser-only error when run in Node", async () => {
    const udp = MANUAL_PRESETS.udp;
    await expect(generateWorksheetPdf(udp, initialEnv(udp))).rejects.toThrow(
      /WASM-backed compilation requires a browser environment/,
    );
  });

  it("the same error message also fires with the answers option toggled", async () => {
    const udp = MANUAL_PRESETS.udp;
    await expect(
      generateWorksheetPdf(udp, initialEnv(udp), { answers: true }),
    ).rejects.toThrow(/WASM-backed compilation/);
  });
});
