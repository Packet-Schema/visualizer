// ref-def-tlv (high): a TLV-shaped Repeat (element = a single Switch, count =
// eos/until) that the body reaches only through a `def`-`ref` — i.e. the
// standard PSDL 0.5 modular/recursive idiom
//
//   body: [ Header, { kind: "ref", ref: "optList" } ]
//   defs: { optList: { fields: [ repeat eos { switch on peek } ] } }
//
// gets a fully-populated TLV catalog in the renderer mirror, because
// `psdlToRenderer`/`flattenForMirror` DO descend `ref`. So OverridePanel shows a
// TLV section + a working-looking record list editor, and adding records merges
// them into the def (mergeInstancesIntoPsdl). But the render-path rewriter
// `applyTlvInstances` walked `psdl.body` with an `expand()` that handled only
// bounded/group/optional/repeat and NOT `ref`: the ref container fell to the
// default `return [c]`, the def was never descended, `mutated` stayed false, and
// the unchanged packet was returned. Net effect: a fully INERT TLV editor — the
// diagram never reflected any record edit (bar #1 see-but-cannot-edit; bar #2
// arbitrary valid PSDL must render + round-trip).
//
// The fix adds a `ref` branch (plus the symmetric `encrypted` wrapper) to
// `expand()` and `containsExpandedTlv`: resolve `psdl.defs[ref]`, expand a COPY
// of the def's fields, and splice the result inline at the ref site (never
// mutating the shared def), with a path-scoped seen-set cycle guard mirroring
// flattenForMirrorGuarded.

import { describe, it, expect } from "vitest";

import { peek } from "@/lib/psdl/expr";
import { psdlToRenderer, applyTlvInstances } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import type { Container, Group, Packet as PsdlPacket } from "@/lib/psdl/types";

const bits = (n: number) => ({ kind: "bits" as const, n });

// body: [ H, {ref optList} ]; def optList = repeat eos { switch on peek(8) }.
function mkPacket(): PsdlPacket {
  return {
    name: "RefDefTlv",
    rowBits: 32,
    body: [
      { id: "H", name: "Header", type: bits(8) },
      { kind: "ref", id: "optsRef", ref: "optList" },
    ],
    defs: {
      optList: {
        id: "optList",
        fields: [
          {
            kind: "repeat",
            id: "opts",
            count: "eos",
            element: {
              id: "optStruct",
              fields: [
                {
                  kind: "switch",
                  id: "optSw",
                  on: peek(8),
                  cases: {
                    "1": {
                      id: "optA",
                      name: "Opt A",
                      fields: [
                        { id: "aType", name: "A Type", type: bits(8) },
                        { id: "aVal", name: "A Value", type: bits(8) },
                      ],
                    },
                    "2": {
                      id: "optB",
                      name: "Opt B",
                      fields: [
                        { id: "bType", name: "B Type", type: bits(8) },
                        { id: "bVal", name: "B Value", type: bits(16) },
                      ],
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    },
  } as unknown as PsdlPacket;
}

function renderCells(psdl: PsdlPacket) {
  const env = new Map<string, number>();
  for (const [k, v] of initialEnv(psdl)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  return resolveLayout(psdl, { env }).cells;
}

describe("body-level ref-def TLV repeat is editable end-to-end", () => {
  it("surfaces a TLV catalog in the renderer mirror", () => {
    const mirror = psdlToRenderer(mkPacket());
    const opt = mirror.fields.find((f) => f.tlv);
    expect(opt).toBeDefined();
    // The TLV field id is QUALIFIED by the enclosing ref id (`optsRef.`) to
    // match core's `<refId>.<fieldId>` cell-id scheme, so two refs to one def
    // would surface distinct TLV fields instead of colliding.
    expect(opt!.id).toBe("optsRef.opts");
    expect(opt!.tlv!.catalog.map((e) => e.kind).sort()).toEqual([1, 2]);
  });

  it("applyTlvInstances descends the ref and rewrites the def's repeat into per-instance Groups", () => {
    const psdl = mkPacket();
    const mirror = psdlToRenderer(psdl);
    const opt = mirror.fields.find((f) => f.tlv)!;
    opt.tlv!.instances = [{ kind: 1 }, { kind: 1 }];

    const out = applyTlvInstances(psdl, mirror, { "optsRef.opts": 4 });

    // The packet is actually mutated (the bug returned `psdl` unchanged).
    expect(out).not.toBe(psdl);

    // The shared def must NOT be mutated — the ref is expanded inline.
    expect(out.defs).toBeDefined();
    const defRepeat = out.defs!.optList.fields.find(
      (c) => "kind" in c && c.kind === "repeat",
    );
    expect(defRepeat).toBeDefined();

    // The per-instance Groups are spliced into the body at the ref site,
    // qualified by the ref id (`optsRef.opts__inst_*`).
    const groups = out.body.filter(
      (c): c is Group =>
        c.kind === "group" && c.id.startsWith("optsRef.opts__inst_"),
    );
    expect(groups).toHaveLength(2);
    // No raw repeat / unresolved ref left dangling in the body.
    expect(out.body.some((c) => "kind" in c && c.kind === "ref")).toBe(false);
    expect(out.body.some((c) => "kind" in c && c.kind === "repeat")).toBe(
      false,
    );
  });

  it("the rewritten packet renders the record cells (diagram reflects the edit)", () => {
    const psdl = mkPacket();
    const mirror = psdlToRenderer(psdl);
    const opt = mirror.fields.find((f) => f.tlv)!;

    // Before any edit: only the header renders (Stage 3 keeps the raw repeat,
    // count 0 → no records).
    const before = renderCells(psdl).map((c) => c.field.id);
    expect(before).toEqual(["H"]);

    // Pick two Opt-A records.
    opt.tlv!.instances = [{ kind: 1 }, { kind: 1 }];
    const out = applyTlvInstances(psdl, mirror, { "optsRef.opts": 4 });

    const cells = renderCells(out);
    const ids = cells.map((c) => c.field.id);
    expect(ids).toContain("H");
    expect(ids).toContain("optsRef.opts__inst_0");
    expect(ids).toContain("optsRef.opts__inst_1");

    // Each instance cell collapses the variant's Type/Value into subCells.
    const inst0 = cells.find((c) => c.field.id === "optsRef.opts__inst_0")!;
    const subIds = (inst0.subCells ?? []).map((s) => s.subfield.id);
    expect(subIds).toContain("optsRef.opts__inst_0__aType");
    expect(subIds).toContain("optsRef.opts__inst_0__aVal");
  });

  it("a self-recursive def does not loop (cycle guard)", () => {
    // optList references itself via an optional self-ref tail — the classic
    // recursive idiom. expand()'s seen-set must terminate.
    const psdl = mkPacket();
    (psdl.defs!.optList.fields as Container[]).push({
      kind: "optional",
      id: "tail",
      when: { kind: "lit", value: 0 },
      container: { kind: "ref", id: "selfRef", ref: "optList" },
    });
    const mirror = psdlToRenderer(psdl);
    const opt = mirror.fields.find((f) => f.tlv)!;
    opt.tlv!.instances = [{ kind: 2 }];
    // Must not throw / hang.
    const out = applyTlvInstances(psdl, mirror, { "optsRef.opts": 3 });
    const groups = out.body.filter(
      (c) => c.kind === "group" && c.id.startsWith("optsRef.opts__inst_"),
    );
    expect(groups.length).toBeGreaterThanOrEqual(1);
  });
});
