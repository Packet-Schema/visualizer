// PSDL 0.4 — Optional container tests.
//
// Verifies:
//   * normalize emits the inner field iff `when` evaluates truthy;
//   * env-driven `when` via `ref` makes it visible / invisible;
//   * Optional nests cleanly inside Repeat and Encrypted plaintext;
//   * validator rejects malformed `when` and missing inner field.

import { describe, expect, it } from "vitest";
import { lit, op, ref } from "../../lib/psdl/expr";
import { normalize } from "../../lib/psdl/normalize";
import { validatePsdlPacket } from "../../lib/psdl/validate";
import type { Encrypted, Field, Optional, Packet } from "../../lib/psdl/types";

const bits = (n: number) => ({ kind: "bits" as const, n });

function mkInner(): Field {
  return { id: "opt", name: "Maybe", type: bits(16) };
}

function mkOptional(overrides: Partial<Optional> = {}): Optional {
  return {
    kind: "optional",
    id: "maybeOpt",
    when: lit(1),
    field: mkInner(),
    ...overrides,
  };
}

function mkPacket(o: Optional, extras: Packet["body"] = []): Packet {
  return { name: "WithOptional", rowBits: 32, body: [...extras, o] };
}

describe("normalize — Optional", () => {
  it("emits the inner field when `when` evaluates truthy (lit 1)", () => {
    const n = normalize(mkPacket(mkOptional({ when: lit(1) })));
    expect(n.fields.map((f) => f.id)).toEqual(["opt"]);
    expect(n.fields[0].bits).toBe(16);
    expect(n.totalBits).toBe(16);
  });

  it("emits nothing when `when` evaluates falsy (lit 0)", () => {
    const n = normalize(mkPacket(mkOptional({ when: lit(0) })));
    expect(n.fields).toEqual([]);
    expect(n.totalBits).toBe(0);
  });

  it("ref-based `when` reads from env truthy", () => {
    const o = mkOptional({ when: ref("flag") });
    const n = normalize(mkPacket(o), new Map([["flag", 1]]));
    expect(n.fields.length).toBe(1);
  });

  it("ref-based `when` reads from env falsy", () => {
    const o = mkOptional({ when: ref("flag") });
    const n = normalize(mkPacket(o), new Map([["flag", 0]]));
    expect(n.fields.length).toBe(0);
  });

  it("`when` can be a compound op expression", () => {
    const o = mkOptional({ when: op("-", ref("a"), ref("b")) });
    const present = normalize(
      mkPacket(o),
      new Map([
        ["a", 5],
        ["b", 2],
      ]),
    );
    expect(present.fields.length).toBe(1);
    const absent = normalize(
      mkPacket(o),
      new Map([
        ["a", 3],
        ["b", 3],
      ]),
    );
    expect(absent.fields.length).toBe(0);
  });

  it("respects ordering when a preceding fixed field sets bit offset", () => {
    const head: Field = { id: "head", name: "Head", type: bits(8) };
    const n = normalize(mkPacket(mkOptional({ when: lit(1) }), [head]));
    expect(n.fields.map((f) => f.id)).toEqual(["head", "opt"]);
    expect(n.fields[1].absoluteBitOffset).toBe(8);
  });

  it("Optional nested inside a Repeat element expands per copy", () => {
    const o = mkOptional({ when: lit(1) });
    const p: Packet = {
      name: "RepWithOpt",
      rowBits: 32,
      body: [
        {
          kind: "repeat",
          id: "r",
          count: lit(3),
          element: { id: "el", fields: [o] },
        },
      ],
    };
    const n = normalize(p);
    // Each repetition tags the emitted field with its index so the cell
    // renderer can keep unique React keys across copies. Without this the
    // diagram would silently drop or duplicate cells.
    expect(n.fields.length).toBe(3);
    expect(n.fields.map((f) => f.id)).toEqual(["opt#0", "opt#1", "opt#2"]);
  });

  it("Optional nested inside Encrypted plaintext (semantic mode)", () => {
    const enc: Encrypted = {
      kind: "encrypted",
      id: "enc",
      contextNote: "TLS 1.3 keys",
      plaintext: {
        id: "pt",
        fields: [
          { id: "hdr", name: "Hdr", type: bits(8) },
          mkOptional({ when: lit(1) }),
        ],
      },
    };
    const n = normalize(
      { name: "EncOpt", rowBits: 32, body: [enc] },
      new Map(),
      {
        viewMode: "semantic",
      },
    );
    expect(n.fields.map((f) => f.id)).toEqual(["hdr", "opt"]);
    expect(n.fields[1].encryptedParentId).toBe("enc");
  });
});

describe("validatePsdlPacket — Optional", () => {
  it("accepts a well-formed optional", () => {
    expect(() => validatePsdlPacket(mkPacket(mkOptional()))).not.toThrow();
  });

  it("rejects a malformed `when` expression", () => {
    const bad = {
      ...mkOptional(),
      when: { kind: "nope" },
    } as unknown as Optional;
    expect(() => validatePsdlPacket(mkPacket(bad))).toThrow(
      /'when' expression/,
    );
  });

  it("rejects a missing inner field", () => {
    const bad = { ...mkOptional(), field: undefined } as unknown as Optional;
    expect(() => validatePsdlPacket(mkPacket(bad))).toThrow(
      /missing inner field/,
    );
  });

  it("rejects an inner field with no type", () => {
    const bad = {
      ...mkOptional(),
      field: { id: "x", name: "X" } as unknown as Field,
    };
    expect(() => validatePsdlPacket(mkPacket(bad))).toThrow(/missing a type/);
  });
});
