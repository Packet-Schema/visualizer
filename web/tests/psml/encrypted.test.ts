// PSML 0.3 — Encrypted container tests.
//
// Verifies the two view-mode branches of `normalize`:
//   * wire mode collapses to a single virtual field tagged `encrypted: true`;
//   * semantic mode expands plaintext fields, tagging each with
//     `encryptedParentId` and (when listed) `headerProtected: true`.
// Also verifies the layout adapter propagates the flags onto produced cells,
// and that the schema validator rejects malformed shapes.

import { describe, expect, it } from "vitest";
import { lit, op, ref } from "../../lib/psml/expr";
import { normalize } from "../../lib/psml/normalize";
import { resolveLayout } from "../../lib/psml/layout";
import { validatePsmlPacket } from "../../lib/psml/validate";
import type { Encrypted, Packet, Struct } from "../../lib/psml/types";

const bits = (n: number) => ({ kind: "bits" as const, n });

const samplePlaintext: Struct = {
  id: "qpkt",
  fields: [
    { id: "pn", name: "Packet Number", type: bits(32) },
    { id: "frame_type", name: "Frame Type", type: bits(8) },
    { id: "body", name: "Body", type: bits(56) },
  ],
};

function mkEncrypted(overrides: Partial<Encrypted> = {}): Encrypted {
  return {
    kind: "encrypted",
    id: "enc",
    name: "Protected Payload",
    plaintext: samplePlaintext,
    contextNote: "TLS 1.3 handshake keys",
    headerProtected: ["pn"],
    ...overrides,
  };
}

function mkPacket(enc: Encrypted): Packet {
  return { name: "QuicShort", rowBits: 32, body: [enc] };
}

describe("normalize — Encrypted (wire mode)", () => {
  it("emits one virtual field equal to wireBits when provided", () => {
    const enc = mkEncrypted({ wireBits: lit(128) });
    const n = normalize(mkPacket(enc));
    expect(n.fields.length).toBe(1);
    const f = n.fields[0];
    expect(f.id).toBe("enc");
    expect(f.bits).toBe(128);
    expect(f.encrypted).toBe(true);
    expect(f.encryptedContextNote).toBe("TLS 1.3 handshake keys");
    expect(f.headerProtected).toBeUndefined();
    expect(n.totalBits).toBe(128);
  });

  it("evaluates wireBits against the env", () => {
    const enc = mkEncrypted({ wireBits: op("*", ref("blocks"), lit(64)) });
    const n = normalize(mkPacket(enc), new Map([["blocks", 4]]));
    expect(n.fields[0].bits).toBe(256);
  });

  it("falls back to summing plaintext bits when wireBits is absent", () => {
    const enc = mkEncrypted(); // no wireBits
    const n = normalize(mkPacket(enc));
    // 32 + 8 + 56 = 96
    expect(n.fields.length).toBe(1);
    expect(n.fields[0].bits).toBe(96);
    expect(n.fields[0].encrypted).toBe(true);
  });

  it("default mode is 'wire'", () => {
    const enc = mkEncrypted({ wireBits: lit(64) });
    const a = normalize(mkPacket(enc));
    const b = normalize(mkPacket(enc), new Map(), { viewMode: "wire" });
    expect(a).toEqual(b);
  });
});

describe("normalize — Encrypted (semantic mode)", () => {
  it("expands plaintext.fields and tags each with encryptedParentId", () => {
    const enc = mkEncrypted();
    const n = normalize(mkPacket(enc), new Map(), { viewMode: "semantic" });
    expect(n.fields.map((f) => f.id)).toEqual(["pn", "frame_type", "body"]);
    for (const f of n.fields) {
      expect(f.encryptedParentId).toBe("enc");
      expect(f.encryptedContextNote).toBe("TLS 1.3 handshake keys");
    }
    expect(n.totalBits).toBe(32 + 8 + 56);
  });

  it("propagates headerProtected: true for listed ids only", () => {
    const enc = mkEncrypted({ headerProtected: ["pn"] });
    const n = normalize(mkPacket(enc), new Map(), { viewMode: "semantic" });
    const pn = n.fields.find((f) => f.id === "pn")!;
    const ft = n.fields.find((f) => f.id === "frame_type")!;
    expect(pn.headerProtected).toBe(true);
    expect(ft.headerProtected).toBeUndefined();
  });

  it("emits no encrypted flags on plaintext fields", () => {
    const enc = mkEncrypted();
    const n = normalize(mkPacket(enc), new Map(), { viewMode: "semantic" });
    for (const f of n.fields) {
      expect(f.encrypted).toBeUndefined();
    }
  });

  it("works when Encrypted is nested inside a Group", () => {
    const enc = mkEncrypted();
    const p: Packet = {
      name: "Nested",
      rowBits: 32,
      body: [
        {
          kind: "group",
          id: "outer",
          children: [{ id: "header", name: "Header", type: bits(8) }, enc],
        },
      ],
    };
    const w = normalize(p);
    expect(w.fields.map((f) => f.id)).toEqual(["header", "enc"]);
    const s = normalize(p, new Map(), { viewMode: "semantic" });
    expect(s.fields.map((f) => f.id)).toEqual([
      "header",
      "pn",
      "frame_type",
      "body",
    ]);
    expect(s.fields[0].encryptedParentId).toBeUndefined();
    expect(s.fields[1].encryptedParentId).toBe("enc");
  });
});

describe("resolveLayout — Encrypted decoration", () => {
  it("propagates encrypted=true onto every cell of the virtual wire field", () => {
    const enc = mkEncrypted({ wireBits: lit(64) });
    const layout = resolveLayout(mkPacket(enc));
    expect(layout.cells.length).toBeGreaterThan(0);
    for (const cell of layout.cells) {
      expect(cell.encrypted).toBe(true);
      expect(cell.encryptedContextNote).toBe("TLS 1.3 handshake keys");
    }
  });

  it("propagates headerProtected onto cells in semantic mode", () => {
    const enc = mkEncrypted();
    const layout = resolveLayout(mkPacket(enc), { viewMode: "semantic" });
    const pnCells = layout.cells.filter((c) => c.field.id === "pn");
    const ftCells = layout.cells.filter((c) => c.field.id === "frame_type");
    expect(pnCells.length).toBeGreaterThan(0);
    for (const c of pnCells) {
      expect(c.headerProtected).toBe(true);
      expect(c.encryptedParentId).toBe("enc");
    }
    for (const c of ftCells) {
      expect(c.headerProtected).toBeUndefined();
      expect(c.encryptedParentId).toBe("enc");
    }
  });
});

describe("validatePsmlPacket — Encrypted", () => {
  it("accepts a well-formed encrypted container", () => {
    expect(() => validatePsmlPacket(mkPacket(mkEncrypted()))).not.toThrow();
  });

  it("rejects empty plaintext", () => {
    const enc = mkEncrypted({ plaintext: { id: "p", fields: [] } });
    expect(() => validatePsmlPacket(mkPacket(enc))).toThrow(
      /at least one field/,
    );
  });

  it("rejects missing plaintext", () => {
    const enc = {
      ...mkEncrypted(),
      plaintext: undefined,
    } as unknown as Encrypted;
    expect(() => validatePsmlPacket(mkPacket(enc))).toThrow(
      /missing plaintext/,
    );
  });

  it("rejects non-Struct plaintext (no fields array)", () => {
    const enc = {
      ...mkEncrypted(),
      plaintext: { id: "p" },
    } as unknown as Encrypted;
    expect(() => validatePsmlPacket(mkPacket(enc))).toThrow();
  });

  it("rejects a headerProtected id that doesn't appear inside plaintext", () => {
    const enc = mkEncrypted({ headerProtected: ["does_not_exist"] });
    expect(() => validatePsmlPacket(mkPacket(enc))).toThrow(
      /does not name a field/,
    );
  });

  it("rejects a malformed wireBits expression", () => {
    const enc = mkEncrypted({
      wireBits: { kind: "bogus" } as unknown as never,
    });
    expect(() => validatePsmlPacket(mkPacket(enc))).toThrow(
      /wireBits is malformed/,
    );
  });

  it("rejects an empty contextNote", () => {
    const enc = mkEncrypted({ contextNote: "" });
    expect(() => validatePsmlPacket(mkPacket(enc))).toThrow(/contextNote/);
  });

  it("rejects a non-array headerProtected", () => {
    const enc = {
      ...mkEncrypted(),
      headerProtected: "pn",
    } as unknown as Encrypted;
    expect(() => validatePsmlPacket(mkPacket(enc))).toThrow(/must be an array/);
  });
});
