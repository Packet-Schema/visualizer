// PSML 0.2 — Kaitai .ksy smoke test.
//
// For each .ksy file in web/data/ksy-examples:
//   1. fromKsy(text) — must succeed; print totalBits and warning count
//   2. normalize() — confirm the packet lays out without throwing
//   3. toKsy(fromKsy(text).packet) — must produce text that re-parses as YAML

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as yamlParse } from "yaml";

import { fromKsy, toKsy } from "../lib/formats/ksy";
import { initialEnv, normalize } from "../lib/psml/normalize";
import type { PacketEnv } from "../lib/psml/types";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolvePath(here, "../data/ksy-examples");

let failures = 0;

function envWithZeros(packet: ReturnType<typeof fromKsy>["packet"]): PacketEnv {
  // Seed every referenced field to 0 so normalize() can compute lengths even
  // when the .ksy uses dynamic sizes / conditionals.
  const env = initialEnv(packet);
  const refs = collectAllRefs(packet);
  for (const r of refs) if (!env.has(r)) env.set(r, 0);
  return env;
}

type AnyExpr = { kind?: string; field?: string; a?: AnyExpr; b?: AnyExpr; test?: AnyExpr; t?: AnyExpr; f?: AnyExpr };

function collectAllRefs(packet: ReturnType<typeof fromKsy>["packet"]): Set<string> {
  const out = new Set<string>();
  const visit = (e: AnyExpr | undefined) => {
    if (!e || typeof e !== "object") return;
    if (e.kind === "ref" && typeof e.field === "string") out.add(e.field);
    if (e.kind === "op") { visit(e.a); visit(e.b); }
    if (e.kind === "cond") { visit(e.test); visit(e.t); visit(e.f); }
  };
  type AnyNode = {
    kind?: string;
    type?: { kind: string; n?: AnyExpr };
    element?: { fields: AnyNode[] };
    children?: AnyNode[];
    cases?: Record<string, { fields: AnyNode[] }>;
    default?: { fields: AnyNode[] };
    on?: AnyExpr;
    count?: AnyExpr | string | { until: AnyExpr };
  };
  const walk = (nodes: AnyNode[]) => {
    for (const n of nodes) {
      if (!n.kind || n.kind === "field") {
        if (n.type?.kind === "bytes") visit(n.type.n);
        continue;
      }
      if (n.kind === "group" && n.children) walk(n.children);
      if (n.kind === "switch") {
        visit(n.on);
        for (const v of Object.values(n.cases ?? {})) walk(v.fields);
        if (n.default) walk(n.default.fields);
      }
      if (n.kind === "repeat") {
        if (n.count && typeof n.count === "object" && "kind" in n.count) visit(n.count as AnyExpr);
        if (n.element) walk(n.element.fields);
      }
    }
  };
  walk(packet.body as unknown as AnyNode[]);
  return out;
}

function runSample(name: string, text: string): void {
  console.log(`\n[${name}]`);
  let result: ReturnType<typeof fromKsy>;
  try {
    result = fromKsy(text);
  } catch (e) {
    failures++;
    console.error(`  FAIL fromKsy threw: ${(e as Error).message}`);
    return;
  }
  const { packet, warnings } = result;
  console.log(`  ok   fromKsy → "${packet.name}" (${packet.body.length} top-level node(s))`);
  console.log(`  info warnings: ${warnings.length}`);
  for (const w of warnings) console.log(`         - ${w}`);

  // Normalise.
  let totalBits = 0;
  try {
    const env = envWithZeros(packet);
    const n = normalize(packet, env);
    totalBits = n.totalBits;
    console.log(`  ok   normalize → totalBits=${totalBits} fields=${n.fields.length}`);
  } catch (e) {
    failures++;
    console.error(`  FAIL normalize threw: ${(e as Error).message}`);
  }

  // Round-trip.
  let exported = "";
  try {
    exported = toKsy(packet);
    console.log(`  ok   toKsy produced ${exported.length} bytes`);
  } catch (e) {
    failures++;
    console.error(`  FAIL toKsy threw: ${(e as Error).message}`);
    return;
  }
  try {
    const re = yamlParse(exported);
    if (!re || typeof re !== "object") {
      failures++;
      console.error("  FAIL exported YAML did not re-parse as a mapping");
    } else {
      console.log("  ok   exported YAML re-parses");
    }
  } catch (e) {
    failures++;
    console.error(`  FAIL exported YAML re-parse threw: ${(e as Error).message}`);
  }
}

function main(): void {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".ksy")).sort();
  } catch (e) {
    console.error(`Failed to list ${dir}: ${(e as Error).message}`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error(`No .ksy files found under ${dir}`);
    process.exit(1);
  }
  console.log(`Found ${files.length} sample(s) in ${dir}`);
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    runSample(f, text);
  }
  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nAll Kaitai smoke checks passed.");
}

main();
