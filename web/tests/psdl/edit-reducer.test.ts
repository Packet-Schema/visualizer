// Tests for the PSDL edit reducer — covers every action variant, undo/redo
// semantics, deep-clone immutability, and the 50-entry history cap.

import { describe, expect, it } from "vitest";
import {
  editReducer,
  makeInitialState,
  HISTORY_LIMIT,
  type EditAction,
  type EditState,
} from "../../lib/psdl/edit-reducer";
import type {
  Constraint,
  Container,
  Field,
  Packet,
  PsdlPacket,
} from "../../lib/psdl/types";

const bits = (n: number) => ({ kind: "bits" as const, n });
const int = (n: number) => ({ kind: "int" as const, bits: n });

function basePacket(): Packet {
  return {
    name: "Test",
    rowBits: 32,
    body: [
      { id: "a", name: "A", type: int(8) },
      { id: "b", name: "B", type: int(8) },
    ],
    constraints: [
      { lhs: { kind: "ref", field: "a" }, rhs: { kind: "lit", value: 1 } },
    ],
  };
}

function apply(state: EditState, action: EditAction): EditState {
  return editReducer(state, action);
}

describe("makeInitialState", () => {
  it("clones the input packet", () => {
    const pkt = basePacket();
    const state = makeInitialState(pkt);
    expect(state.packet).toEqual(pkt);
    expect(state.packet).not.toBe(pkt);
    expect(state.history).toEqual([]);
    expect(state.future).toEqual([]);
  });
});

describe("editReducer — actions", () => {
  it("add-field appends at slot", () => {
    const state = makeInitialState(basePacket());
    const field: Field = { id: "c", name: "C", type: int(8) };
    const next = apply(state, { type: "add-field", at: [2], field });
    expect((next.packet.body[2] as Field).id).toBe("c");
    expect(next.history).toHaveLength(1);
  });

  it("delete-field removes at slot", () => {
    const state = makeInitialState(basePacket());
    const next = apply(state, { type: "delete-field", at: [0] });
    expect(next.packet.body).toHaveLength(1);
    expect((next.packet.body[0] as Field).id).toBe("b");
  });

  it("move-field relocates a slot", () => {
    const state = makeInitialState(basePacket());
    const next = apply(state, { type: "move-field", from: [0], to: [2] });
    expect((next.packet.body[1] as Field).id).toBe("a");
  });

  it("update-field merges a patch", () => {
    const state = makeInitialState(basePacket());
    const next = apply(state, {
      type: "update-field",
      at: [0],
      patch: { name: "Renamed" },
    });
    expect((next.packet.body[0] as Field).name).toBe("Renamed");
    expect((next.packet.body[0] as Field).id).toBe("a");
  });

  it("wrap-in produces a Group / Repeat / Switch / Encrypted / struct", () => {
    let state = makeInitialState(basePacket());
    state = apply(state, { type: "wrap-in", at: [0], kind: "group" });
    expect((state.packet.body[0] as Container).kind).toBe("group");

    state = makeInitialState(basePacket());
    state = apply(state, { type: "wrap-in", at: [0], kind: "repeat" });
    expect((state.packet.body[0] as Container).kind).toBe("repeat");

    state = makeInitialState(basePacket());
    state = apply(state, { type: "wrap-in", at: [0], kind: "switch" });
    expect((state.packet.body[0] as Container).kind).toBe("switch");

    state = makeInitialState(basePacket());
    state = apply(state, { type: "wrap-in", at: [0], kind: "encrypted" });
    expect((state.packet.body[0] as Container).kind).toBe("encrypted");

    state = makeInitialState(basePacket());
    state = apply(state, { type: "wrap-in", at: [0], kind: "struct" });
    expect((state.packet.body[0] as Container).kind).toBe("group");
  });

  it("add-container inserts a non-field container", () => {
    const state = makeInitialState(basePacket());
    const container: Container = {
      kind: "group",
      id: "g",
      children: [{ id: "x", name: "X", type: bits(4) }],
    };
    const next = apply(state, {
      type: "add-container",
      at: [1],
      container,
    });
    expect((next.packet.body[1] as Container).kind).toBe("group");
  });

  it("update-container merges a patch", () => {
    const init = basePacket();
    init.body.push({ kind: "group", id: "g", children: [] });
    const state = makeInitialState(init);
    const next = apply(state, {
      type: "update-container",
      at: [2],
      patch: { name: "Group A" },
    });
    expect((next.packet.body[2] as Container & { name?: string }).name).toBe(
      "Group A",
    );
  });

  it("add-constraint appends", () => {
    const state = makeInitialState(basePacket());
    const c: Constraint = {
      lhs: { kind: "ref", field: "b" },
      rhs: { kind: "lit", value: 2 },
    };
    const next = apply(state, { type: "add-constraint", constraint: c });
    expect(next.packet.constraints).toHaveLength(2);
  });

  it("update-constraint patches by index", () => {
    const state = makeInitialState(basePacket());
    const next = apply(state, {
      type: "update-constraint",
      index: 0,
      patch: { doc: "explained" },
    });
    expect(next.packet.constraints![0].doc).toBe("explained");
  });

  it("delete-constraint removes by index", () => {
    const state = makeInitialState(basePacket());
    const next = apply(state, { type: "delete-constraint", index: 0 });
    expect(next.packet.constraints).toHaveLength(0);
  });

  it("replace-packet swaps the whole packet and pushes history", () => {
    const state = makeInitialState(basePacket());
    const replacement: PsdlPacket = {
      name: "Replaced",
      rowBits: 16,
      body: [],
    };
    const next = apply(state, { type: "replace-packet", packet: replacement });
    expect(next.packet.name).toBe("Replaced");
    expect(next.history).toHaveLength(1);
  });
});

describe("editReducer — undo / redo", () => {
  it("undo and redo flow through A → B → undo → undo → redo", () => {
    const init = basePacket();
    let s = makeInitialState(init);

    const fieldA: Field = { id: "addA", name: "A+", type: int(8) };
    const fieldB: Field = { id: "addB", name: "B+", type: int(8) };

    s = apply(s, { type: "add-field", at: [2], field: fieldA });
    const afterA = s.packet;
    expect(s.packet.body).toHaveLength(3);

    s = apply(s, { type: "add-field", at: [3], field: fieldB });
    expect(s.packet.body).toHaveLength(4);
    expect(s.history).toHaveLength(2);
    expect(s.future).toHaveLength(0);

    s = apply(s, { type: "undo" });
    expect(s.packet).toEqual(afterA);
    expect(s.history).toHaveLength(1);
    expect(s.future).toHaveLength(1);

    s = apply(s, { type: "undo" });
    expect(s.packet).toEqual(init);
    expect(s.future).toHaveLength(2);

    s = apply(s, { type: "redo" });
    expect(s.packet).toEqual(afterA);
    expect(s.history).toHaveLength(1);
    expect(s.future).toHaveLength(1);
  });

  it("undo is a no-op when history is empty", () => {
    const s = makeInitialState(basePacket());
    expect(apply(s, { type: "undo" })).toBe(s);
  });

  it("redo is a no-op when future is empty", () => {
    const s = makeInitialState(basePacket());
    expect(apply(s, { type: "redo" })).toBe(s);
  });

  it("new mutating action after undo clears future", () => {
    let s = makeInitialState(basePacket());
    s = apply(s, { type: "delete-field", at: [0] });
    s = apply(s, { type: "undo" });
    expect(s.future).toHaveLength(1);
    s = apply(s, { type: "delete-field", at: [0] });
    expect(s.future).toHaveLength(0);
  });

  it("history is capped at HISTORY_LIMIT", () => {
    let s = makeInitialState(basePacket());
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) {
      s = apply(s, {
        type: "update-field",
        at: [0],
        patch: { name: `n${i}` },
      });
    }
    expect(s.history).toHaveLength(HISTORY_LIMIT);
  });
});

describe("editReducer — immutability", () => {
  it("mutating the returned packet does not corrupt history", () => {
    const init = basePacket();
    let s = makeInitialState(init);
    s = apply(s, {
      type: "update-field",
      at: [0],
      patch: { name: "Mutated" },
    });
    const historicalA = s.history[0];
    (s.packet.body[0] as Field).name = "MutatedAgain";
    expect((historicalA.body[0] as Field).name).toBe("A");
  });

  it("add-field clones the field input", () => {
    const s = makeInitialState(basePacket());
    const field: Field = { id: "c", name: "C", type: int(8) };
    const next = apply(s, { type: "add-field", at: [2], field });
    (next.packet.body[2] as Field).name = "X";
    expect(field.name).toBe("C");
  });
});

describe("editReducer — no-op edge cases", () => {
  it("update-field on missing slot returns state unchanged", () => {
    const s = makeInitialState(basePacket());
    const next = apply(s, {
      type: "update-field",
      at: [99],
      patch: { name: "X" },
    });
    expect(next).toBe(s);
  });

  it("update-container on missing slot returns state unchanged", () => {
    const s = makeInitialState(basePacket());
    const next = apply(s, {
      type: "update-container",
      at: [99],
      patch: { name: "X" },
    });
    expect(next).toBe(s);
  });

  it("wrap-in on missing slot returns state unchanged", () => {
    const s = makeInitialState(basePacket());
    const next = apply(s, { type: "wrap-in", at: [99], kind: "group" });
    expect(next).toBe(s);
  });

  it("update-constraint with out-of-range index returns state", () => {
    const s = makeInitialState(basePacket());
    const next = apply(s, {
      type: "update-constraint",
      index: 99,
      patch: { doc: "x" },
    });
    expect(next).toBe(s);
  });

  it("delete-constraint with out-of-range index returns state", () => {
    const s = makeInitialState(basePacket());
    const next = apply(s, { type: "delete-constraint", index: 99 });
    expect(next).toBe(s);
  });

  it("add-constraint works when constraints is undefined", () => {
    const pkt = basePacket();
    delete pkt.constraints;
    const s = makeInitialState(pkt);
    const next = apply(s, {
      type: "add-constraint",
      constraint: {
        lhs: { kind: "lit", value: 1 },
        rhs: { kind: "lit", value: 1 },
      },
    });
    expect(next.packet.constraints).toHaveLength(1);
  });
});
