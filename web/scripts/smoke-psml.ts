// PSML 0.2 — smoke tests.
//
// Verifies:
//   1. evalExpr arithmetic, refs, and conditionals.
//   2. Constraint solver round-trips for IHL ⇔ headerBytes.
//   3. Every runtime preset resolves via the renderer-side resolver and the
//      PSML migration of the same preset normalizes to a matching totalBits.
//   4. Format hub: toJson(psml) → fromJson() round-trips.
//   5. JSON Schema (schemas/psml.schema.json) validates every preset's JSON.

import { initialState, resolvePacket } from "../lib/psml/runtime-resolver";
import { PRESETS as RUNTIME_PRESETS } from "../lib/psml/runtime-presets";
import { propagate } from "../lib/psml/constraint";
import { cond, evalExpr, lit, op, ref } from "../lib/psml/expr";
import { initialEnv, normalize } from "../lib/psml/normalize";
import { GENERATED_PRESETS } from "../lib/psml/presets.generated";
import { MANUAL_PRESETS } from "../lib/psml/presets";
import type { Constraint, Expr, Packet, PacketEnv } from "../lib/psml/types";
import { fromJson, toJson } from "../lib/formats/json";
import { runtimeToPsml } from "../lib/psml/runtime-to-psml";
import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
function assertEq<T>(label: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(
      `  FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  } else {
    console.log(`  ok   ${label}`);
  }
}
function assertTrue(label: string, ok: boolean, detail?: string): void {
  if (!ok) {
    failures++;
    console.error(`  FAIL ${label}${detail ? ": " + detail : ""}`);
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
  assertEq("cond truthy", evalExpr(cond(ref("a"), lit(1), lit(0)), env), 1);
  assertEq("cond falsy", evalExpr(cond(lit(0), lit(1), lit(2)), env), 2);
  try {
    evalExpr(ref("missing"), env);
    failures++;
    console.error("  FAIL missing ref: expected throw");
  } catch {
    console.log("  ok   missing ref throws");
  }
}

/* ---------- 2. Constraint solver ---------- */
function testConstraint(): void {
  console.log("[constraint]");
  const constraints: Constraint[] = [
    { lhs: op("*", ref("ihl"), lit(4)), rhs: ref("headerBytes") },
  ];
  const start: PacketEnv = new Map([["ihl", 7], ["headerBytes", 20]]);
  const r1 = propagate(constraints, start, "ihl");
  if ("conflict" in r1) {
    failures++;
    console.error(`  FAIL ihl=7 propagate: ${r1.conflict}`);
  } else {
    assertEq("ihl=7 → headerBytes=28", r1.ok.get("headerBytes"), 28);
  }
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
function runtimeTotalBits(key: string): number {
  const packet = RUNTIME_PRESETS[key];
  return resolvePacket(packet, initialState(packet)).totalBits;
}

function psmlTotalBits(packet: Packet): number {
  const env: PacketEnv = initialEnv(packet);
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
  for (const refName of collectAllRefs(packet)) {
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
      const node = c as {
        kind?: string;
        type?: { kind: string; n?: Expr };
        element?: { fields: unknown[] };
        children?: unknown[];
        cases?: Record<string, { fields: unknown[] }>;
        default?: { fields: unknown[] };
        on?: Expr;
        count?: Expr | string | { until: Expr };
      };
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
        if (node.count && typeof node.count === "object" && "kind" in node.count) {
          visit(node.count as Expr);
        }
        if (node.element) walk(node.element.fields);
      }
    }
  };
  walk(packet.body as unknown[]);
  return out;
}

function testPresets(): void {
  console.log("[presets]");
  const allPsml: Record<string, Packet> = { ...MANUAL_PRESETS, ...GENERATED_PRESETS };
  for (const key of Object.keys(RUNTIME_PRESETS)) {
    const runtime = runtimeTotalBits(key);
    assertTrue(`${key} runtime layout > 0`, runtime > 0);
    const psmlPacket = allPsml[key];
    if (!psmlPacket) {
      failures++;
      console.error(`  FAIL ${key}: no PSML preset`);
      continue;
    }
    const psmlBits = psmlTotalBits(psmlPacket);
    assertEq(`${key} totalBits`, psmlBits, runtime);
  }
}

/* ---------- 4. Format hub round-trip ---------- */
function testJsonRoundtrip(): void {
  console.log("[formats/json round-trip]");
  for (const key of Object.keys(RUNTIME_PRESETS)) {
    const runtime = RUNTIME_PRESETS[key];
    const psml = runtimeToPsml(runtime);
    let json: string;
    try {
      json = toJson(psml, new Map());
    } catch (e) {
      failures++;
      console.error(`  FAIL ${key}: toJson threw ${(e as Error).message}`);
      continue;
    }
    let parsed: { packet: Packet };
    try {
      parsed = fromJson(json);
    } catch (e) {
      failures++;
      console.error(`  FAIL ${key}: fromJson threw ${(e as Error).message}`);
      continue;
    }
    assertEq(`${key} round-trip name`, parsed.packet.name, psml.name);
    assertEq(`${key} round-trip rowBits`, parsed.packet.rowBits, psml.rowBits);
  }
}

/* ---------- 5. JSON Schema ---------- */
function testJsonSchema(): void {
  console.log("[schemas/psml.schema.json]");
  const here = dirname(fileURLToPath(import.meta.url));
  const schemaPath = resolvePath(here, "../../schemas/psml.schema.json");
  let schema: unknown;
  try {
    schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  } catch (e) {
    failures++;
    console.error(`  FAIL load schema: ${(e as Error).message}`);
    return;
  }
  const allPsml: Record<string, Packet> = { ...MANUAL_PRESETS, ...GENERATED_PRESETS };
  for (const key of Object.keys(allPsml)) {
    const psml = allPsml[key];
    const json = JSON.parse(toJson(psml, new Map()));
    const errors = validateJsonAgainstSchema(json, schema);
    if (errors.length === 0) {
      console.log(`  ok   ${key} matches psml.schema.json`);
    } else {
      failures++;
      console.error(`  FAIL ${key} schema errors:`);
      for (const err of errors.slice(0, 5)) console.error(`        ${err}`);
    }
  }
}

/**
 * Tiny schema checker — supports type, required, properties,
 * additionalProperties (false or schema), oneOf, const, enum, items, $ref
 * (local), and patternProperties. Sufficient for our PSML schema.
 */
function validateJsonAgainstSchema(value: unknown, root: unknown): string[] {
  const errs: string[] = [];
  function deref(schema: unknown): unknown {
    if (schema && typeof schema === "object" && "$ref" in schema) {
      const ref = (schema as { $ref: string }).$ref;
      if (ref.startsWith("#/")) {
        const parts = ref.slice(2).split("/");
        let cur: unknown = root;
        for (const p of parts) {
          if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[p];
          else return undefined;
        }
        return cur;
      }
    }
    return schema;
  }
  function check(value: unknown, schema: unknown, path: string): void {
    schema = deref(schema);
    if (!schema || typeof schema !== "object") return;
    const s = schema as Record<string, unknown>;
    if (Array.isArray(s.oneOf)) {
      let matched = 0;
      for (const sub of s.oneOf) {
        const before = errs.length;
        check(value, sub, path);
        const subErrs = errs.splice(before);
        if (subErrs.length === 0) matched++;
      }
      if (matched !== 1) {
        errs.push(`${path}: oneOf matched ${matched} variants (expected 1)`);
      }
      return;
    }
    if (s.const !== undefined && value !== s.const) {
      errs.push(
        `${path}: expected const ${JSON.stringify(s.const)}, got ${JSON.stringify(value)}`,
      );
    }
    if (Array.isArray(s.enum) && !s.enum.includes(value as never)) {
      errs.push(`${path}: value ${JSON.stringify(value)} not in enum`);
    }
    if (typeof s.type === "string") {
      const t = s.type;
      const actual = Array.isArray(value)
        ? "array"
        : value === null
          ? "null"
          : typeof value;
      const ok =
        (t === "integer" && typeof value === "number" && Number.isInteger(value)) ||
        (t === "number" && typeof value === "number") ||
        (t === "string" && typeof value === "string") ||
        (t === "boolean" && typeof value === "boolean") ||
        (t === "object" && actual === "object") ||
        (t === "array" && actual === "array") ||
        (t === "null" && value === null);
      if (!ok) {
        errs.push(`${path}: expected ${t}, got ${actual}`);
        return;
      }
    }
    if (
      Array.isArray(s.required) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      for (const k of s.required) {
        if (!(k in (value as Record<string, unknown>))) {
          errs.push(`${path}: missing required ${k}`);
        }
      }
    }
    if (s.properties && value && typeof value === "object" && !Array.isArray(value)) {
      const props = s.properties as Record<string, unknown>;
      for (const k of Object.keys(value as Record<string, unknown>)) {
        if (k in props) {
          check((value as Record<string, unknown>)[k], props[k], `${path}.${k}`);
        } else if (s.additionalProperties === false) {
          errs.push(`${path}.${k}: not allowed (additionalProperties=false)`);
        } else if (s.additionalProperties && typeof s.additionalProperties === "object") {
          check(
            (value as Record<string, unknown>)[k],
            s.additionalProperties,
            `${path}.${k}`,
          );
        }
      }
    }
    if (s.items && Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        check(value[i], s.items, `${path}[${i}]`);
      }
    }
    if (s.patternProperties && value && typeof value === "object" && !Array.isArray(value)) {
      const pp = s.patternProperties as Record<string, unknown>;
      for (const [pat, sub] of Object.entries(pp)) {
        const re = new RegExp(pat);
        for (const k of Object.keys(value as Record<string, unknown>)) {
          if (re.test(k)) check((value as Record<string, unknown>)[k], sub, `${path}.${k}`);
        }
      }
    }
  }
  check(value, root, "$");
  return errs;
}

testExpr();
testConstraint();
testPresets();
testJsonRoundtrip();
testJsonSchema();

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll smoke checks passed.");
