// Build-time conversion of data/presets.typ → lib/presets.generated.ts.
//
// Reads the Typst source, runs it through our minimal Typst parser, validates
// each preset against the Packet type, and emits a TypeScript module that
// exports a typed PRESETS registry plus PRESET_KEYS.
//
// Re-attaches `toBits` lazily at runtime via lib/packet-resolver.ts so the
// generated file stays pure JSON-like.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseTypst, type JsValue } from "../lib/typst-parser";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const srcPath = resolve(root, "data/presets.typ");
const outPath = resolve(root, "lib/presets.generated.ts");

function isPlainObject(v: JsValue): v is { [key: string]: JsValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asObj(v: JsValue, ctx: string): { [key: string]: JsValue } {
  if (!isPlainObject(v)) {
    throw new Error(`build-presets: expected dict at ${ctx}, got ${typeof v}`);
  }
  return v;
}

function asArr(v: JsValue, ctx: string): JsValue[] {
  if (!Array.isArray(v)) {
    throw new Error(`build-presets: expected array at ${ctx}, got ${typeof v}`);
  }
  return v;
}

function validateTlvCatalogEntry(key: string, fieldId: string, idx: number, v: JsValue): void {
  const e = asObj(v, `presets.${key}.${fieldId}.tlv.catalog[${idx}]`);
  if (typeof e.kind !== "number") {
    throw new Error(
      `build-presets: preset "${key}" field "${fieldId}" tlv catalog[${idx}] missing numeric kind`,
    );
  }
  if (typeof e.name !== "string") {
    throw new Error(
      `build-presets: preset "${key}" field "${fieldId}" tlv catalog[${idx}] missing name`,
    );
  }
  if (e.fields !== undefined) {
    const f = asArr(e.fields, `presets.${key}.${fieldId}.tlv.catalog[${idx}].fields`);
    for (let i = 0; i < f.length; i++) {
      const sf = asObj(f[i], `presets.${key}.${fieldId}.tlv.catalog[${idx}].fields[${i}]`);
      if (typeof sf.id !== "string" || typeof sf.name !== "string" || typeof sf.bits !== "number") {
        throw new Error(
          `build-presets: preset "${key}" field "${fieldId}" tlv catalog[${idx}].fields[${i}] needs id/name/bits`,
        );
      }
    }
  } else if (typeof e.fieldsFormula !== "string") {
    throw new Error(
      `build-presets: preset "${key}" field "${fieldId}" tlv catalog[${idx}] needs either fields or fieldsFormula`,
    );
  }
}

function validateTlv(key: string, fieldId: string, v: JsValue): void {
  const t = asObj(v, `presets.${key}.${fieldId}.tlv`);
  const catalog = asArr(t.catalog, `presets.${key}.${fieldId}.tlv.catalog`);
  if (catalog.length === 0) {
    throw new Error(
      `build-presets: preset "${key}" field "${fieldId}" tlv catalog is empty`,
    );
  }
  for (let i = 0; i < catalog.length; i++) {
    validateTlvCatalogEntry(key, fieldId, i, catalog[i]);
  }
  if (t.instances !== undefined) {
    asArr(t.instances, `presets.${key}.${fieldId}.tlv.instances`);
  }
}

function validateChain(key: string, fieldId: string, v: JsValue): void {
  const cat = asArr(v, `presets.${key}.${fieldId}.chainCatalog`);
  for (let i = 0; i < cat.length; i++) {
    const e = asObj(cat[i], `presets.${key}.${fieldId}.chainCatalog[${i}]`);
    if (typeof e.proto !== "number" || typeof e.name !== "string") {
      throw new Error(
        `build-presets: preset "${key}" field "${fieldId}" chainCatalog[${i}] needs proto/name`,
      );
    }
    const f = asArr(e.fields, `presets.${key}.${fieldId}.chainCatalog[${i}].fields`);
    for (let j = 0; j < f.length; j++) {
      const sf = asObj(f[j], `presets.${key}.${fieldId}.chainCatalog[${i}].fields[${j}]`);
      if (typeof sf.id !== "string" || typeof sf.name !== "string" || typeof sf.bits !== "number") {
        throw new Error(
          `build-presets: preset "${key}" field "${fieldId}" chainCatalog[${i}].fields[${j}] needs id/name/bits`,
        );
      }
    }
  }
}

function validatePreset(key: string, v: JsValue): void {
  const p = asObj(v, `presets.${key}`);
  if (typeof p.name !== "string") {
    throw new Error(`build-presets: preset "${key}" missing string name`);
  }
  if (typeof p.rowBits !== "number") {
    throw new Error(`build-presets: preset "${key}" missing numeric rowBits`);
  }
  const fields = asArr(p.fields, `presets.${key}.fields`);
  for (let i = 0; i < fields.length; i++) {
    const f = asObj(fields[i], `presets.${key}.fields[${i}]`);
    if (typeof f.id !== "string" || typeof f.name !== "string") {
      throw new Error(
        `build-presets: preset "${key}" field[${i}] missing id/name`,
      );
    }
    const fieldId = String(f.id);
    if (f.variable === true) {
      if (typeof f.lengthFrom !== "string" || typeof f.formula !== "string") {
        throw new Error(
          `build-presets: preset "${key}" variable field "${fieldId}" must have lengthFrom and formula`,
        );
      }
    } else if (typeof f.bits !== "number") {
      throw new Error(
        `build-presets: preset "${key}" field "${fieldId}" missing bits`,
      );
    }
    if (f.subfields !== undefined) {
      const sfs = asArr(f.subfields, `presets.${key}.fields[${i}].subfields`);
      let sum = 0;
      for (let j = 0; j < sfs.length; j++) {
        const sf = asObj(sfs[j], `presets.${key}.fields[${i}].subfields[${j}]`);
        if (typeof sf.id !== "string" || typeof sf.name !== "string" || typeof sf.bits !== "number") {
          throw new Error(
            `build-presets: preset "${key}" field "${fieldId}".subfields[${j}] needs id/name/bits`,
          );
        }
        sum += sf.bits;
      }
      if (typeof f.bits === "number" && sum !== f.bits) {
        throw new Error(
          `build-presets: preset "${key}" field "${fieldId}" subfields sum to ${sum} but parent declares ${f.bits} bits`,
        );
      }
    }
    if (f.tlv !== undefined) {
      validateTlv(key, fieldId, f.tlv);
    }
    if (f.chainCatalog !== undefined) {
      validateChain(key, fieldId, f.chainCatalog);
    }
  }
}

function main(): void {
  const src = readFileSync(srcPath, "utf8");
  const env = parseTypst(src);
  const presets = env["presets"];
  if (!presets || !isPlainObject(presets)) {
    throw new Error(`build-presets: data/presets.typ must define a 'presets' dict`);
  }
  for (const key of Object.keys(presets)) {
    validatePreset(key, presets[key]);
  }

  const header = `// AUTO-GENERATED by scripts/build-presets.ts.
// Edit data/presets.typ and run \`npm run build:data\` instead.

import { attachToBits } from "./packet-resolver";
import type { Packet, PacketRegistry } from "./types";

const RAW_PRESETS = ${JSON.stringify(presets, null, 2)} as unknown as PacketRegistry;

// Attach toBits functions for variable-length fields. attachToBits mutates
// each Packet but we accept that — these objects are created once at module
// load and are not shared with persisted state.
for (const key of Object.keys(RAW_PRESETS)) {
  attachToBits(RAW_PRESETS[key]);
}

export const PRESETS: PacketRegistry = RAW_PRESETS;
export const PRESET_KEYS = Object.keys(PRESETS) as Array<keyof typeof PRESETS & string>;
export type { Packet };
`;

  writeFileSync(outPath, header, "utf8");
  console.log(`build-presets: wrote ${outPath} (${Object.keys(presets).length} preset(s))`);
}

main();
