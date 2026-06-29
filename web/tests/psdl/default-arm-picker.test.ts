// Regression — single-case ref/peek pickers must reach the structurally
// distinct `_` default arm.
//
// `collectRefSwitches` / `collectPeekSwitches` surface a "Record variants"
// (ref) / "Peek-based switches" (peek) picker built from a Switch's LISTED
// case keys, never an option for the `_` default arm. When the `_` arm is
// structurally different from the listed case(s), the picker historically
// offered only the listed value(s) and could never select the default-arm
// layout — an inert/misleading control AND a representability gap (an imported
// packet whose discriminator falls into `_` was silently forced to render as
// the listed arm).
//
// Confirmed against three shipping presets whose lone listed case and `_` arm
// render different diagrams:
//   * babel `babelTlvBody` (ref): listed `0` = empty Pad1, `_` = TLV-with-body.
//   * bgpFlowSpec `flowSpecCompValue` (ref): listed `1,2` = prefix, `_` = op
//     list (a `repeat`).
//   * rohcUncompressed `rohcHeader` (peek): listed `126` = IR Packet, `_` =
//     normal datagram.
//
// The pickers must now expose >= 2 selectable values, and the synthetic
// sentinel value must select a layout distinct from the listed case(s) — proved
// by normalizing each preset's actual Switch in isolation under the picker's
// own env key set to the listed vs the sentinel value.

import { describe, expect, it } from "vitest";
import { PRESETS } from "../../lib/psdl/presets.server";
import { psdlToRenderer } from "../../lib/psdl/psdl-to-renderer";
import { normalize } from "../../lib/psdl/normalize";
import { peekEnvKey } from "../../lib/psdl/expr";
import { isField } from "../../lib/psdl/utils";
import type { Container, Packet, Switch } from "../../lib/psdl/types";

/** Depth-first search for a Switch with the given id anywhere in the body. */
function findSwitch(containers: Container[], id: string): Switch | null {
  for (const c of containers) {
    if (isField(c)) continue;
    if (c.kind === "switch") {
      if (c.id === id) return c;
      for (const arm of Object.values(c.cases)) {
        const hit = findSwitch(arm.fields, id);
        if (hit) return hit;
      }
      continue;
    }
    if (c.kind === "repeat") {
      const hit = findSwitch(c.element.fields, id);
      if (hit) return hit;
    } else if (c.kind === "group") {
      const hit = findSwitch(c.children, id);
      if (hit) return hit;
    } else if (c.kind === "optional") {
      const hit = findSwitch([c.container], id);
      if (hit) return hit;
    } else if (c.kind === "bounded") {
      const hit = findSwitch(c.fields, id);
      if (hit) return hit;
    } else if (c.kind === "encrypted") {
      const hit = findSwitch(c.plaintext.fields, id);
      if (hit) return hit;
    }
  }
  return null;
}

/** Normalize a ref-discriminated Switch in isolation (discriminator field +
 *  the switch) under env[refKey] = value; return resolved field ids. */
function refArmFields(sw: Switch, refKey: string, value: number): string[] {
  const pkt: Packet = {
    name: "probe",
    rowBits: 32,
    body: [{ id: refKey, name: refKey, type: { kind: "int", bits: 8 } }, sw],
  };
  return normalize(pkt, new Map([[refKey, value]])).fields.map((f) => f.id);
}

/** Normalize a peek-discriminated Switch in isolation under its peek env key.
 *  A budget is supplied because the rohc `_` arm sizes a `bytes(remaining)`
 *  payload, which needs the top-level packet size. */
function peekArmFields(sw: Switch, peekKey: string, value: number): string[] {
  const pkt: Packet = { name: "probe", rowBits: 32, body: [sw] };
  return normalize(pkt, new Map([[peekKey, value]]), {
    totalBits: 256,
  }).fields.map((f) => f.id);
}

describe("default-arm picker — ref switches reach the `_` arm", () => {
  it("babel babelTlvBody exposes the empty Pad1 case AND the TLV-with-body default", () => {
    const pkt = PRESETS["babel"];
    expect(pkt).toBeDefined();
    const r = psdlToRenderer(pkt);
    const rs = (r.refSwitches ?? []).find((s) => s.id === "babelTlvBody");
    expect(rs, "babelTlvBody refSwitch").toBeDefined();
    const values = (rs?.cases ?? []).map((c) => c.value);
    expect(values.length).toBeGreaterThanOrEqual(2);
    expect(values).toContain(0);
    const sentinel = values.find((v) => v !== 0);
    expect(sentinel).toBeDefined();

    const sw = findSwitch(pkt.body, "babelTlvBody")!;
    const listed = refArmFields(sw, rs!.refKey, 0);
    const def = refArmFields(sw, rs!.refKey, sentinel!);
    expect(def).not.toEqual(listed);
    // The `_` arm carries the TLV-with-body fields the listed `0` arm lacks.
    expect(def).toContain("babelTlvLen");
    expect(listed).not.toContain("babelTlvLen");
  });

  it("bgpFlowSpec flowSpecCompValue exposes the prefix case AND the op-list default", () => {
    const pkt = PRESETS["bgpFlowSpec"];
    expect(pkt).toBeDefined();
    const r = psdlToRenderer(pkt);
    const rs = (r.refSwitches ?? []).find((s) => s.id === "flowSpecCompValue");
    expect(rs, "flowSpecCompValue refSwitch").toBeDefined();
    const values = (rs?.cases ?? []).map((c) => c.value);
    expect(values.length).toBeGreaterThanOrEqual(2);
    expect(values).toContain(1); // first member of the listed "1,2" key
    const sentinel = values.find((v) => v !== 1 && v !== 2);
    expect(sentinel).toBeDefined();

    const sw = findSwitch(pkt.body, "flowSpecCompValue")!;
    const listed = refArmFields(sw, rs!.refKey, 1);
    const def = refArmFields(sw, rs!.refKey, sentinel!);
    expect(def).not.toEqual(listed);
    // The `_` arm is the prefixLength/prefixBytes-free numeric op list.
    expect(def).not.toContain("prefixBytes");
  });
});

describe("default-arm picker — peek switches reach the `_` arm", () => {
  it("rohcUncompressed rohcHeader peek exposes IR Packet AND the normal-datagram default", () => {
    const pkt = PRESETS["rohcUncompressed"];
    expect(pkt).toBeDefined();
    const r = psdlToRenderer(pkt);
    const peek = (r.peekSwitches ?? []).find((p) => p.id === "rohcHeader");
    expect(peek, "rohcHeader peek switch").toBeDefined();
    const values = (peek?.cases ?? []).map((c) => c.value);
    expect(values.length).toBeGreaterThanOrEqual(2);
    expect(values).toContain(126);
    const sentinel = values.find((v) => v !== 126);
    expect(sentinel).toBeDefined();
    expect(peek!.peekKey).toBe(peekEnvKey(0, 7));

    const sw = findSwitch(pkt.body, "rohcHeader")!;
    const listed = peekArmFields(sw, peek!.peekKey, 126);
    const def = peekArmFields(sw, peek!.peekKey, sentinel!);
    expect(def).not.toEqual(listed);
    expect(def).toContain("rohcNormalDatagram");
    expect(listed).not.toContain("rohcNormalDatagram");
  });
});

describe("default-arm synthetic case — gating", () => {
  const intField = (id: string) => ({
    id,
    name: id,
    type: { kind: "int" as const, bits: 8 },
  });
  // A case-nested switch (discriminated on a field declared inside an OUTER
  // switch case) is the simplest surfaced refSwitch that exercises the gate.
  const wrap = (inner: Switch): Packet => ({
    name: "wrap",
    rowBits: 32,
    body: [
      intField("outer"),
      {
        kind: "switch",
        id: "outerSw",
        on: { kind: "ref", field: "outer" },
        cases: { "1": { id: "outerArm", fields: [intField("disc"), inner] } },
      },
    ],
  });

  it("a `_` arm structurally identical to a listed case gains no synthetic option", () => {
    // Two structurally DISTINCT listed arms (so the picker is not suppressed as
    // wholly inert), with a `_` arm matching arm `1`'s single-int shape.
    const r = psdlToRenderer(
      wrap({
        kind: "switch",
        id: "sw",
        on: { kind: "ref", field: "disc" },
        cases: {
          "1": { id: "v1", fields: [intField("a")] },
          "2": { id: "v2", fields: [intField("b"), intField("b2")] },
          _: { id: "vd", fields: [intField("c")] },
        },
      }),
    );
    const rs = (r.refSwitches ?? []).find((s) => s.refKey === "disc");
    expect(rs, "picker surfaced for distinct listed arms").toBeDefined();
    // The `_` arm matches arm `1`'s skeleton → no synthetic option; only the
    // two listed cases are offered.
    expect(rs?.cases.map((c) => c.value)).toEqual([1, 2]);
  });

  it("a structurally distinct `_` arm DOES gain a synthetic default option at an unlisted sentinel", () => {
    const r = psdlToRenderer(
      wrap({
        kind: "switch",
        id: "sw",
        on: { kind: "ref", field: "disc" },
        cases: {
          "1,2": { id: "v1", fields: [intField("a")] },
          _: { id: "vd", fields: [intField("x"), intField("y")] },
        },
      }),
    );
    const rs = (r.refSwitches ?? []).find((s) => s.refKey === "disc");
    const values = rs?.cases.map((c) => c.value) ?? [];
    expect(values).toContain(1);
    // Sentinel: smallest non-negative not covered by listed key "1,2" => 0.
    expect(values).toContain(0);
  });
});
