// PSDL 0.2 — JSON format.
//
// Reads and writes the canonical PSDL JSON wire format. This is the central
// hub: every format converts to/from PSDL once, and the renderer consumes
// PSDL via `web/lib/psdl/psdl-to-renderer.ts`. The schema lives at
// `schemas/psdl.schema.json` (repo root) — keep this file in lock-step.
//
// Wire shape:
//   {
//     "format": "psdl",
//     "version": "0.2",
//     "name": string,
//     "rowBits": integer,
//     "byteOrder"?: string,
//     "description"?: string,
//     "body": Container[],            // Field | Group | Repeat | Switch | Encrypted
//     "constraints"?: Constraint[],
//     "env"?: { [key]: integer }      // optional packet env (controllers etc.)
//   }
//
// PSDL 0.3 adds two new shapes that flow through this serializer untouched:
//   * `TypeVarint` on a Field — `{ kind: 'varint', encoding: 'quic' | 'protobuf' | 'cbor' }`.
//   * `Encrypted` container — `{ kind: 'encrypted', id, plaintext: Struct,
//     contextNote, wireBits?, headerProtected? }`. The Struct inside is the
//     recursive on-wire format unchanged (so its children round-trip too).
// PSDL 0.4 adds four more shapes that likewise flow through this serializer
// untouched — every PSDL primitive is a tagged JSON object so structural
// JSON encoding is sufficient:
//   * `Optional` container — `{ kind: 'optional', when: Expr, field: Field }`.
//   * `berLength` Type     — `{ kind: 'berLength' }` on a Field's type slot.
//   * `peek` Expr          — `{ kind: 'peek', bits: number, offset?: Expr }`
//                            (typically used as a Switch's `on` discriminator).
//   * Per-field byteOrder  — `byteOrder: 'BE' | 'LE'` on a Field (additive).
// All are passed through `body: r.body as Packet["body"]`; structural
// validation lives in `lib/psdl/validate.ts` and runs downstream.
//
// Color is intentionally not part of the wire shape — PSDL carries
// semantic category only.

import type { Constraint, Container, Packet, PacketEnv } from "../psdl/types";

const FORMAT_TAG = "psdl";
const FORMAT_VERSION = "0.2";
// Versions we tolerate on input. The on-wire JSON shape is shape-stable
// across 0.2 → 0.4: every PSDL 0.3 / 0.4 addition (Encrypted, varint,
// Optional, peek, berLength, per-field byteOrder) lives on tagged sub-
// objects that `body: Container[]` already passes through structurally,
// so an older codec can still parse a packet that carries those
// features. Downstream `validate.ts` does the real semantic check —
// rejecting at the version string forced users on 0.3 / 0.4 saves to
// hand-edit the JSON, which we don't want.
type SupportedVersion = "0.2" | "0.3" | "0.4";
const SUPPORTED_VERSIONS = new Set<SupportedVersion>(["0.2", "0.3", "0.4"]);

/**
 * Serialised JSON wire shape — the structural mirror of PSDL.
 *
 * `version` is widened to the full SupportedVersion union so the type
 * reflects what `fromJson` actually accepts. The writer (`toJson`) only
 * ever emits FORMAT_VERSION ("0.2") as the canonical output; readers
 * narrow further before use if needed (Copilot review).
 */
export type JsonPsdlPacket = {
  format: typeof FORMAT_TAG;
  version: SupportedVersion;
  name: string;
  rowBits: number;
  byteOrder?: string;
  description?: string;
  body: Container[];
  constraints?: Constraint[];
  env?: Record<string, number>;
};

/** Convert a PacketEnv (Map) to a plain JSON object. */
function envToObject(
  env: PacketEnv | undefined,
): Record<string, number> | undefined {
  if (!env || env.size === 0) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of env) out[k] = v;
  return out;
}

/** Convert a plain JSON object back into a PacketEnv (Map). */
function objectToEnv(obj: Record<string, unknown> | undefined): PacketEnv {
  const env: PacketEnv = new Map();
  if (!obj) return env;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "number" && Number.isFinite(v)) env.set(k, v);
  }
  return env;
}

/** Serialise a PSDL Packet (+ optional env) to canonical JSON text. */
export function toJson(packet: Packet, env?: PacketEnv): string {
  const out: JsonPsdlPacket = {
    format: FORMAT_TAG,
    version: FORMAT_VERSION,
    name: packet.name,
    rowBits: packet.rowBits,
    ...(packet.byteOrder ? { byteOrder: packet.byteOrder } : {}),
    ...(packet.description ? { description: packet.description } : {}),
    body: packet.body,
    ...(packet.constraints && packet.constraints.length > 0
      ? { constraints: packet.constraints }
      : {}),
    ...(envToObject(env) ? { env: envToObject(env) } : {}),
  };
  return JSON.stringify(out, null, 2);
}

/** Parse PSDL JSON text into a PSDL Packet plus its embedded env (if any). */
export function fromJson(text: string): { packet: Packet; env: PacketEnv } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("PSDL JSON root must be an object");
  }
  const r = raw as Partial<JsonPsdlPacket> & Record<string, unknown>;
  if (r.format !== FORMAT_TAG) {
    throw new Error(`Unknown format tag: ${String(r.format ?? "(missing)")}`);
  }
  if (
    typeof r.version !== "string" ||
    !SUPPORTED_VERSIONS.has(r.version as SupportedVersion)
  ) {
    throw new Error(`Unsupported PSDL version: ${String(r.version)}`);
  }
  if (typeof r.name !== "string" || r.name.length === 0) {
    throw new Error("PSDL JSON missing string `name`");
  }
  if (
    typeof r.rowBits !== "number" ||
    !Number.isInteger(r.rowBits) ||
    r.rowBits <= 0
  ) {
    throw new Error("PSDL JSON requires integer `rowBits`");
  }
  if (!Array.isArray(r.body)) {
    throw new Error("PSDL JSON missing array `body`");
  }
  const packet: Packet = {
    name: r.name,
    rowBits: r.rowBits,
    body: r.body as Packet["body"],
    ...(r.byteOrder === "BE" || r.byteOrder === "LE"
      ? { byteOrder: r.byteOrder }
      : {}),
    ...(typeof r.description === "string"
      ? { description: r.description }
      : {}),
    ...(Array.isArray(r.constraints)
      ? { constraints: r.constraints as Packet["constraints"] }
      : {}),
  };
  const env = objectToEnv(r.env as Record<string, unknown> | undefined);
  return { packet, env };
}
