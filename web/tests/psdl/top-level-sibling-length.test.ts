// high (see-but-cannot-edit): a plain `length`-category int/bits cell that lives
// at the TOP LEVEL and directly sizes a sibling `bytes(ref <thisId>)` value used
// to render as a read-only cell — it never got a `controlsLength` stamp, so
// OverridePanel showed the EmptyState ("no runtime override. Read-only display")
// while the sized variable region was fully VISIBLE on the diagram and
// `env[<thisId>]` genuinely drove its width.
//
//   quicLong:    dcidLength → dcid (64b default), scidLength → scid (64b)
//   mqttConnect: protocolNameLength → protocolName ("MQTT", 32b)
//   arp:         hlen → sha/tha, plen → spa/tpa
//
// collectSiblingLengthControllers already FOUND these ids, but the wiring
// deliberately SKIPPED any id that was also a top-level mirror cell, on the
// false assumption that the cell was editable. The fix stamps `controlsLength`
// onto the existing top-level cell (the same slider IHL / Data Offset get)
// instead of skipping it, so the visible region becomes resizable.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

/** Wire bits of the laid-out cell whose field id matches, for a given env. */
function cellBits(
  psdl: PsdlPacket,
  fieldId: string,
  overrides: Record<string, number>,
): number | undefined {
  const env = new Map<string, number>(Object.entries(overrides));
  for (const [k, v] of initialEnv(psdl)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  const cell = resolveLayout(psdl, { env }).cells.find(
    (c) => c.field?.id === fieldId,
  );
  return cell?.bitsTotal;
}

describe("top-level sibling-length cell becomes editable", () => {
  it("quicLong dcidLength/scidLength carry controlsLength on their own cell", () => {
    const mirror = psdlToRenderer(PRESETS.quicLong!);
    for (const id of ["dcidLength", "scidLength"]) {
      const field = mirror.fields.find((f) => f.id === id);
      expect(field, `${id} should be a top-level cell`).toBeDefined();
      // The slider lives ON the existing cell, not as a separate packet-level
      // lengthController (it IS a top-level renderer field).
      expect(field!.controlsLength).toBe(id);
      expect(field!.bits).toBe(8);
      expect(field!.max).toBe(255);
      expect((mirror.lengthControllers ?? []).some((l) => l.id === id)).toBe(
        false,
      );
    }
  });

  it("moving the dcidLength slider resizes the visible dcid region", () => {
    const psdl = PRESETS.quicLong!;
    // Default env renders dcid at 64 bits; lowering the length must shrink it.
    expect(cellBits(psdl, "dcid", {})).toBe(64);
    expect(cellBits(psdl, "dcid", { dcidLength: 5 })).toBe(40);
    // ...and scidLength independently drives scid.
    expect(cellBits(psdl, "scid", {})).toBe(64);
    expect(cellBits(psdl, "scid", { scidLength: 3 })).toBe(24);
  });

  it("mqttConnect protocolNameLength/clientIdLength control their own cells", () => {
    const mirror = psdlToRenderer(PRESETS.mqttConnect!);
    for (const id of ["protocolNameLength", "clientIdLength"]) {
      const field = mirror.fields.find((f) => f.id === id);
      expect(field, `${id} should be a top-level cell`).toBeDefined();
      expect(field!.controlsLength).toBe(id);
      expect((mirror.lengthControllers ?? []).some((l) => l.id === id)).toBe(
        false,
      );
    }
  });

  it("moving protocolNameLength resizes the protocolName cell", () => {
    const psdl = PRESETS.mqttConnect!;
    expect(cellBits(psdl, "protocolName", {})).toBe(32);
    expect(cellBits(psdl, "protocolName", { protocolNameLength: 2 })).toBe(16);
  });

  it("arp hlen/plen control their own cells", () => {
    const mirror = psdlToRenderer(PRESETS.arp!);
    for (const id of ["hlen", "plen"]) {
      const field = mirror.fields.find((f) => f.id === id);
      expect(field!.controlsLength).toBe(id);
    }
  });

  it("never re-keys a discriminator cell whose env drives a switch/enum", () => {
    // Guard: the sibling-length stamp only lands on a PLAIN length cell. A cell
    // that the user already drives as a switch/enum discriminator
    // (`switchCases` / `enumVariants`) must keep that widget — selecting a
    // variant, not a length, is what changes the diagram there. So no preset may
    // surface a top-level cell that self-controls length AND is a discriminator
    // (the two would fight for the same env id).
    for (const [, psdl] of Object.entries(PRESETS)) {
      const mirror = psdlToRenderer(psdl);
      for (const f of mirror.fields) {
        if (f.controlsLength === f.id) {
          expect(f.switchCases).toBeUndefined();
          expect(f.enumVariants).toBeUndefined();
        }
      }
    }
  });
});
