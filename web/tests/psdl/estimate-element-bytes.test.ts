// `estimateElementBytes` decides how many records a budget-driven repeat
// renders: the caller computes `floor((budget - prefix) / perRecordBytes)`.
// Two hand-tuned allowances sit inside it and pull in OPPOSITE directions —
// 64 bytes over-counts (safe: records under-fill), 1 byte under-counts (the
// TLV case, deliberately traded for a slider that tracks the budget). Nothing
// asserted on the arithmetic directly, so an allowance could drift and every
// whole-pipeline test would still pass. These pin it.
import { describe, expect, it } from "vitest";

import {
  estimateElementBytes,
  REF_SIZED_FIELD_BYTE_ALLOWANCE,
} from "@/lib/psdl/psdl-to-renderer/repeats-and-budgets";
import type { Container } from "@/lib/psdl/types";

const int = (id: string, bits: number, category?: string) =>
  ({
    id,
    name: id,
    ...(category ? { category } : {}),
    type: { kind: "int", bits },
  }) as unknown as Container;

const bytesRef = (id: string, field: string) =>
  ({
    id,
    name: id,
    type: { kind: "bytes", n: { kind: "ref", field } },
  }) as unknown as Container;

const varint = (id: string) =>
  ({ id, name: id, type: { kind: "varint" } }) as unknown as Container;

describe("estimateElementBytes", () => {
  it("sums fixed-width leaves and rounds up to whole bytes", () => {
    expect(estimateElementBytes({ fields: [int("a", 8), int("b", 16)] })).toBe(
      3,
    );
    // 4 + 4 + 1 bits = 9 → 2 bytes.
    expect(
      estimateElementBytes({
        fields: [int("a", 4), int("b", 4), int("c", 1)],
      }),
    ).toBe(2);
  });

  it("floors at one byte", () => {
    expect(estimateElementBytes({ fields: [] })).toBe(1);
  });

  it("charges the full allowance for a truly unbounded leaf", () => {
    // A varint has no sibling length to bound it, so it takes the 64-byte
    // over-count that keeps the derived record count conservative.
    expect(estimateElementBytes({ fields: [varint("v")] })).toBe(64);
  });

  it("charges only the structural size when a value is sized by a SIBLING length", () => {
    // The TLV idiom: `bytes(ref tlvLength)` where `tlvLength` is in the same
    // record. The smallest legal record has an empty value, so charging the
    // full allowance would make the slider move in ~66-byte plateaus.
    const record = {
      fields: [
        int("tlvType", 8),
        int("tlvLength", 8, "length"),
        bytesRef("tlvValue", "tlvLength"),
      ],
    };
    expect(estimateElementBytes(record)).toBe(
      2 + REF_SIZED_FIELD_BYTE_ALLOWANCE,
    );
  });

  it("keeps the full allowance when the length ref is NOT a sibling", () => {
    // This is the boundary the two constants divide. A value sized from
    // outside the record is unbounded as far as the record is concerned, so it
    // must stay on the conservative side — otherwise the derived count can
    // exceed the budget and the scope over-consumes.
    const record = {
      fields: [int("tlvType", 8), bytesRef("tlvValue", "someOuterLength")],
    };
    expect(estimateElementBytes(record)).toBe(1 + 64);
  });

  it("takes the largest switch arm, not the sum", () => {
    const record = {
      fields: [
        int("kind", 8),
        {
          kind: "switch",
          id: "body",
          on: { kind: "ref", field: "kind" },
          cases: {
            "1": { id: "small", fields: [int("s", 8)] },
            "2": { id: "big", fields: [int("b1", 32), int("b2", 32)] },
          },
        } as unknown as Container,
      ],
    };
    expect(estimateElementBytes(record)).toBe(1 + 8);
  });

  it("descends transparent containers and ignores repeat/encrypted", () => {
    const grouped = {
      fields: [
        {
          kind: "group",
          id: "g",
          children: [int("a", 8), int("b", 8)],
        } as unknown as Container,
      ],
    };
    expect(estimateElementBytes(grouped)).toBe(2);

    // A nested repeat contributes 0 — its own budget governs it, and counting
    // it here would double-charge the enclosing estimate.
    const withRepeat = {
      fields: [
        int("a", 8),
        {
          kind: "repeat",
          id: "r",
          element: { id: "e", fields: [int("x", 32)] },
          count: "eos",
        } as unknown as Container,
      ],
    };
    expect(estimateElementBytes(withRepeat)).toBe(1);
  });
});
