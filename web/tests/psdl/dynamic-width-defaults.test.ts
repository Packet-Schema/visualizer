// override-design-audit: core gives a varint or delimiter-terminated `bytes`
// field 0 bits when its width env key is unset, so it renders as NO cell —
// invisible, with its width picker (on the missing cell) unreachable. The seed
// gives them a representative default width so they always paint.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv, berLenEnvKey } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { seedDynamicWidthDefaults } from "@/lib/psdl/dynamic-width-defaults";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

function buildEnv(src: PsdlPacket, overrides: Record<string, number> = {}) {
  const env = new Map<string, number>(Object.entries(overrides));
  for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
  seedDynamicWidthDefaults(src, env);
  return env;
}

function cellIds(src: PsdlPacket, overrides: Record<string, number> = {}) {
  return resolveLayout(src, { env: buildEnv(src, overrides) }).cells.map(
    (c) => c.field.id,
  );
}

/** Resolved wire bits of a leaf, looked up across cells AND group subfields. */
function leafBits(
  src: PsdlPacket,
  leafId: string,
  overrides: Record<string, number> = {},
): number | undefined {
  for (const c of resolveLayout(src, { env: buildEnv(src, overrides) }).cells) {
    if (c.field.id === leafId && !c.field.subfields) return c.field.bits;
    for (const sf of c.field.subfields ?? []) {
      if (sf.id === leafId) return sf.bits;
    }
  }
  return undefined;
}

describe("seedDynamicWidthDefaults", () => {
  it("makes varint fields visible on default load (http3Frame)", () => {
    const ids = cellIds(PRESETS.http3Frame!);
    expect(ids).toContain("http3FrameType");
    expect(ids).toContain("http3PayloadLength");
  });

  it("makes switch-nested varints visible when their case is active (quicLong)", () => {
    // length lives in the longPacketType cases; selecting one paints it.
    const ids = cellIds(PRESETS.quicLong!, { longPacketType: 0 });
    expect(ids).toContain("length");
  });

  it("makes delimiter-terminated bytes fields visible (syslog)", () => {
    expect(cellIds(PRESETS.syslog!)).toContain("hostname");
  });

  it("makes a delimited-bytes leaf inside a ref-expanded def visible & editable", () => {
    // Arbitrary (non-preset) PSDL: a delimiter-terminated `bytes` leaf declared
    // in a `defs` entry reached via {kind:ref}. Before the fix the ref container
    // was skipped by both the seed and the bridge, so the leaf got 0 bits from
    // core and rendered NO cell — see-but-cannot-edit (bar #2 violation).
    const src: PsdlPacket = {
      name: "t",
      rowBits: 32,
      defs: {
        rec: {
          fields: [
            { id: "recName", type: { kind: "bytes", n: { delimiter: [0] } } },
            { id: "recVal", type: { kind: "int", bits: 8 } },
          ],
        },
      },
      body: [
        { id: "hdr", type: { kind: "int", bits: 8 } },
        { kind: "ref", ref: "rec" },
      ],
    } as unknown as PsdlPacket;
    // Default load paints the delimited leaf at the seeded width.
    expect(cellIds(src)).toContain("recName");
    // It is editable: a wider env value drives a wider cell.
    const env = new Map<string, number>([["recName", 6]]);
    for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
    for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
    seedDynamicWidthDefaults(src, env);
    const cell = resolveLayout(src, { env }).cells.find((c) =>
      c.field.id.endsWith("recName"),
    );
    expect(cell?.field.bits).toBe(6 * 8);
  });

  it("makes a varint leaf inside a ref-expanded def visible & editable", () => {
    const src: PsdlPacket = {
      name: "t",
      rowBits: 32,
      defs: {
        rec: {
          fields: [
            { id: "vlen", type: { kind: "varint", encoding: "leb128" } },
          ],
        },
      },
      body: [
        { id: "h", type: { kind: "int", bits: 8 } },
        { kind: "ref", ref: "rec" },
      ],
    } as unknown as PsdlPacket;
    expect(cellIds(src)).toContain("vlen");
    // Editable: the bare-id override is bridged to `__varintBits__vlen`.
    const env = new Map<string, number>([["vlen", 24]]);
    for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
    for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
    seedDynamicWidthDefaults(src, env);
    const cell = resolveLayout(src, { env }).cells.find((c) =>
      c.field.id.endsWith("vlen"),
    );
    expect(cell?.field.bits).toBe(24);
  });

  it("makes berLength octets that ALSO size a sibling bytes(ref) visible (snmpV2c)", () => {
    // versionValue = bytes(ref versionLength); communityValue = bytes(ref
    // communityLength). PacketViewer 0-seeds every psdlRef, so env[versionLength]
    // = env[communityLength] = 0; before the fix the bridge copied that 0 onto
    // __berLen__<id>, collapsing the BER length octet to 0 bits — invisible, with
    // its WidthPicker (on the missing cell) unreachable. The dedicated-key seed
    // keeps the octet at its 1-byte (8-bit) default regardless of the bare 0.
    const src = PRESETS.snmpV2c!;
    expect(leafBits(src, "versionLength")).toBeGreaterThan(0);
    expect(leafBits(src, "communityLength")).toBeGreaterThan(0);
    // msgLength is a berLength that does NOT directly size a bytes(ref), so it
    // was never 0-seeded; it stays visible too.
    expect(leafBits(src, "msgLength")).toBeGreaterThan(0);
    // The bare key is the length VALUE that sizes the sibling, NOT the octet
    // width: seeding the octet must not inflate versionValue (which stays 0 until
    // the user raises the length value).
    expect(leafBits(src, "versionValue")).toBe(0);
  });

  it("the BER length octet width is editable via the dedicated key (snmpV2c)", () => {
    // The WidthPicker drives `__berLen__<id>` (not env[id], whose bare value
    // sizes the sibling), so a wider octet renders without touching the value.
    const src = PRESETS.snmpV2c!;
    const wider = { [berLenEnvKey("versionLength")]: 16 };
    expect(leafBits(src, "versionLength", wider)).toBe(16);
    expect(leafBits(src, "versionValue", wider)).toBe(0);
  });

  it("a user-set width still wins over the seed", () => {
    // `http3PayloadLength` is a plain (non-discriminator) varint whose env key
    // legitimately doubles as its wire width. Setting it to 2 bytes (16 bits)
    // must render 16, not the 8 seed. (`http3FrameType` can't carry a width here
    // because it is also the frame-payload switch discriminator — its width is
    // decoupled onto `__varintBits__http3FrameType`.)
    const env = new Map<string, number>([["http3PayloadLength", 16]]);
    const src = PRESETS.http3Frame!;
    for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
    for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
    seedDynamicWidthDefaults(src, env);
    const cell = resolveLayout(src, { env }).cells.find(
      (c) => c.field.id === "http3PayloadLength",
    );
    expect(cell?.field.bits).toBe(16);
  });
});
