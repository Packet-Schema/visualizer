// PSML 0.2 — Kaitai Struct (.ksy) light import/export bridge.
//
// Kaitai Struct is a YAML-based binary format DSL with ~200+ public format
// definitions at https://formats.kaitai.io/. This module is read-mostly:
// `fromKsy(text)` does a best-effort lowering of .ksy → PSML and collects
// anything it cannot model into `warnings`. `toKsy(packet)` is an inverse
// best-effort exporter; PSML-only constructs (categories, constraints,
// switches on non-integer discriminators) survive as YAML comments
// prefixed `# psml-only:`.
//
// Supported subset (see docs/psml-0.2.md "Kaitai interop"):
//   meta.id / meta.title          → Packet.name
//   meta.endian (be|le)           → Packet.byteOrder ("BE"|"LE")
//   seq[] entries with
//     type: u1..u8, s1..s8        → TypeInt (signed flag from `s`)
//     type: b1..b64               → TypeBits
//     type: str|strz + size: N    → TypeBytes
//     size: N (no type)           → TypeBytes
//     type: <userTypeName>        → nested Struct from `types:`
//   if: <kaitai expr>             → Switch (case "1" present, default empty)
//   repeat: expr|until|eos        → Repeat
//   doc / doc-ref                 → Field.doc (concatenated)
//   types: recursive walk
//   enums:                        → TypeEnum (best-effort, integer-keyed)
//   instances:                    → warnings (computed instances dropped)
//
// Anything else (process, parametric types, switch-on type, _io.* refs,
// kaitai expression beyond a simple `<name>` reference) is reported as a
// warning. The importer never throws on a recognised top-level shape; it
// degrades to a smaller PSML packet and lets the user fix the rest.

import { parse as yamlParse, stringify as yamlStringify } from "yaml";

import type {
  Container,
  Encrypted,
  Expr,
  Field,
  Packet,
  Repeat,
  Struct,
  Switch,
  Type,
} from "../psml/types";

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/** Parse .ksy YAML text into a PSML packet plus non-fatal warnings. */
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

  // Top-level seq → PSML body.
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

/** Serialise a PSML packet to Kaitai .ksy YAML (best-effort, lossy). */
export function toKsy(packet: Packet): string {
  const ksy: KsyRoot = {
    meta: {
      id: toKsyId(packet.name),
      title: packet.name,
      ...(packet.byteOrder
        ? { endian: packet.byteOrder.toLowerCase() === "le" ? "le" : "be" }
        : {}),
    },
    seq: [],
  };
  if (packet.description) ksy.doc = packet.description;

  const psmlOnly: string[] = [];
  const types: Record<string, KsyType> = {};

  const seq: KsySeqEntry[] = [];
  for (const c of packet.body) {
    seq.push(...containerToKsy(c, { types, psmlOnly }));
  }
  ksy.seq = seq;
  if (Object.keys(types).length > 0) ksy.types = types;

  if (packet.constraints && packet.constraints.length > 0) {
    psmlOnly.push(
      `${packet.constraints.length} PSML constraint(s) not representable in .ksy`,
    );
  }

  let yamlText = yamlStringify(ksy, {
    lineWidth: 100,
    aliasDuplicateObjects: false,
  });

  if (psmlOnly.length > 0) {
    const header = psmlOnly.map((m) => `# psml-only: ${m}`).join("\n") + "\n";
    yamlText = header + yamlText;
  }
  return yamlText;
}

/* ------------------------------------------------------------------ *
 * KSY shape — minimal typing of the subset we touch.
 * ------------------------------------------------------------------ */

type KsyRoot = {
  meta?: {
    id?: string;
    title?: string;
    endian?: string;
    [k: string]: unknown;
  };
  doc?: string;
  "doc-ref"?: string | string[];
  seq?: KsySeqEntry[];
  types?: Record<string, KsyType>;
  enums?: Record<string, Record<string | number, unknown>>;
  instances?: Record<string, unknown>;
};

type KsyType = {
  doc?: string;
  "doc-ref"?: string | string[];
  seq?: KsySeqEntry[];
  types?: Record<string, KsyType>;
  enums?: Record<string, Record<string | number, unknown>>;
  instances?: Record<string, unknown>;
  [k: string]: unknown;
};

type KsySeqEntry = {
  id?: string;
  type?: unknown; // string OR switch-on object
  size?: unknown;
  "size-eos"?: boolean;
  contents?: unknown;
  encoding?: string;
  doc?: string;
  "doc-ref"?: string | string[];
  if?: string;
  endian?: "be" | "le";
  repeat?: "expr" | "until" | "eos";
  "repeat-expr"?: unknown;
  "repeat-until"?: string;
  enum?: string;
  [k: string]: unknown;
};

/* ------------------------------------------------------------------ *
 * Importer — internals
 * ------------------------------------------------------------------ */

type TypeRegistry = Map<string, KsyType>;
type EnumRegistry = Map<string, Record<string, string>>;

type WalkCtx = {
  warnings: string[];
  typeRegistry: TypeRegistry;
  enums: EnumRegistry;
  path: string;
};

function endianToByteOrder(
  endian: unknown,
  warnings: string[],
): "BE" | "LE" | undefined {
  if (typeof endian !== "string") return undefined;
  const e = endian.trim().toLowerCase();
  if (e === "be") return "BE";
  if (e === "le") return "LE";
  warnings.push(`Unknown meta.endian "${endian}" — left unset`);
  return undefined;
}

function collectTypes(raw: KsyRoot["types"], warnings: string[]): TypeRegistry {
  const reg: TypeRegistry = new Map();
  if (!raw) return reg;
  for (const [name, def] of Object.entries(raw)) {
    if (!def || typeof def !== "object") {
      warnings.push(`Type "${name}" is not a mapping; ignored`);
      continue;
    }
    reg.set(name, def);
  }
  return reg;
}

function collectEnums(raw: KsyRoot["enums"], warnings: string[]): EnumRegistry {
  const reg: EnumRegistry = new Map();
  if (!raw) return reg;
  for (const [name, variants] of Object.entries(raw)) {
    if (!variants || typeof variants !== "object") {
      warnings.push(`Enum "${name}" is not a mapping; ignored`);
      continue;
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(variants)) {
      if (typeof v === "string") {
        out[String(k)] = v;
      } else if (v && typeof v === "object" && "id" in v) {
        const id = (v as { id?: unknown }).id;
        if (typeof id === "string") out[String(k)] = id;
      }
    }
    reg.set(name, out);
  }
  return reg;
}

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
    cases: { "1": present, "0": absent },
    default: present,
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

function composeDescription(doc: unknown, docRef: unknown): string | undefined {
  const parts: string[] = [];
  if (typeof doc === "string" && doc.trim().length > 0) parts.push(doc.trim());
  if (Array.isArray(docRef)) {
    for (const r of docRef) {
      if (typeof r === "string" && r.trim().length > 0)
        parts.push(`See: ${r.trim()}`);
    }
  } else if (typeof docRef === "string" && docRef.trim().length > 0) {
    parts.push(`See: ${docRef.trim()}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function mergeRegistries(a: TypeRegistry, b: TypeRegistry): TypeRegistry {
  const out = new Map(a);
  for (const [k, v] of b) out.set(k, v);
  return out;
}

function mergeEnums(a: EnumRegistry, b: EnumRegistry): EnumRegistry {
  const out = new Map(a);
  for (const [k, v] of b) out.set(k, v);
  return out;
}

function humanize(id: string): string {
  return id
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/* ------------------------------------------------------------------ *
 * Exporter — internals
 * ------------------------------------------------------------------ */

type ToCtx = {
  types: Record<string, KsyType>;
  psmlOnly: string[];
};

function containerToKsy(c: Container, ctx: ToCtx): KsySeqEntry[] {
  // Field?
  if (!("kind" in c) || c.kind === "field") {
    return [fieldToKsy(c as Field, ctx)];
  }
  switch (c.kind) {
    case "group":
      // Splice inline (Kaitai has no group; the children are siblings).
      return c.children.flatMap((ch) => containerToKsy(ch, ctx));
    case "repeat": {
      const entry: KsySeqEntry = {
        id: c.id,
        repeat: "eos",
      };
      // Hoist the first field of the element as the entry's "type" if it's a
      // single field; otherwise create a synthetic user type.
      const child = c.element.fields[0];
      if (
        c.element.fields.length === 1 &&
        child &&
        (!("kind" in child) || child.kind === "field")
      ) {
        const f = child as Field;
        const proxy = fieldToKsy(f, ctx);
        Object.assign(entry, proxy, { id: c.id });
      } else {
        const typeName = `${c.id}_elem`;
        ctx.types[typeName] = {
          seq: c.element.fields.flatMap((ch) => containerToKsy(ch, ctx)),
        };
        entry.type = typeName;
      }
      if (
        typeof c.count === "object" &&
        c.count !== null &&
        "kind" in c.count
      ) {
        entry.repeat = "expr";
        entry["repeat-expr"] = exprToString(c.count);
      } else if (
        typeof c.count === "object" &&
        "until" in (c.count as object)
      ) {
        entry.repeat = "until";
        entry["repeat-until"] = exprToString(
          (c.count as { until: Expr }).until,
        );
      }
      return [entry];
    }
    case "switch": {
      // PSML 0.4 — if the discriminator is a peek() expression, surface that
      // as a psml-only comment alongside the (still-lowered) Switch so the
      // .ksy reader knows the dispatch happens on a lookahead rather than a
      // declared sibling field. Kaitai's switch-on requires a previously
      // declared field, so we keep the existing "first case only" lowering.
      if (c.on.kind === "peek") {
        ctx.psmlOnly.push(
          `Switch "${c.id}" dispatches on peek(bits=${c.on.bits}) — lookahead not modelled in Kaitai`,
        );
      }
      ctx.psmlOnly.push(
        `Switch "${c.id}" lowered to first case only (Kaitai switch-on type requires uniform field shapes).`,
      );
      const firstKey = Object.keys(c.cases)[0];
      if (!firstKey) return [];
      const first = c.cases[firstKey];
      return first.fields.flatMap((ch) => containerToKsy(ch, ctx));
    }
    case "optional": {
      // PSML 0.4 Optional — emit `if:` if the predicate is a simple ref
      // (Kaitai accepts a name), otherwise drop to a psml-only comment.
      const inner = fieldToKsy(c.field, ctx);
      const ifExpr = exprToKaitaiIf(c.when);
      if (ifExpr) {
        inner.if = ifExpr;
      } else {
        ctx.psmlOnly.push(
          `optional "${c.id ?? c.field.id}" predicate ${exprToString(c.when)} not expressible in Kaitai — left unconditional`,
        );
      }
      return [inner];
    }
    case "encrypted": {
      // Kaitai has no encrypted concept. Emit a single byte placeholder so the
      // .ksy still parses, and record a psml-only comment naming the context.
      // The plaintext substructure is intentionally dropped — emitting it
      // would imply the decrypted shape is also on-wire, which is misleading.
      const e = c as Encrypted;
      ctx.psmlOnly.push(
        `encrypted block "${e.id}" (${e.contextNote}) skipped — Kaitai has no encrypted primitive`,
      );
      return [
        {
          id: toKsyId(e.id),
          size: 0,
          doc: `psml-only: encrypted block (${e.contextNote})`,
        },
      ];
    }
    /* v8 ignore start */ // exhaustiveness guard: every Container kind is handled above
    default:
      return [];
    /* v8 ignore stop */
  }
}

function fieldToKsy(f: Field, ctx: ToCtx): KsySeqEntry {
  const entry: KsySeqEntry = { id: toKsyId(f.id) };
  if (f.category)
    ctx.psmlOnly.push(`Field "${f.id}" category "${f.category}" dropped`);
  switch (f.type.kind) {
    case "int": {
      const sig = f.type.signed ? "s" : "u";
      const bytes = Math.max(1, Math.ceil(f.type.bits / 8));
      const code =
        bytes === 1 || bytes === 2 || bytes === 4 || bytes === 8
          ? `${sig}${bytes}`
          : null;
      if (code) entry.type = code;
      else {
        ctx.psmlOnly.push(
          `Field "${f.id}" odd int width ${f.type.bits} → b${f.type.bits}`,
        );
        entry.type = `b${f.type.bits}`;
      }
      break;
    }
    case "bits":
      entry.type = `b${f.type.n}`;
      break;
    case "bytes":
      entry.size = exprToKsySize(f.type.n);
      break;
    case "enum": {
      const bytes = Math.max(1, Math.ceil(f.type.bits / 8));
      entry.type =
        bytes === 1 || bytes === 2 || bytes === 4 || bytes === 8
          ? `u${bytes}`
          : `b${f.type.bits}`;
      ctx.psmlOnly.push(
        `Field "${f.id}" enum variants embedded as comment (not registered in enums:)`,
      );
      break;
    }
    case "varint": {
      // Kaitai has no varint primitive — fall back to a u1 placeholder and
      // surface the encoding in the psml-only header so the reader knows
      // they need to hand-roll a custom type.
      ctx.psmlOnly.push(
        `Field "${f.id}" varint (${f.type.encoding}) lowered to u1 placeholder`,
      );
      entry.type = "u1";
      break;
    }
    case "berLength": {
      // PSML 0.4 — Kaitai has no BER-length primitive. Emit a u1 placeholder
      // and surface a psml-only comment so the reader knows to hand-roll
      // the proper BER definite-length decoder.
      ctx.psmlOnly.push(`Field "${f.id}" berLength lowered to u1 placeholder`);
      entry.type = "u1";
      break;
    }
  }
  if (f.doc) entry.doc = f.doc;
  // PSML 0.4 per-field byteOrder → Kaitai per-field `endian:`.
  if (f.byteOrder === "BE") entry.endian = "be";
  else if (f.byteOrder === "LE") entry.endian = "le";
  return entry;
}

/**
 * Translate a PSML Expr to a Kaitai `if:` clause string. Returns null when
 * the expression contains a `peek` (Kaitai cannot model lookahead) so the
 * caller can fall back to a psml-only comment.
 */
function exprToKaitaiIf(e: Expr): string | null {
  switch (e.kind) {
    case "lit":
      return String(e.value);
    case "ref":
      return e.field;
    case "op": {
      const a = exprToKaitaiIf(e.a);
      const b = exprToKaitaiIf(e.b);
      if (a === null || b === null) return null;
      return `(${a} ${e.op} ${b})`;
    }
    case "cond": {
      const t = exprToKaitaiIf(e.test);
      const tt = exprToKaitaiIf(e.t);
      const ff = exprToKaitaiIf(e.f);
      if (t === null || tt === null || ff === null) return null;
      return `(${t} ? ${tt} : ${ff})`;
    }
    case "peek":
      return null;
  }
}

function exprToKsySize(e: Expr): number | string {
  if (e.kind === "lit") return e.value;
  if (e.kind === "ref") return e.field;
  return exprToString(e);
}

function exprToString(e: Expr): string {
  switch (e.kind) {
    case "lit":
      return String(e.value);
    case "ref":
      return e.field;
    case "op":
      return `(${exprToString(e.a)} ${e.op} ${exprToString(e.b)})`;
    case "cond":
      return `(${exprToString(e.test)} ? ${exprToString(e.t)} : ${exprToString(e.f)})`;
    case "peek":
      return `peek(${e.bits}${e.offset !== undefined ? `, ${exprToString(e.offset)}` : ""})`;
  }
}

function toKsyId(name: string): string {
  const out = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return out.length > 0 ? out : "packet";
}
