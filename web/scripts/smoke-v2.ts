// Smoke tests for the v2 model. Verifies:
//   1. evalExpr arithmetic, refs, and conditionals.
//   2. Constraint solver round-trips for IHL ⇔ headerBytes.
//   3. All 13 v2 presets normalize() into a flat NormalizedField[] whose
//      totalBits equals v1's resolvePacket(...).totalBits.

import { PRESETS as V1_PRESETS } from "../lib/presets.generated";
import { initialState, resolvePacket } from "../lib/packet-resolver";
import { propagate } from "../lib/v2/constraint";
import { cond, evalExpr, lit, op, ref } from "../lib/v2/expr";
import { initialEnv, normalize } from "../lib/v2/normalize";
import { GENERATED_PRESETS } from "../lib/v2/presets.generated";
import { MANUAL_PRESETS } from "../lib/v2/presets";
import type { Constraint, Expr, Packet, PacketEnv } from "../lib/v2/types";

let failures = 0;
function assertEq<T>(label: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(`  FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ok   ${label}`);
  }
}

/* ---------- 1. evalExpr ---------- */
function testExpr(): void {
  console.log("[expr]");
  const env: PacketEnv = new Map([["a", 5], ["b", 3]]);
  assertEq("lit", evalExpr(lit(7), env), 7);
  assertEq("ref", evalExpr(ref("a"), env), 5);
  assertEq("add", evalExpr(op("+", ref("a"), ref("b")), env), 8);
  assertEq("mul", evalExpr(op("*", ref("a"), lit(4)), env), 20);
  assertEq("div trunc", evalExpr(op("/", ref("a"), ref("b")), env), 1);
  assertEq("mod", evalExpr(op("%", ref("a"), ref("b")), env), 2);
  assertEq("shl", evalExpr(op("<<", ref("a"), lit(2)), env), 20);
  assertEq("shr", evalExpr(op(">>", lit(20), lit(2)), env), 5);
  assertEq(
    "cond truthy",
    evalExpr(cond(ref("a"), lit(1), lit(0)), env),
    1,
  );
  assertEq(
    "cond falsy",
    evalExpr(cond(lit(0), lit(1), lit(2)), env),
    2,
  );
  try {
    evalExpr(ref("missing"), env);
    failures++;
    console.error("  FAIL missing ref: expected throw");
  } catch {
    console.log("  ok   missing ref throws");
  }
}

/* ---------- 2. Constraint solver: IHL ⇔ headerBytes ---------- */
function testConstraint(): void {
  console.log("[constraint]");
  const constraints: Constraint[] = [
    { lhs: op("*", ref("ihl"), lit(4)), rhs: ref("headerBytes") },
  ];

  // Direction 1: set IHL=7 → headerBytes propagates to 28.
  const start: PacketEnv = new Map([["ihl", 7], ["headerBytes", 20]]);
  const r1 = propagate(constraints, start, "ihl");
  if ("conflict" in r1) {
    failures++;
    console.error(`  FAIL ihl=7 propagate: ${r1.conflict}`);
  } else {
    assertEq("ihl=7 → headerBytes=28", r1.ok.get("headerBytes"), 28);
  }

  // Direction 2: set headerBytes=32 → IHL propagates to 8.
  const start2: PacketEnv = new Map([["ihl", 5], ["headerBytes", 32]]);
  const r2 = propagate(constraints, start2, "headerBytes");
  if ("conflict" in r2) {
    failures++;
    console.error(`  FAIL headerBytes=32 propagate: ${r2.conflict}`);
  } else {
    assertEq("headerBytes=32 → ihl=8", r2.ok.get("ihl"), 8);
  }
}

/* ---------- 3. Preset parity ---------- */
function v1TotalBits(key: string): number {
  const packet = V1_PRESETS[key];
  return resolvePacket(packet, initialState(packet)).totalBits;
}

function v2TotalBits(packet: Packet): number {
  // Seed env with zero option/chain counts so generated presets normalize.
  const env: PacketEnv = initialEnv(packet);
  // Generic env keys produced by the migrator:
  for (const k of [
    "options_count",
    "options_kind",
    "extensions_count",
    "extensions_kind",
    "options_proto",
    "options_chainCount",
    "nextHeader_chainCount",
    "nextHeader_proto",
    "ipv4OptionsCount",
    "tcpOptionsCount",
  ]) {
    if (!env.has(k)) env.set(k, 0);
  }
  // Discriminator placeholders so any Switch encountered evaluates.
  for (const [refName] of collectAllRefs(packet)) {
    if (!env.has(refName)) env.set(refName, 0);
  }
  return normalize(packet, env).totalBits;
}

function collectAllRefs(packet: Packet): Set<string> {
  const out = new Set<string>();
  const visit = (e: Expr) => {
    switch (e.kind) {
      case "lit":
        return;
      case "ref":
        out.add(e.field);
        return;
      case "op":
        visit(e.a);
        visit(e.b);
        return;
      case "cond":
        visit(e.test);
        visit(e.t);
        visit(e.f);
        return;
    }
  };
  const walk = (containers: unknown[]) => {
    for (const c of containers) {
      const node = c as { kind?: string; type?: { kind: string; n?: Expr }; element?: { fields: unknown[] }; children?: unknown[]; cases?: Record<string, { fields: unknown[] }>; default?: { fields: unknown[] }; on?: Expr; count?: Expr | string | { until: Expr } };
      if (!node.kind || node.kind === "field") {
        if (node.type?.kind === "bytes" && node.type.n) visit(node.type.n);
        continue;
      }
      if (node.kind === "group" && node.children) walk(node.children);
      if (node.kind === "switch") {
        if (node.on) visit(node.on);
        for (const v of Object.values(node.cases ?? {})) walk(v.fields);
        if (node.default) walk(node.default.fields);
      }
      if (node.kind === "repeat") {
        if (node.count && typeof node.count === "object" && "kind" in node.count) visit(node.count as Expr);
        if (node.element) walk(node.element.fields);
      }
    }
  };
  walk(packet.body as unknown[]);
  return out;
}

function testPresets(): void {
  console.log("[presets]");
  const allV2: Record<string, Packet> = {
    ...MANUAL_PRESETS,
    ...GENERATED_PRESETS,
  };
  for (const key of Object.keys(V1_PRESETS)) {
    const v1 = v1TotalBits(key);
    const v2 = allV2[key];
    if (!v2) {
      failures++;
      console.error(`  FAIL ${key}: no v2 preset`);
      continue;
    }
    const v2bits = v2TotalBits(v2);
    assertEq(`${key} totalBits`, v2bits, v1);
  }
}

testExpr();
testConstraint();
testPresets();

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll smoke checks passed.");
