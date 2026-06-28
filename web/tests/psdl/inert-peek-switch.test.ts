// high: `collectPeekSwitches` surfaces a synthetic case picker for a Switch
// whose discriminator is a `peek` (TLV/PDU dispatch on a not-yet-parsed byte).
//
// A peek picker is suppressed only when it is GENUINELY inert: every reachable
// arm — the listed (selectable) arms AND the `_` default the unset peek falls
// through to — renders to the same geometry, so no selection can change the
// diagram. The render-identity gate (`switchArmsRenderIdentical`, tolerant of
// per-arm id/ref renaming, the same gate `attachOverrideMetadata` /
// `collectRefSwitches` apply to `ref`-discriminated pickers) decides this for
// the listed arms.
//
// snmpV2c's `pduSwitch` is the case that proves the `_` arm MUST count: its 8
// PDU-type arms (160..168) render the SAME ASN.1 envelope, differing only by
// per-arm field id / NAME — but its `_` default `unknownPdu` is a degenerate
// 3-field stub. If the picker were suppressed, the unset peek 0-fills → selects
// `_` → the diagram loads only that Unknown-PDU stub with no surface anywhere
// to reveal a real PDU body (see-but-cannot-edit). So `pduSwitch` IS surfaced
// (via the same `defaultArmSyntheticCase` path icmpv6Ndp's NDP options use),
// with `initialState` seeding the peek to the first real PDU tag (160) so a
// real PDU — not the stub — renders on load. This mirrors snmpv3, whose
// identical peek idiom already surfaces a `__peek__0__8` picker.

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
 * Whether a Switch's reachable arms differ structurally beyond per-arm field
 * id / intra-arm reference renaming — i.e. choosing a case COULD change the
 * diagram's shape. Mirrors the lib's render-identity gate so the scan can tell
 * a legitimately-surfaced peek picker from an inert one.
 *
 * "Reachable" means the listed (selectable) arms AND the `_` default arm the
 * unset peek falls through to. A picker is live if ANY reachable arm differs
 * from another: icmpv6Ndp `*ByOptType` differ amongst their listed arms;
 * snmpV2c `pduSwitch` has listed arms that fingerprint identically but a `_`
 * default (the Unknown-PDU stub) that is geometrically distinct — selecting a
 * listed PDU vs. falling through to that stub changes the diagram, so the
 * picker is NOT inert. An inert picker is one where every listed arm AND the
 * `_` default all fingerprint identically (nothing the picker can select moves
 * the diagram).
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
  // The `_` default arm is reachable (the unset peek falls through to it), so a
  // default that differs from the listed arms makes the picker live even when
  // every listed arm fingerprints identically (snmpV2c `pduSwitch`).
  const defaultArm = sw.cases["_"];
  const reachable = defaultArm
    ? [...selectable, fingerprint(defaultArm.fields)]
    : selectable;
  return !reachable.every((s) => s === reachable[0]);
}

describe("inert peek-switch pickers are suppressed", () => {
  it("snmpV2c surfaces a PDU-type picker and loads a real PDU (not the Unknown stub)", () => {
    const src = PRESETS.snmpV2c!;
    const m = psdlToRenderer(src);
    const surfaced = m.peekSwitches ?? [];
    const ps = surfaced.find((p) => p.id === "pduSwitch");
    expect(
      ps,
      "pduSwitch must surface a peek picker (see-but-cannot-edit otherwise)",
    ).toBeTruthy();
    expect(ps!.peekKey).toBe("__peek__0__8");
    // All 8 real PDU tags are offered, plus the synthetic Unknown default.
    const offered = new Set(ps!.cases.map((c) => c.value));
    for (const tag of [160, 161, 162, 163, 165, 166, 167, 168]) {
      expect(offered.has(tag), `tag ${tag} must be selectable`).toBe(true);
    }
    // The picker seeds a REAL PDU tag on load — not the degenerate `_` stub.
    const seed = Number(initialState(m)["__peek__0__8"]);
    expect([160, 161, 162, 163, 165, 166, 167, 168]).toContain(seed);

    // And the default load (seed) renders a real, multi-cell PDU body — not the
    // 4-cell Unknown-PDU stub the unset peek used to fall through to.
    const stub = appGeometry(src, { __peek__0__8: 0 });
    const stubCells = JSON.parse(stub).length as number;
    const loaded = appGeometry(src, {}); // no override → initialState seed wins
    const loadedCells = JSON.parse(loaded).length as number;
    expect(stubCells).toBe(4); // the degenerate Unknown stub
    expect(loadedCells).toBeGreaterThan(stubCells);
    expect(loaded).not.toBe(stub);
  });

  it("selecting tag 162 renders the GetResponse PDU family (not the Unknown stub)", () => {
    // Driving the surfaced picker to a real PDU tag must reveal the real PDU
    // body the preset exists to show.
    const src = PRESETS.snmpV2c!;
    const responseGeom = appGeometry(src, { __peek__0__8: 162 });
    const stubGeom = appGeometry(src, { __peek__0__8: 0 });
    expect(responseGeom).not.toBe(stubGeom);
    // The GetResponse arm renders distinctly more cells than the stub.
    expect(JSON.parse(responseGeom).length).toBeGreaterThan(
      JSON.parse(stubGeom).length,
    );

    // The picked arm's getResponsePdu-family field ids appear in the layout.
    const m = psdlToRenderer(src);
    const env = new Map<string, number>();
    const state = initialState(m);
    for (const [k, v] of Object.entries(state)) env.set(k, Number(v));
    env.set("__peek__0__8", 162);
    for (const [k, v] of initialEnv(src)) if (!env.has(k)) env.set(k, v);
    for (const r of collectPsdlRefs(src)) if (!env.has(r)) env.set(r, 0);
    seedDynamicWidthDefaults(src, env);
    const fieldIds = resolveLayout(src, {
      env,
      viewMode: "semantic",
    }).cells.map((c) => c.field?.id ?? "");
    expect(
      fieldIds.includes("pduTagGetResponse"),
      `layout must include the GetResponse arm's tag cell: ${fieldIds.join(",")}`,
    ).toBe(true);
    // The Unknown-PDU stub cell must NOT be present once a real PDU is picked.
    expect(fieldIds).not.toContain("pduTagUnknown");
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
