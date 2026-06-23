// .ksy → PSDL importer.
//
// Best-effort: anything we cannot model is collected into `warnings[]` and
// either dropped or replaced with a 0-byte placeholder so the rest of the
// packet still renders. The exporter (./exporter.ts) is the matching
// PSDL → .ksy direction.

import { parse as yamlParse } from "yaml";

import { composeDescription, humanize } from "../common";
import type {
  Container,
  Expr,
  Field,
  Packet,
  Repeat,
  Struct,
  Switch,
  Type,
} from "../../psdl/types";

import {
  collectEnums,
  collectTypes,
  endianToByteOrder,
  mergeEnums,
  mergeRegistries,
  type EnumRegistry,
  type KsyRoot,
  type KsySeqEntry,
  type TypeRegistry,
} from "./types";

/** Parse .ksy YAML text into a PSDL packet plus non-fatal warnings. */
export function fromKsy(text: string): { packet: Packet; warnings: string[] } {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = yamlParse(text);
  } catch (e) {
    throw new Error(`Invalid YAML: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(".ksy root must be a mapping");
  }
  const root = raw as KsyRoot;
  const meta = root.meta ?? {};
  const id =
    typeof meta.id === "string" && meta.id.length > 0
      ? meta.id
      : "kaitai_packet";
  const title = typeof meta.title === "string" ? meta.title : undefined;

  const byteOrder = endianToByteOrder(meta.endian, warnings);

  // User-defined `types:` registry — resolved on demand while walking seq.
  const typeRegistry: TypeRegistry = collectTypes(root.types, warnings);

  // Top-level seq → PSDL body.
  const ctx: WalkCtx = {
    warnings,
    typeRegistry,
    enums: collectEnums(root.enums, warnings),
    path: id,
  };
  const body = root.seq ? walkSeq(root.seq, ctx) : [];
  if (root.instances) {
    for (const name of Object.keys(root.instances)) {
      warnings.push(`Kaitai computed instance dropped: ${name}`);
    }
  }

  const description = composeDescription(root.doc, root["doc-ref"]);

  const packet: Packet = {
    name: title || id,
    rowBits: 32,
    byteOrder,
    ...(description ? { description } : {}),
    body,
  };

  return { packet, warnings };
}

type WalkCtx = {
  warnings: string[];
  typeRegistry: TypeRegistry;
  enums: EnumRegistry;
  path: string;
};

function walkSeq(seq: KsySeqEntry[], ctx: WalkCtx): Container[] {
  const out: Container[] = [];
  for (let i = 0; i < seq.length; i++) {
    const entry = seq[i];
    if (!entry || typeof entry !== "object") {
      ctx.warnings.push(`seq[${i}] is not a mapping; skipped`);
      continue;
    }
    const c = entryToContainer(entry, i, ctx);
    if (c) out.push(c);
  }
  return out;
}

function entryToContainer(
  entry: KsySeqEntry,
  idx: number,
  ctx: WalkCtx,
): Container | null {
  const id =
    typeof entry.id === "string" && entry.id.length > 0 ? entry.id : `f${idx}`;
  const name = humanize(id);

  // Detect unsupported keys early — list but don't fail.
  for (const k of Object.keys(entry)) {
    if (UNSUPPORTED_SEQ_KEYS.has(k)) {
      ctx.warnings.push(
        `seq entry "${id}": Kaitai key "${k}" is not modelled; dropped`,
      );
    }
  }

  // Resolve the type. Most entries are simple. switch-on becomes a Switch.
  if (
    entry.type &&
    typeof entry.type === "object" &&
    !Array.isArray(entry.type)
  ) {
    return switchOnToContainer(id, name, entry, ctx);
  }

  // Try to build a Field.
  const fieldOrStruct = simpleEntryToFieldOrStruct(id, name, entry, ctx);
  if (!fieldOrStruct) return null;

  // Apply repeat → wrap in Repeat.
  let node: Container = fieldOrStruct;
  if (entry.repeat) {
    node = wrapInRepeat(id, name, fieldOrStruct, entry, ctx);
  }

  // Apply `if:` → wrap in Switch.
  if (typeof entry.if === "string") {
    node = wrapInIfSwitch(id, name, node, entry.if, ctx);
  }

  return node;
}

const UNSUPPORTED_SEQ_KEYS = new Set([
  "process",
  "pos",
  "io",
  "include",
  "valid",
  "consume",
  "eos-error",
  "terminator",
]);

function simpleEntryToFieldOrStruct(
  id: string,
  name: string,
  entry: KsySeqEntry,
  ctx: WalkCtx,
): Container | null {
  const typeName = typeof entry.type === "string" ? entry.type : undefined;
  const doc = composeDescription(entry.doc, entry["doc-ref"]);

  // User-defined nested type → emit a Group of its fields.
  if (typeName && ctx.typeRegistry.has(typeName)) {
    const def = ctx.typeRegistry.get(typeName)!;
    const subCtx: WalkCtx = {
      ...ctx,
      path: `${ctx.path}/${id}`,
      // Merge nested types/enums into a shallow child registry.
      typeRegistry: mergeRegistries(
        ctx.typeRegistry,
        collectTypes(def.types, ctx.warnings),
      ),
      enums: mergeEnums(ctx.enums, collectEnums(def.enums, ctx.warnings)),
    };
    const children = def.seq ? walkSeq(def.seq, subCtx) : [];
    if (def.instances) {
      for (const iname of Object.keys(def.instances)) {
        ctx.warnings.push(
          `Kaitai computed instance dropped: ${typeName}.${iname}`,
        );
      }
    }
    const typeDoc = composeDescription(def.doc, def["doc-ref"]);
    const groupDoc = [doc, typeDoc].filter(Boolean).join("\n\n");
    return {
      kind: "group",
      id,
      name,
      children,
      ...(groupDoc ? { doc: groupDoc } : {}),
    } as Container & { doc?: string };
  }

  // Translate to a Type.
  const type = ksyToType(entry, ctx);
  if (!type) {
    ctx.warnings.push(
      `seq entry "${id}": could not resolve type "${String(entry.type ?? "(none)")}"; dropped`,
    );
    return null;
  }

  // Apply enum: lookup → switch type to TypeEnum.
  let finalType: Type = type;
  if (typeof entry.enum === "string") {
    const variants = ctx.enums.get(entry.enum);
    if (variants && (type.kind === "int" || type.kind === "bits")) {
      const bits = type.kind === "int" ? type.bits : type.n;
      const numericVariants: Record<number, string> = {};
      for (const [k, v] of Object.entries(variants)) {
        const n = Number(k);
        if (Number.isInteger(n)) numericVariants[n] = v;
      }
      finalType = { kind: "enum", bits, variants: numericVariants };
    } else if (!variants) {
      ctx.warnings.push(
        `seq entry "${id}": unknown enum "${entry.enum}" — kept as int`,
      );
    }
  }

  const field: Field = {
    id,
    name,
    type: finalType,
    ...(doc ? { doc } : {}),
  };
  return field;
}

function ksyToType(entry: KsySeqEntry, ctx: WalkCtx): Type | null {
  const typeName = typeof entry.type === "string" ? entry.type : undefined;

  // Fixed-width int.
  if (typeName) {
    const intMatch = /^([us])(1|2|4|8)(?:be|le)?$/.exec(typeName);
    if (intMatch) {
      const signed = intMatch[1] === "s";
      const bits = Number(intMatch[2]) * 8;
      return { kind: "int", bits, ...(signed ? { signed: true } : {}) };
    }
    // Float (f4/f8) — surface as warning, keep as raw bits so layout still works.
    const floatMatch = /^f(4|8)(?:be|le)?$/.exec(typeName);
    if (floatMatch) {
      ctx.warnings.push(
        `seq entry "${entry.id ?? "?"}": float type "${typeName}" lowered to raw bits`,
      );
      return { kind: "bits", n: Number(floatMatch[1]) * 8 };
    }
    // Bit-aligned field bN..bN.
    const bitMatch = /^b(\d+)(?:be|le)?$/.exec(typeName);
    if (bitMatch) {
      const n = Number(bitMatch[1]);
      if (n >= 1 && n <= 64) return { kind: "bits", n };
    }
    // Strings: str / strz + size.
    if (typeName === "str" || typeName === "strz") {
      const n = sizeToExpr(entry.size, ctx);
      if (n) return { kind: "bytes", n };
      if (entry["size-eos"]) {
        ctx.warnings.push(
          `seq entry "${entry.id ?? "?"}": str with size-eos — using 0-byte placeholder`,
        );
        return { kind: "bytes", n: { kind: "lit", value: 0 } };
      }
      ctx.warnings.push(
        `seq entry "${entry.id ?? "?"}": ${typeName} without size — using 0-byte placeholder`,
      );
      return { kind: "bytes", n: { kind: "lit", value: 0 } };
    }
  }

  // No type, but size present → raw bytes.
  if (entry.size !== undefined) {
    const n = sizeToExpr(entry.size, ctx);
    if (n) return { kind: "bytes", n };
  }
  if (entry["size-eos"]) {
    ctx.warnings.push(
      `seq entry "${entry.id ?? "?"}": size-eos used as 0-byte placeholder`,
    );
    return { kind: "bytes", n: { kind: "lit", value: 0 } };
  }

  // `contents: ...` (fixed magic bytes).
  if (entry.contents !== undefined) {
    const len = magicByteLength(entry.contents);
    if (len > 0) return { kind: "bytes", n: { kind: "lit", value: len } };
  }

  return null;
}

function sizeToExpr(size: unknown, ctx: WalkCtx): Expr | null {
  if (typeof size === "number" && Number.isInteger(size) && size >= 0) {
    return { kind: "lit", value: size };
  }
  if (typeof size === "string") {
    // Plain identifier → ref. Anything else → warning + placeholder ref.
    const m = /^([A-Za-z_][\w]*)$/.exec(size.trim());
    if (m) return { kind: "ref", field: m[1] };
    ctx.warnings.push(
      `Complex size expression "${size}" not modelled — using 0`,
    );
    return { kind: "lit", value: 0 };
  }
  return null;
}

function magicByteLength(contents: unknown): number {
  if (typeof contents === "string") return contents.length;
  if (Array.isArray(contents)) return contents.length;
  /* v8 ignore start */ // defensive: kaitai `contents` is always a string or byte-array
  return 0;
  /* v8 ignore stop */
}

function wrapInRepeat(
  id: string,
  name: string,
  inner: Container,
  entry: KsySeqEntry,
  ctx: WalkCtx,
): Repeat {
  const element: Struct = {
    id: `${id}_elem`,
    fields: [inner],
  };
  let count: Repeat["count"];
  switch (entry.repeat) {
    case "expr": {
      const expr = simpleRefOrLit(entry["repeat-expr"]);
      if (!expr) {
        ctx.warnings.push(
          `repeat-expr "${String(entry["repeat-expr"])}" not modelled — defaulting to env "${id}_count"`,
        );
        count = { kind: "ref", field: `${id}_count` };
      } else {
        count = expr;
      }
      break;
    }
    case "until": {
      ctx.warnings.push(
        `repeat: until on "${id}" is not evaluable offline — using env count`,
      );
      count = { until: { kind: "ref", field: `${id}_until` } };
      break;
    }
    case "eos":
    default:
      count = "eos";
  }
  return {
    kind: "repeat",
    id,
    name,
    element,
    count,
  };
}

function simpleRefOrLit(v: unknown): Expr | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return { kind: "lit", value: Math.trunc(v) };
  }
  if (typeof v === "string") {
    const m = /^\s*([A-Za-z_][\w]*)\s*$/.exec(v);
    if (m) return { kind: "ref", field: m[1] };
    const n = Number(v);
    if (Number.isFinite(n)) return { kind: "lit", value: Math.trunc(n) };
  }
  return null;
}

function wrapInIfSwitch(
  id: string,
  name: string,
  inner: Container,
  ifExpr: string,
  ctx: WalkCtx,
): Switch {
  // Best-effort: if the predicate is a simple ref, use it directly; otherwise
  // synthesise a controller-style ref so the runtime env can drive it.
  const refExpr = simpleRefOrLit(ifExpr);
  const on: Expr = refExpr ?? { kind: "ref", field: `${id}_present` };
  if (!refExpr) {
    ctx.warnings.push(
      `if-expression on "${id}" simplified to env "${id}_present" (was: "${ifExpr}")`,
    );
  }
  const present: Struct = {
    id: `${id}_present`,
    fields: [inner],
  };
  const absent: Struct = { id: `${id}_absent`, fields: [] };
  return {
    kind: "switch",
    id: `${id}_if`,
    name,
    on,
    // 0.5 — the default arm is the "_" case; mirror `present` there.
    cases: { "1": present, "0": absent, _: present },
  };
}

function switchOnToContainer(
  id: string,
  name: string,
  entry: KsySeqEntry,
  ctx: WalkCtx,
): Container | null {
  const obj = entry.type as {
    "switch-on"?: unknown;
    cases?: Record<string, unknown>;
  };
  const onRaw = obj["switch-on"];
  const cases = obj.cases ?? {};
  const on = typeof onRaw === "string" ? simpleRefOrLit(onRaw) : null;
  if (!on) {
    ctx.warnings.push(
      `seq entry "${id}": switch-on expression "${String(onRaw)}" not modelled — dropped`,
    );
    return null;
  }
  const builtCases: Record<string, Struct> = {};
  for (const [k, v] of Object.entries(cases)) {
    if (typeof v !== "string") {
      ctx.warnings.push(
        `switch case "${id}=${k}": non-string variant "${typeof v}" not modelled`,
      );
      continue;
    }
    // Build a synthetic seq entry to reuse the simple resolver.
    const fake: KsySeqEntry = { id, type: v };
    const child = simpleEntryToFieldOrStruct(`${id}_${k}`, name, fake, ctx);
    if (child) {
      builtCases[String(k)] = { id: `${id}_${k}_s`, fields: [child] };
    }
  }
  return {
    kind: "switch",
    id,
    name,
    on,
    cases: builtCases,
  };
}
