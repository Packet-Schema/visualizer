// Shared types and registry helpers for the .ksy importer / exporter.
//
// Minimal typings for the Kaitai Struct YAML subset we touch — the upstream
// spec is larger, but everything outside this surface is surfaced through
// `warnings[]` rather than the type system.

export type KsyRoot = {
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

export type KsyType = {
  doc?: string;
  "doc-ref"?: string | string[];
  seq?: KsySeqEntry[];
  types?: Record<string, KsyType>;
  enums?: Record<string, Record<string | number, unknown>>;
  instances?: Record<string, unknown>;
  [k: string]: unknown;
};

export type KsySeqEntry = {
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

export type TypeRegistry = Map<string, KsyType>;
export type EnumRegistry = Map<string, Record<string, string>>;

export function endianToByteOrder(
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

export function collectTypes(
  raw: KsyRoot["types"],
  warnings: string[],
): TypeRegistry {
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

export function collectEnums(
  raw: KsyRoot["enums"],
  warnings: string[],
): EnumRegistry {
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

export function mergeRegistries(
  a: TypeRegistry,
  b: TypeRegistry,
): TypeRegistry {
  const out = new Map(a);
  for (const [k, v] of b) out.set(k, v);
  return out;
}

export function mergeEnums(a: EnumRegistry, b: EnumRegistry): EnumRegistry {
  const out = new Map(a);
  for (const [k, v] of b) out.set(k, v);
  return out;
}
