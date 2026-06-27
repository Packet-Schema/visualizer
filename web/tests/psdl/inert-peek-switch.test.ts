// high: `collectPeekSwitches` surfaces a synthetic case picker for a Switch
// whose discriminator is a `peek` (TLV/PDU dispatch on a not-yet-parsed byte).
// snmpV2c's `pduSwitch` is the pathological case: it peeks 8 bits at offset 0
// — but offset 0 of an SNMP message is the outer ASN.1 SEQUENCE tag (0x30 = 48,
// NOT a PDU type), so none of its 8 case values (160..168) can ever match a
// real packet there; and worse, every one of those 8 PDU bodies is the same
// ASN.1 `tag + berLength + (tag + berLength + bytes(ref siblingLen)) × 4`
// shape, differing only in per-arm field ids, so EVERY selectable case renders
// to byte-identical geometry. The result is a misleading 8-way "PDU type"
// dropdown that (a) targets the wrong byte and (b) can never change what the
// diagram shows — a see-but-cannot-edit control.
//
// `psdlToRenderer` now suppresses a peek picker whose every selectable arm
// renders identically (the same structural-identity gate, made tolerant of
// per-arm id/ref renaming, that `attachOverrideMetadata` / `collectRefSwitches`
// already apply to `ref`-discriminated pickers).

import { describe, it, expect } from "vitest";

import { PRESETS } from "@/lib/psdl/presets.server";
import { psdlToRenderer } from "@/lib/psdl/psdl-to-renderer";
import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { initialState } from "@/lib/psdl/renderer-helpers";
import { seedDynamicWidthDefaults } from "@/lib/psdl/dynamic-width-defaults";
import { evalExprOr } from "@/lib/psdl/expr";
import type { Container, Packet as PsdlPacket, Switch } from "@/lib/psdl/types";

/**
 * App-realistic layout GEOMETRY signature at a given override env: `initialState`
 * (freeRepeat defaults + refSwitch seeds) over `initialEnv` + 0-filled psdl refs
 * + dynamic-width seeds + the PacketViewer boundedRepeats count-derivation, then
 * resolveLayout. Captures each cell's rendered bit width / span only — a peek
 * picker is inert iff every case value yields the same geometry here.
 */
function appGeometry(
  psdl: PsdlPacket,
  overrides: Record<string, number>,
): string {
  const mirror = psdlToRenderer(psdl);
  const env = new Map<string, number>();
  const state = initialState(mirror);
  for (const [k, v] of Object.entries(state)) env.set(k, Number(v));
  // Overrides win over the seeded defaults so the picker value under test is the
  // one resolveLayout reads.
  for (const [k, v] of Object.entries(overrides)) env.set(k, v);
  for (const [k, v] of initialEnv(psdl)) if (!env.has(k)) env.set(k, v);
  for (const r of collectPsdlRefs(psdl)) if (!env.has(r)) env.set(r, 0);
  seedDynamicWidthDefaults(psdl, env);
  for (const br of mirror.boundedRepeats ?? []) {
    const budget = evalExprOr(br.bytesExpr, env, 0);
    const forRecords = Math.max(0, budget - br.prefixBytes);
    env.set(br.countKey, Math.floor(forRecords / br.perRecordBytes));
  }
  return JSON.stringify(
    resolveLayout(psdl, { env, viewMode: "semantic" }).cells.map((c) => [
      c.bitsTotal,
      c.startBit,
      c.endBit,
    ]),
  );
}

/** Find the first peek-discriminated Switch in a body whose id matches. */
function findPeekSwitch(body: Container[], id: string): Switch | null {
  let found: Switch | null = null;
  const walk = (cs: Container[]): void => {
    for (const c of cs) {
      if ("type" in c) continue;
      if (c.kind === "switch") {
        if (c.on.kind === "peek" && c.id === id) found = c;
        for (const v of Object.values(c.cases)) walk(v.fields);
      } else if (c.kind === "group") walk(c.children);
      else if (c.kind === "repeat") walk(c.element.fields);
      else if (c.kind === "optional") walk([c.container]);
      else if (c.kind === "bounded") walk(c.fields);
      else if (c.kind === "encrypted") walk(c.plaintext.fields);
    }
  };
  walk(body);
  return found;
}

/**
 * Whether a Switch's selectable arms differ structurally beyond per-arm field
 * id / intra-arm reference renaming — i.e. choosing a case COULD change the
 * diagram's shape. Mirrors the lib's render-identity gate so the scan can tell
 * a legitimately-surfaced nested option-type picker (icmpv6Ndp `*ByOptType`,
 * whose arms carry genuinely different field shapes) apart from an inert one
 * (snmpV2c `pduSwitch`, whose arms are all the same TLV envelope).
 */
function armsStructurallyDiffer(sw: Switch): boolean {
  const fieldIds = (cs: Container[]): string[] => {
    const ids: string[] = [];
    const w = (xs: Container[]): void => {
      for (const x of xs) {
        if ("type" in x) {
          ids.push(x.id);
          continue;
        }
        if (x.kind === "switch")
          for (const v of Object.values(x.cases)) w(v.fields);
        else if (x.kind === "repeat") w(x.element.fields);
        else if (x.kind === "group") w(x.children);
        else if (x.kind === "optional") w([x.container]);
        else if (x.kind === "bounded") w(x.fields);
        else if (x.kind === "encrypted") w(x.plaintext.fields);
      }
    };
    w(cs);
    return ids;
  };
  const fingerprint = (cs: Container[]): string => {
    const canon = new Map<string, string>();
    fieldIds(cs).forEach((id, i) => canon.set(id, `#${i}`));
    const rewrite = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(rewrite);
      if (node && typeof node === "object") {
        const obj = node as Record<string, unknown>;
        if (obj.kind === "ref" && typeof obj.field === "string") {
          const m = canon.get(obj.field);
          if (m) return { kind: "ref", field: m };
        }
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj))
          if (k !== "id" && k !== "name" && k !== "doc") out[k] = rewrite(v);
        return out;
      }
      return node;
    };
    return JSON.stringify(rewrite(cs));
  };
  const selectable = Object.entries(sw.cases)
    .filter(([k]) => k !== "_")
    .map(([, v]) => fingerprint(v.fields));
  if (selectable.length < 2) return true; // single-arm picker: not a multi-way dropdown
  return !selectable.every((s) => s === selectable[0]);
}

describe("inert peek-switch pickers are suppressed", () => {
  it("snmpV2c surfaces no pduSwitch peek picker", () => {
    const m = psdlToRenderer(PRESETS.snmpV2c!);
    const surfaced = m.peekSwitches ?? [];
    expect(
      surfaced.map((p) => p.id),
      "the inert pduSwitch peek picker must be gone",
    ).not.toContain("pduSwitch");
    // snmpV2c has no other peek dispatch, so nothing should surface at all.
    expect(surfaced.length).toBe(0);
    // And it didn't leak into the field-anchored switchCases instead.
    for (const f of m.fields) expect(f.switchCases).toBeUndefined();
  });

  it("the suppressed pduSwitch is genuinely inert across all 8 PDU types", () => {
    // Justify the suppression: drive the peek key over every PDU tag (160..168)
    // and the cell geometry never changes — proving the picker could never have
    // changed the diagram (so suppressing it loses nothing).
    const src = PRESETS.snmpV2c!;
    const sw = findPeekSwitch(src.body, "pduSwitch");
    expect(sw, "pduSwitch must exist in the source PSDL").toBeTruthy();
    expect(sw!.on.kind).toBe("peek");
    const peekKey = "__peek__0__8";
    const values = Object.keys(sw!.cases)
      .filter((k) => k !== "_")
      .map((k) => Number(k.split(",")[0]!.split("-")[0]));
    expect(values.length).toBeGreaterThanOrEqual(2);
    const baseline = appGeometry(src, { [peekKey]: values[0]! });
    for (const v of values.slice(1)) {
      expect(
        appGeometry(src, { [peekKey]: v }),
        `pdu peek=${v} must not change the diagram`,
      ).toBe(baseline);
    }
  });

  it("keeps a peek picker whose arms genuinely differ (sctp byChunkType)", () => {
    // Positive control: a peek dispatch whose arms carry distinct shapes must
    // stay surfaced and must actually move the diagram.
    const src = PRESETS.sctp!;
    const m = psdlToRenderer(src);
    const ps = (m.peekSwitches ?? []).find((p) => p.peekKey === "__peek__0__8");
    expect(ps, "sctp chunk-type peek picker must survive").toBeTruthy();
    const geoms = new Set(
      ps!.cases.map((c) => appGeometry(src, { [ps!.peekKey]: c.value })),
    );
    expect(geoms.size).toBeGreaterThanOrEqual(2);
  });

  it("no surfaced peek picker is inert at the env that activates its scope", () => {
    // Whole-suite invariant: every multi-arm peek picker we surface must be
    // backed by structurally-distinct arms — otherwise it is a misleading
    // see-but-cannot-edit dropdown like snmpV2c's pduSwitch.
    for (const [key, src] of Object.entries(PRESETS)) {
      const m = psdlToRenderer(src);
      for (const ps of m.peekSwitches ?? []) {
        // Peek-gated Optional pickers are keyed by their env key (no backing
        // Switch id); the inert-arm concern is specific to real peek Switches.
        const sw = findPeekSwitch(src.body, ps.id);
        if (!sw) continue;
        expect(
          armsStructurallyDiffer(sw),
          `${key} peek picker "${ps.name}" (${ps.peekKey}) is inert: every selectable arm renders identically`,
        ).toBe(true);
      }
    }
  });
});
