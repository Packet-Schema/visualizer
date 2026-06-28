// override-design-audit: core gives a varint or delimiter-terminated `bytes`
// field 0 bits when its width env key is unset, so it renders as NO cell —
// invisible, with its width picker (on the missing cell) unreachable. The seed
// gives them a representative default width so they always paint.

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { seedDynamicWidthDefaults } from "@/lib/psdl/dynamic-width-defaults";
import type { Packet as PsdlPacket } from "@/lib/psdl/types";

function cellIds(src: PsdlPacket, overrides: Record<string, number> = {}) {
  const env = new Map<string, number>(Object.entries(overrides));
  for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
  seedDynamicWidthDefaults(src, env);
  return resolveLayout(src, { env }).cells.map((c) => c.field.id);
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
