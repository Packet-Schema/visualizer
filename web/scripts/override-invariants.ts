/**
 * override-invariants.ts — DETERMINISTIC, EXHAUSTIVE invariant harness for the
 * OVERRIDE subsystem and arbitrary-PSDL round-trips.
 *
 * THIS IS A CI-EXCLUDED DIAGNOSTIC. It lives under `scripts/`, and the committed
 * CI vitest `include` is `tests/**\/*.test.ts` (see vitest.config.ts), so this
 * file never runs in the CI suite and its intermediate failures can't turn CI
 * red. Run it standalone via its dedicated vitest config:
 *
 *     cd web && npx vitest run --config vitest.diag.config.ts
 *
 * (vitest is used rather than `tsx` because the app's lib graph statically
 * imports `@packet-schema/core`, whose package.json exposes ONLY the ESM
 * `import` export condition; tsx's CJS loader can't resolve that through the
 * CJS-default lib `.ts` files, whereas vitest's resolver — the exact one the
 * committed test-suite uses — handles it, the `@/` alias, and the `server-only`
 * stub natively, so the harness mirrors the app's real module resolution.)
 *
 * It loads EVERY preset in PRESETS plus a battery of SYNTHETIC packets covering
 * every PSDL 0.5 construct and nested combinations, builds the layout env
 * EXACTLY like PacketViewer's layout memo (the proven pipeline mirrored from
 * web/tests/psdl/bounded-repeat.test.ts's `cellCount` helper, extended with the
 * full freeze-guard / product-budget logic PacketViewer's `buildLayoutEnv`
 * runs), and checks three deterministic, low-false-positive invariants:
 *
 *   I1 RENDER_OK   — resolveLayout(base,{env}) never throws; cells.length>0
 *                    unless the packet is legitimately empty.
 *   I2 NO_FREEZE   — sweeping EVERY lengthController / freeRepeat countKey /
 *                    boundedRepeat lengthKey to 1e3 and 1e6 keeps resolveLayout
 *                    from throwing AND keeps the rendered cell count under the
 *                    app's freeze cap (no OOM / multi-million-cell blowup).
 *   I3 ROUNDTRIP   — toJson→fromJson reproduces an identical resolved layout;
 *                    mergeInstancesIntoPsdl(source,mirror) renders identically;
 *                    encodeSource→decodeSource round-trips; no field/def/meta/
 *                    chain/byteOrder is dropped on the round-trip.
 *
 * It prints a JSON array of concrete violations:
 *   { kind:'I1'|'I2'|'I3', target:'<presetKey|synthetic-name>', detail, repro }
 * ZERO violations across the whole corpus = converged for these classes.
 */

import { describe, it, expect } from "vitest";

// PRESETS: the SAME server-only registry the app resolves and the committed
// test-suite uses (vitest aliases `server-only` to a no-op stub, so importing
// it here is faithful — no need to re-implement `adaptPreset`).
import { PRESETS } from "@/lib/psdl/presets.server";

import { resolveLayout } from "@/lib/psdl/layout";
import { initialEnv } from "@/lib/psdl/normalize";
import { collectPsdlRefs } from "@/lib/psdl/collect-refs";
import { seedDynamicWidthDefaults } from "@/lib/psdl/dynamic-width-defaults";
import { clampStaticLayoutCounts } from "@/lib/psdl/clamp-static-layout";
import { boundedKeysWithDirectPayload } from "@/lib/psdl/bounded-direct-payload-keys";
import { evalExprOr } from "@/lib/psdl/expr";
import { initialState } from "@/lib/psdl/renderer-helpers";
import {
  applyByteOrderOverrides,
  applyChainInstances,
  applyTlvInstances,
  mergeInstancesIntoPsdl,
  psdlToRenderer,
} from "@/lib/psdl/psdl-to-renderer";
import { validatePsdlPacket } from "@/lib/psdl/validate";
import { toJson, fromJson } from "@/lib/formats/json";
import { encodeSource, decodeSource } from "@/lib/psdl/source-format";

import type { Packet as RendererPacket } from "@/lib/psdl/renderer";
import type { Packet as PsdlPacket, Container, Expr } from "@/lib/psdl/types";

// ── PacketViewer constants (mirrored verbatim) ───────────────────────────────
const MAX_DERIVED_RECORDS = 1024;
const MAX_LENGTH_CONTROLLER_BYTES = MAX_DERIVED_RECORDS;
const MAX_DERIVED_PRODUCT = MAX_DERIVED_RECORDS;

// Freeze cap for I2: the app's product-aware guard bounds the derived record /
// byte product to MAX_DERIVED_PRODUCT (~1024), each record/byte expanding to a
// handful of cells. A generous multiple of that bounds the worst legitimate
// resolved cell count; anything above is a freeze/OOM-class blowup.
const FREEZE_CELL_CAP = 200_000;

// ── Violation type ───────────────────────────────────────────────────────────
type Violation = {
  kind: "I1" | "I2" | "I3";
  target: string;
  detail: string;
  repro: string;
};
const violations: Violation[] = [];
function report(v: Violation) {
  violations.push(v);
}

// ─────────────────────────────────────────────────────────────────────────────
// buildLayoutEnv — faithful mirror of PacketViewer.tsx's `buildLayoutEnv`.
// Given the source PSDL (`targetPsdl`-equivalent) and its renderer mirror plus a
// controllers map, produce the fully-seeded, freeze-guarded env fed to
// resolveLayout. Mirrors every clamp the app applies so the harness agrees with
// the diagram and emits no false freeze/over-consume positives.
// ─────────────────────────────────────────────────────────────────────────────
function buildLayoutEnv(
  targetPsdl: PsdlPacket,
  mirror: RendererPacket,
  controllerValues: Record<string, number>,
): Map<string, number> {
  const psdlRefs = collectPsdlRefs(targetPsdl);

  const boundedKeys = new Set(
    (mirror.boundedRepeats ?? []).map((br) => br.lengthKey),
  );
  const directLengthControllerIds = new Set<string>();
  for (const lc of mirror.lengthControllers ?? []) {
    if (lc.controlsLength && !boundedKeys.has(lc.controlsLength)) {
      directLengthControllerIds.add(lc.controlsLength);
    }
  }
  for (const f of mirror.fields) {
    if (f.controlsLength && !boundedKeys.has(f.controlsLength)) {
      directLengthControllerIds.add(f.controlsLength);
    }
  }
  const boundedDirectPayloadKeys = boundedKeysWithDirectPayload(
    targetPsdl,
    (mirror.boundedRepeats ?? []).map((br) => br.lengthKey),
  );

  const env = new Map<string, number>(
    Object.entries(controllerValues).map(([k, v]) => [k, Number(v)]),
  );
  // 1. Field.defaultValue seed (before 0-fill, so it is never zeroed).
  for (const [k, v] of initialEnv(targetPsdl)) if (!env.has(k)) env.set(k, v);
  // 2. Fallback 0-fill of every ref the packet uses.
  for (const r of psdlRefs) if (!env.has(r)) env.set(r, 0);
  // 3. Dynamic-width (varint / delimited bytes) defaults.
  seedDynamicWidthDefaults(targetPsdl, env);

  // 4. DUAL-ROLE direct-payload cap (BEFORE the bounded derive).
  for (const id of boundedDirectPayloadKeys) {
    const v = env.get(id);
    if (typeof v === "number" && v > MAX_LENGTH_CONTROLLER_BYTES) {
      env.set(id, MAX_LENGTH_CONTROLLER_BYTES);
    }
  }

  // 5. PRODUCT-AWARE freeze guard with a shared shrinking budget.
  let productBudget = MAX_DERIVED_PRODUCT;
  const factor = (value: number, perKeyCap: number): number => {
    const capped = Math.max(0, Math.min(value, perKeyCap, productBudget));
    productBudget = Math.max(
      1,
      Math.floor(productBudget / Math.max(1, capped)),
    );
    return capped;
  };

  // 5a. boundedRepeats — derive count from budget, with inner-scope seeding /
  // growth and live per-record overage exactly as PacketViewer does.
  for (const br of mirror.boundedRepeats ?? []) {
    for (const seed of br.innerScopeSeeds ?? []) {
      if (!env.get(seed.key)) env.set(seed.key, seed.value);
    }
    const budgetBaseOf = (key: string): number => {
      const seed = (br.innerScopeSeeds ?? []).find(
        (s) => s.key === key && !s.derivesBudgetKey,
      );
      if (seed) return seed.value;
      if (key === br.lengthKey) return Number(env.get(key) ?? 0);
      return 0;
    };
    for (const seed of br.innerScopeSeeds ?? []) {
      if (!seed.derivesBudgetKey) continue;
      const overage =
        Math.max(0, Number(env.get(seed.key) ?? 0) - seed.value) *
        (seed.bytesPerUnit ?? 1);
      if (overage <= 0) continue;
      const budgetKey = seed.derivesBudgetKey;
      const required = budgetBaseOf(budgetKey) + overage;
      if (required > Number(env.get(budgetKey) ?? 0)) {
        env.set(budgetKey, required);
      }
    }
    const budget = evalExprOr(br.bytesExpr, env, 0);
    const forRecords = Math.max(0, budget - br.prefixBytes);
    const innerOverage = (br.innerScopeSeeds ?? []).reduce(
      (sum, seed) =>
        seed.derivesBudgetKey && seed.derivesBudgetKey !== br.lengthKey
          ? sum
          : sum +
            Math.max(0, Number(env.get(seed.key) ?? 0) - seed.value) *
              (seed.bytesPerUnit ?? 1),
      0,
    );
    const livePerRecordBytes = br.perRecordBytes + innerOverage;
    env.set(
      br.countKey,
      factor(Math.floor(forRecords / livePerRecordBytes), MAX_DERIVED_RECORDS),
    );
  }

  // 5b. freeRepeats — cap the derived record count and invert through the
  // transform back to the env value.
  for (const fr of mirror.freeRepeats ?? []) {
    const v = env.get(fr.countKey);
    if (typeof v !== "number") continue;
    const mul = fr.transform?.mul ?? 1;
    const add = fr.transform?.add ?? 0;
    const recordCount = v * mul + add;
    const allowed = factor(recordCount, MAX_DERIVED_RECORDS);
    if (allowed !== recordCount) {
      const capped = Math.max(0, Math.floor((allowed - add) / mul));
      env.set(fr.countKey, capped);
    }
  }

  // 5c. direct length controllers — cap each to its per-key ceiling AND the
  // leftover product budget (read, not drained — additive siblings keep cap).
  const directLengthCap = Math.min(MAX_LENGTH_CONTROLLER_BYTES, productBudget);
  for (const id of directLengthControllerIds) {
    const v = env.get(id);
    if (typeof v === "number" && v > directLengthCap) {
      env.set(id, directLengthCap);
    }
  }

  return env;
}

// Build `targetPsdl` (the PSDL fed to resolveLayout-via-renderPsdl) the way
// PacketViewer's non-editMode path does: apply TLV slots + chain + byteOrder
// overrides onto the base PSDL.
function buildTargetPsdl(src: PsdlPacket, mirror: RendererPacket): PsdlPacket {
  return applyByteOrderOverrides(
    applyChainInstances(applyTlvInstances(src, mirror, {}), mirror),
    mirror,
  );
}

// Resolve a layout exactly as the app would for the given controller overrides.
type Resolved = ReturnType<typeof resolveLayout>;
function resolveAsApp(
  src: PsdlPacket,
  mirror: RendererPacket,
  overrides: Record<string, number>,
): Resolved {
  const controllers = {
    ...numericControllers(mirror),
    ...overrides,
  };
  const targetPsdl = buildTargetPsdl(src, mirror);
  const renderPsdl = clampStaticLayoutCounts(targetPsdl, MAX_DERIVED_RECORDS);
  const env = buildLayoutEnv(targetPsdl, mirror, controllers);
  return resolveLayout(renderPsdl, { env });
}

// `initialState` returns a ControllerState whose values may be number | boolean
// | string; coerce to the numeric env shape the layout pipeline consumes.
function numericControllers(mirror: RendererPacket): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(initialState(mirror))) {
    out[k] = Number(v);
  }
  return out;
}

// A packet is "legitimately empty" if EVERY top-level body element is a
// zero-on-default construct: an optional whose `when` is false at defaults, a
// switch with no default arm whose discriminator hits no case, or a repeat with
// count 0. We approximate conservatively: only treat a packet as legitimately
// empty when its body has no plain Field / Group / Bounded / Encrypted / Align
// node (those always emit at least one cell). This keeps I1 from flagging an
// intentionally-empty optional/switch arm.
function mayLegitimatelyRenderEmpty(src: PsdlPacket): boolean {
  const body = (src.body ?? []) as Container[];
  if (body.length === 0) return true;
  const alwaysEmits = (c: Container): boolean => {
    switch (c.kind) {
      case "field":
      case undefined: // bare Field has optional `kind`
      case "group":
      case "bounded":
      case "encrypted":
      case "align":
      case "ref":
        return true;
      case "virtual":
        return false;
      case "optional":
      case "switch":
        return false;
      case "repeat":
        return false;
      default:
        return false;
    }
  };
  return !body.some(alwaysEmits);
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolved-layout structural signature for I3 equality. Two layouts are
// "identical" if their cell sequence (id, bits, label) and totalBits match.
// ─────────────────────────────────────────────────────────────────────────────
function layoutSignature(layout: Resolved): string {
  const cells = layout.cells.map((c) => {
    const anyCell = c as Record<string, unknown>;
    return {
      id: anyCell.id ?? anyCell.fieldId ?? null,
      bits: anyCell.bits ?? null,
      name: anyCell.name ?? anyCell.label ?? null,
    };
  });
  return JSON.stringify({ totalBits: layout.totalBits ?? null, cells });
}

// ─────────────────────────────────────────────────────────────────────────────
// I1: RENDER_OK
// ─────────────────────────────────────────────────────────────────────────────
function checkI1(target: string, src: PsdlPacket, mirror: RendererPacket) {
  let layout: Resolved;
  try {
    layout = resolveAsApp(src, mirror, {});
  } catch (e) {
    report({
      kind: "I1",
      target,
      detail: `resolveLayout threw at default controllers: ${(e as Error).message}`,
      repro: `resolveAsApp(${target}, {})`,
    });
    return;
  }
  if (layout.cells.length === 0 && !mayLegitimatelyRenderEmpty(src)) {
    report({
      kind: "I1",
      target,
      detail:
        "resolved layout has 0 cells but the packet is not legitimately empty",
      repro: `resolveAsApp(${target}, {}).cells.length === 0`,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// I2: NO_FREEZE — sweep every length/count driver to 1e3 and 1e6.
// ─────────────────────────────────────────────────────────────────────────────
function checkI2(target: string, src: PsdlPacket, mirror: RendererPacket) {
  const driverKeys = new Set<string>();
  for (const br of mirror.boundedRepeats ?? []) driverKeys.add(br.lengthKey);
  for (const fr of mirror.freeRepeats ?? []) driverKeys.add(fr.countKey);
  for (const lc of mirror.lengthControllers ?? []) {
    if (lc.controlsLength) driverKeys.add(lc.controlsLength);
    driverKeys.add(lc.id);
  }
  for (const f of mirror.fields) {
    if (f.controlsLength) driverKeys.add(f.controlsLength);
  }
  if (driverKeys.size === 0) return;

  const sweepValues = [1e3, 1e6];

  // Individually sweep each driver.
  for (const key of driverKeys) {
    for (const val of sweepValues) {
      let layout: Resolved;
      try {
        layout = resolveAsApp(src, mirror, { [key]: val });
      } catch (e) {
        report({
          kind: "I2",
          target,
          detail: `resolveLayout threw with ${key}=${val}: ${(e as Error).message}`,
          repro: `resolveAsApp(${target}, { ${key}: ${val} })`,
        });
        continue;
      }
      if (layout.cells.length > FREEZE_CELL_CAP) {
        report({
          kind: "I2",
          target,
          detail: `cells.length=${layout.cells.length} exceeds freeze cap ${FREEZE_CELL_CAP} with ${key}=${val}`,
          repro: `resolveAsApp(${target}, { ${key}: ${val} }).cells.length`,
        });
      }
    }
  }

  // Sweep ALL drivers simultaneously (the worst multiplicative case).
  for (const val of sweepValues) {
    const overrides: Record<string, number> = {};
    for (const key of driverKeys) overrides[key] = val;
    let layout: Resolved;
    try {
      layout = resolveAsApp(src, mirror, overrides);
    } catch (e) {
      report({
        kind: "I2",
        target,
        detail: `resolveLayout threw with ALL drivers=${val}: ${(e as Error).message}`,
        repro: `resolveAsApp(${target}, {<all drivers>=${val}})`,
      });
      continue;
    }
    if (layout.cells.length > FREEZE_CELL_CAP) {
      report({
        kind: "I2",
        target,
        detail: `cells.length=${layout.cells.length} exceeds freeze cap ${FREEZE_CELL_CAP} with ALL drivers=${val}`,
        repro: `resolveAsApp(${target}, {<all drivers>=${val}}).cells.length`,
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// I3: ROUNDTRIP_LOSSLESS
// ─────────────────────────────────────────────────────────────────────────────

// Keys whose presence on the source must survive every round-trip.
function structuralKeyCensus(src: PsdlPacket): {
  fields: number;
  defs: number;
  constraints: number;
  meta: boolean;
  byteOrder: boolean;
} {
  const countContainers = (cs: Container[]): number => cs.length;
  return {
    fields: countContainers((src.body ?? []) as Container[]),
    defs: src.defs ? Object.keys(src.defs).length : 0,
    constraints: src.constraints ? src.constraints.length : 0,
    meta: src.meta !== undefined,
    byteOrder: src.byteOrder !== undefined,
  };
}

function checkI3(target: string, src: PsdlPacket, mirror: RendererPacket) {
  // Baseline resolved layout the round-trips must reproduce.
  let baseLayout: Resolved;
  try {
    baseLayout = resolveAsApp(src, mirror, {});
  } catch {
    // I1 already reported the throw; skip I3 for this target.
    return;
  }
  const baseSig = layoutSignature(baseLayout);
  const before = structuralKeyCensus(src);

  // --- (a) toJson → fromJson ---
  try {
    const json = toJson(src as never);
    const { packet: back } = fromJson(json);
    const backMirror = psdlToRenderer(back as PsdlPacket);
    const sig = layoutSignature(
      resolveAsApp(back as PsdlPacket, backMirror, {}),
    );
    if (sig !== baseSig) {
      report({
        kind: "I3",
        target,
        detail: "toJson→fromJson produced a different resolved layout",
        repro: `fromJson(toJson(${target})) layout != original`,
      });
    }
    const after = structuralKeyCensus(back as PsdlPacket);
    diffCensus(target, "toJson→fromJson", before, after);
  } catch (e) {
    report({
      kind: "I3",
      target,
      detail: `toJson→fromJson threw: ${(e as Error).message}`,
      repro: `fromJson(toJson(${target}))`,
    });
  }

  // --- (b) encodeSource → decodeSource (PSDL source pane) ---
  try {
    const text = encodeSource(src);
    const back = decodeSource(text);
    const backMirror = psdlToRenderer(back);
    const sig = layoutSignature(resolveAsApp(back, backMirror, {}));
    if (sig !== baseSig) {
      report({
        kind: "I3",
        target,
        detail:
          "encodeSource→decodeSource produced a different resolved layout",
        repro: `decodeSource(encodeSource(${target})) layout != original`,
      });
    }
    const after = structuralKeyCensus(back);
    diffCensus(target, "encodeSource→decodeSource", before, after);
  } catch (e) {
    report({
      kind: "I3",
      target,
      detail: `encodeSource→decodeSource threw: ${(e as Error).message}`,
      repro: `decodeSource(encodeSource(${target}))`,
    });
  }

  // --- (c) mergeInstancesIntoPsdl(source, mirror) lift renders identically ---
  // This is the lossless lift the app uses for share/export of a built-in or
  // imported packet (it merges the renderer mirror's instance edits onto the
  // retained source PSDL). With no edits it must be a layout no-op.
  try {
    const lifted = mergeInstancesIntoPsdl(src, mirror);
    const liftedMirror = psdlToRenderer(lifted);
    const sig = layoutSignature(resolveAsApp(lifted, liftedMirror, {}));
    if (sig !== baseSig) {
      report({
        kind: "I3",
        target,
        detail:
          "mergeInstancesIntoPsdl(source,mirror) lift changed the resolved layout",
        repro: `resolveAsApp(mergeInstancesIntoPsdl(${target}, mirror)) != original`,
      });
    }
  } catch (e) {
    report({
      kind: "I3",
      target,
      detail: `mergeInstancesIntoPsdl lift threw: ${(e as Error).message}`,
      repro: `mergeInstancesIntoPsdl(${target}, mirror)`,
    });
  }
}

function diffCensus(
  target: string,
  via: string,
  before: ReturnType<typeof structuralKeyCensus>,
  after: ReturnType<typeof structuralKeyCensus>,
) {
  const drops: string[] = [];
  if (after.fields < before.fields)
    drops.push(`body ${before.fields}→${after.fields}`);
  if (after.defs < before.defs) drops.push(`defs ${before.defs}→${after.defs}`);
  if (after.constraints < before.constraints)
    drops.push(`constraints ${before.constraints}→${after.constraints}`);
  if (before.meta && !after.meta) drops.push("meta dropped");
  if (before.byteOrder && !after.byteOrder) drops.push("byteOrder dropped");
  if (drops.length > 0) {
    report({
      kind: "I3",
      target,
      detail: `${via} dropped structure: ${drops.join(", ")}`,
      repro: `${via}(${target})`,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SYNTHETIC CORPUS — every PSDL 0.5 construct + nested combinations.
// ─────────────────────────────────────────────────────────────────────────────
const lit = (value: number): Expr => ({ kind: "lit", value });
const ref = (field: string): Expr => ({ kind: "ref", field });

function pkt(
  name: string,
  body: Container[],
  extra: Partial<PsdlPacket> = {},
): PsdlPacket {
  return { name, rowBits: 32, body, ...extra } as PsdlPacket;
}

const intF = (
  id: string,
  bits: number,
  e: Partial<Container> = {},
): Container =>
  ({
    kind: "field",
    id,
    name: id,
    type: { kind: "int", bits },
    ...e,
  }) as Container;

function syntheticCorpus(): Record<string, PsdlPacket> {
  const out: Record<string, PsdlPacket> = {};

  // 1. Plain fields: int / bits / bytes(fixed) / enum / varint / berLength.
  out["syn-scalars"] = pkt("syn-scalars", [
    intF("a", 8),
    {
      kind: "field",
      id: "b",
      name: "b",
      type: { kind: "bits", n: 4 },
    } as Container,
    {
      kind: "field",
      id: "c",
      name: "c",
      type: { kind: "bits", n: 4 },
    } as Container,
    {
      kind: "field",
      id: "e",
      name: "e",
      type: { kind: "enum", bits: 8, variants: { 0: "zero", 1: "one" } },
    } as Container,
    {
      kind: "field",
      id: "v",
      name: "v",
      type: { kind: "varint", encoding: "leb128" },
    } as Container,
    {
      kind: "field",
      id: "bl",
      name: "bl",
      type: { kind: "berLength" },
    } as Container,
    {
      kind: "field",
      id: "fx",
      name: "fx",
      type: { kind: "bytes", n: lit(4) },
    } as Container,
  ]);

  // 2. bytes(ref X) — direct length controller (freeze-prone).
  out["syn-direct-length"] = pkt("syn-direct-length", [
    intF("len", 16),
    {
      kind: "field",
      id: "payload",
      name: "payload",
      type: { kind: "bytes", n: ref("len") },
    } as Container,
  ]);

  // 3. bytes(remaining) — end-anchored variable payload.
  out["syn-remaining"] = pkt("syn-remaining", [
    intF("h", 8),
    {
      kind: "field",
      id: "rest",
      name: "rest",
      type: { kind: "bytes", n: { kind: "remaining" } },
    } as Container,
  ]);

  // 4. bytes(delimited) — delimiter-terminated payload.
  out["syn-delimited"] = pkt("syn-delimited", [
    {
      kind: "field",
      id: "str",
      name: "str",
      type: { kind: "bytes", n: { delimiter: [0] } },
    } as Container,
    intF("tail", 8),
  ]);

  // 5. group.
  out["syn-group"] = pkt("syn-group", [
    {
      kind: "group",
      id: "g",
      name: "g",
      children: [intF("g1", 8), intF("g2", 16)],
    } as Container,
  ]);

  // 6. repeat with literal count.
  out["syn-repeat-count"] = pkt("syn-repeat-count", [
    intF("n", 8),
    {
      kind: "repeat",
      id: "items",
      count: lit(3),
      element: { id: "item", fields: [intF("x", 8), intF("y", 8)] },
    } as Container,
  ]);

  // 7. repeat count: ref X (count-driven freeRepeat).
  out["syn-repeat-ref"] = pkt("syn-repeat-ref", [
    intF("cnt", 8),
    {
      kind: "repeat",
      id: "list",
      count: ref("cnt"),
      element: { id: "le", fields: [intF("z", 16)] },
    } as Container,
  ]);

  // 8. repeat eos inside a bounded scope (boundedRepeat / length-derived count).
  out["syn-bounded-eos"] = pkt("syn-bounded-eos", [
    intF("blen", 16),
    {
      kind: "bounded",
      id: "scope",
      bytes: ref("blen"),
      fields: [
        {
          kind: "repeat",
          id: "recs",
          count: "eos",
          element: { id: "rec", fields: [intF("rt", 8), intF("rv", 8)] },
        } as Container,
      ],
    } as Container,
  ]);

  // 9. repeat with count.until predicate.
  out["syn-repeat-until"] = pkt("syn-repeat-until", [
    {
      kind: "repeat",
      id: "u",
      count: {
        until: {
          kind: "op",
          op: "==",
          a: { kind: "prevIter", field: "mark" },
          b: lit(0),
        },
      },
      element: { id: "ue", fields: [intF("mark", 8)] },
    } as Container,
  ]);

  // 10. switch on ref (TLV-style discriminator).
  out["syn-switch"] = pkt("syn-switch", [
    {
      kind: "field",
      id: "t",
      name: "t",
      type: { kind: "enum", bits: 8, variants: { 1: "a", 2: "b" } },
    } as Container,
    {
      kind: "switch",
      id: "sw",
      on: ref("t"),
      cases: {
        "1": { id: "arm1", fields: [intF("a1", 16)] },
        "2": { id: "arm2", fields: [intF("b1", 32)] },
        _: {
          id: "armdef",
          fields: [
            {
              kind: "field",
              id: "raw",
              name: "raw",
              type: { kind: "bytes", n: { kind: "remaining" } },
            } as Container,
          ],
        },
      },
    } as Container,
  ]);

  // 11. switch on peek (read-ahead discriminator).
  out["syn-switch-peek"] = pkt("syn-switch-peek", [
    {
      kind: "switch",
      id: "pk",
      on: { kind: "peek", bits: 4 } as Expr,
      cases: {
        "0": { id: "p0", fields: [intF("p0a", 8)] },
        _: { id: "pd", fields: [intF("pda", 8)] },
      },
    } as Container,
  ]);

  // 12. optional (when ref). The `container` is a Container (a Group here).
  out["syn-optional"] = pkt("syn-optional", [
    intF("flag", 8),
    {
      kind: "optional",
      id: "opt",
      when: ref("flag"),
      container: {
        kind: "group",
        id: "oc",
        name: "oc",
        children: [intF("oval", 32)],
      },
    } as Container,
  ]);

  // 13. encrypted (with wireBits + contextNote) wrapping a plaintext struct.
  out["syn-encrypted"] = pkt("syn-encrypted", [
    intF("elen", 16),
    {
      kind: "encrypted",
      id: "enc",
      contextNote: "AEAD payload, key out of band",
      wireBits: { kind: "op", op: "*", a: ref("elen"), b: lit(8) },
      plaintext: {
        id: "pt",
        fields: [
          intF("inner", 8),
          {
            kind: "field",
            id: "body",
            name: "body",
            type: { kind: "bytes", n: { kind: "remaining" } },
          } as Container,
        ],
      },
    } as Container,
  ]);

  // 14. align.
  out["syn-align"] = pkt("syn-align", [
    intF("x", 8),
    { kind: "align", to: 32 } as Container,
    intF("y", 8),
  ]);

  // 15. virtual (computed, zero-width).
  out["syn-virtual"] = pkt("syn-virtual", [
    intF("hi", 8),
    intF("lo", 8),
    {
      kind: "virtual",
      id: "combined",
      expr: { kind: "op", op: "+", a: ref("hi"), b: ref("lo") },
    } as Container,
  ]);

  // 16. defs + ref container (named struct reuse, recursive-capable).
  out["syn-defs-ref"] = pkt(
    "syn-defs-ref",
    [
      intF("head", 8),
      { kind: "ref", id: "r1", ref: "Pair" } as Container,
      { kind: "ref", id: "r2", ref: "Pair" } as Container,
    ],
    { defs: { Pair: { id: "Pair", fields: [intF("k", 8), intF("vv", 8)] } } },
  );

  // 17. byteOrder at packet + field level (LE words).
  out["syn-byteorder"] = pkt(
    "syn-byteorder",
    [
      intF("be", 16),
      {
        kind: "field",
        id: "le",
        name: "le",
        type: { kind: "int", bits: 16 },
        byteOrder: "LE",
      } as Container,
    ],
    { byteOrder: "BE" },
  );

  // 18. subfields (mask-addressed bit annotations).
  out["syn-subfields"] = pkt("syn-subfields", [
    {
      kind: "field",
      id: "flags",
      name: "flags",
      type: { kind: "int", bits: 8 },
      subfields: [
        { id: "sf_a", name: "A", mask: 0x80 },
        { id: "sf_b", name: "B", mask: 0x7f },
      ],
    } as Container,
  ]);

  // 19. meta (RFC provenance) on packet + field.
  out["syn-meta"] = pkt(
    "syn-meta",
    [
      intF("m", 8, {
        meta: { rfc: 791, section: "3.1" },
      } as Partial<Container>),
    ],
    { meta: { rfc: 791 } as never },
  );

  // ── NESTED COMBINATIONS ──

  // 20. repeat of switch (TLV records), bounded — flat TLV.
  out["syn-tlv-bounded"] = pkt("syn-tlv-bounded", [
    intF("total", 16),
    {
      kind: "bounded",
      id: "tlvscope",
      bytes: ref("total"),
      fields: [
        {
          kind: "repeat",
          id: "tlvs",
          count: "eos",
          element: {
            id: "tlv",
            fields: [
              {
                kind: "field",
                id: "tt",
                name: "tt",
                type: { kind: "enum", bits: 8, variants: { 1: "x" } },
              } as Container,
              intF("tl", 8),
              {
                kind: "field",
                id: "tv",
                name: "tv",
                type: { kind: "bytes", n: ref("tl") },
              } as Container,
            ],
          },
        } as Container,
      ],
    } as Container,
  ]);

  // 21. repeat nested in repeat (product-cap territory).
  out["syn-repeat-in-repeat"] = pkt("syn-repeat-in-repeat", [
    intF("outerCnt", 8),
    {
      kind: "repeat",
      id: "outer",
      count: ref("outerCnt"),
      element: {
        id: "oe",
        fields: [
          intF("innerCnt", 8),
          {
            kind: "repeat",
            id: "inner",
            count: ref("innerCnt"),
            element: { id: "ie", fields: [intF("iv", 8)] },
          } as Container,
        ],
      },
    } as Container,
  ]);

  // 22. switch arm containing a repeat containing a switch (deep nesting).
  out["syn-deep-nest"] = pkt("syn-deep-nest", [
    {
      kind: "field",
      id: "dt",
      name: "dt",
      type: { kind: "enum", bits: 8, variants: { 1: "rep" } },
    } as Container,
    {
      kind: "switch",
      id: "dsw",
      on: ref("dt"),
      cases: {
        "1": {
          id: "darm",
          fields: [
            intF("dcount", 8),
            {
              kind: "repeat",
              id: "drep",
              count: ref("dcount"),
              element: {
                id: "dre",
                fields: [
                  {
                    kind: "field",
                    id: "dst",
                    name: "dst",
                    type: { kind: "enum", bits: 8, variants: { 0: "z" } },
                  } as Container,
                  {
                    kind: "switch",
                    id: "dsw2",
                    on: ref("dst"),
                    cases: {
                      "0": { id: "z0", fields: [intF("zv", 16)] },
                      _: { id: "zd", fields: [intF("zd1", 8)] },
                    },
                  } as Container,
                ],
              },
            } as Container,
          ],
        },
        _: { id: "ddef", fields: [intF("ddv", 8)] },
      },
    } as Container,
  ]);

  // 23. optional wrapping a bounded eos repeat (per-record length).
  out["syn-optional-bounded"] = pkt("syn-optional-bounded", [
    intF("present", 8),
    {
      kind: "optional",
      id: "ob",
      when: ref("present"),
      container: {
        kind: "group",
        id: "obc",
        name: "obc",
        children: [
          intF("oblen", 16),
          {
            kind: "bounded",
            id: "obscope",
            bytes: ref("oblen"),
            fields: [
              {
                kind: "repeat",
                id: "obrep",
                count: "eos",
                element: { id: "obre", fields: [intF("obv", 16)] },
              } as Container,
            ],
          } as Container,
        ],
      },
    } as Container,
  ]);

  // 24. group containing a length controller for a sibling bytes(ref).
  out["syn-group-length"] = pkt("syn-group-length", [
    {
      kind: "group",
      id: "hdr",
      name: "hdr",
      children: [intF("gver", 8), intF("glen", 16)],
    } as Container,
    {
      kind: "field",
      id: "gpayload",
      name: "gpayload",
      type: { kind: "bytes", n: ref("glen") },
    } as Container,
  ]);

  // 25. wireSize-driven length (computed).
  out["syn-wiresize"] = pkt("syn-wiresize", [
    {
      kind: "group",
      id: "wg",
      name: "wg",
      children: [intF("wa", 8), intF("wb", 8)],
    } as Container,
    {
      kind: "virtual",
      id: "wlen",
      expr: { kind: "wireSize", target: "wg" } as Expr,
    } as Container,
  ]);

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
function runCorpus(corpus: Record<string, PsdlPacket>, validateFirst: boolean) {
  for (const [key, src] of Object.entries(corpus)) {
    if (validateFirst) {
      // Synthetic packets must be valid PSDL or they're a harness bug, not an
      // app violation. Skip (with a stderr note) any that don't validate.
      try {
        validatePsdlPacket(src as never);
      } catch (e) {
        process.stderr.write(
          `[harness] skipping invalid synthetic '${key}': ${(e as Error).message}\n`,
        );
        continue;
      }
    }
    let mirror: RendererPacket;
    try {
      mirror = psdlToRenderer(src);
    } catch (e) {
      report({
        kind: "I1",
        target: key,
        detail: `psdlToRenderer threw: ${(e as Error).message}`,
        repro: `psdlToRenderer(${key})`,
      });
      continue;
    }
    checkI1(key, src, mirror);
    checkI2(key, src, mirror);
    checkI3(key, src, mirror);
  }
}

// Run the whole corpus once; vitest asserts ZERO violations and prints the
// concrete JSON list so a non-empty run is both red AND legible.
describe("override-invariants (CI-excluded diagnostic)", () => {
  it("emits zero I1/I2/I3 violations across presets + synthetic corpus", () => {
    runCorpus(PRESETS as Record<string, PsdlPacket>, false);
    runCorpus(syntheticCorpus(), true);

    const synthetic = syntheticCorpus();
    process.stdout.write(
      `\n[harness] presets=${Object.keys(PRESETS).length} ` +
        `synthetic=${Object.keys(synthetic).length} ` +
        `violations=${violations.length}\n`,
    );
    process.stdout.write(JSON.stringify(violations, null, 2) + "\n");

    expect(violations).toEqual([]);
  });
});
