// PSML 0.2 — JSON format.
//
// Reads and writes the canonical PSML JSON wire format. This is the central
// hub: every format converts to/from PSML once, and the renderer consumes
// PSML via `web/lib/psml/runtime-from-psml.ts`. The schema lives at
// `schemas/psml.schema.json` (repo root) — keep this file in lock-step.
//
// Wire shape:
//   {
//     "format": "psml",
//     "version": "0.2",
//     "name": string,
//     "rowBits": integer,
//     "byteOrder"?: string,
//     "description"?: string,
//     "body": Container[],            // Field | Group | Repeat | Switch
//     "constraints"?: Constraint[],
//     "env"?: { [key]: integer }      // optional packet env (controllers etc.)
//   }
//
// Color is intentionally not part of the wire shape — PSML carries
// semantic category only.

import type { Packet, PacketEnv } from "../psml/types";

const FORMAT_TAG = "psml";
const FORMAT_VERSION = "0.2";

/** Serialised JSON wire shape — the structural mirror of PSML. */
export type JsonPsmlPacket = {
  format: typeof FORMAT_TAG;
  version: typeof FORMAT_VERSION;
  name: string;
  rowBits: number;
  byteOrder?: string;
  description?: string;
  body: unknown[];
  constraints?: unknown[];
  env?: Record<string, number>;
};

/** Convert a PacketEnv (Map) to a plain JSON object. */
function envToObject(env: PacketEnv | undefined): Record<string, number> | undefined {
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

/** Serialise a PSML Packet (+ optional env) to canonical JSON text. */
export function toJson(packet: Packet, env?: PacketEnv): string {
  const out: JsonPsmlPacket = {
    format: FORMAT_TAG,
    version: FORMAT_VERSION,
    name: packet.name,
    rowBits: packet.rowBits,
    ...(packet.byteOrder ? { byteOrder: packet.byteOrder } : {}),
    ...(packet.description ? { description: packet.description } : {}),
    body: packet.body as unknown[],
    ...(packet.constraints && packet.constraints.length > 0
      ? { constraints: packet.constraints as unknown[] }
      : {}),
    ...(envToObject(env) ? { env: envToObject(env) } : {}),
  };
  return JSON.stringify(out, null, 2);
}

/** Parse PSML JSON text into a PSML Packet plus its embedded env (if any). */
export function fromJson(text: string): { packet: Packet; env: PacketEnv } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("PSML JSON root must be an object");
  }
  const r = raw as Partial<JsonPsmlPacket> & Record<string, unknown>;
  if (r.format !== FORMAT_TAG) {
    throw new Error(`Unknown format tag: ${String(r.format ?? "(missing)")}`);
  }
  if (r.version !== FORMAT_VERSION) {
    throw new Error(`Unsupported PSML version: ${String(r.version)}`);
  }
  if (typeof r.name !== "string" || r.name.length === 0) {
    throw new Error("PSML JSON missing string `name`");
  }
  if (typeof r.rowBits !== "number" || !Number.isInteger(r.rowBits) || r.rowBits <= 0) {
    throw new Error("PSML JSON requires integer `rowBits`");
  }
  if (!Array.isArray(r.body)) {
    throw new Error("PSML JSON missing array `body`");
  }
  const packet: Packet = {
    name: r.name,
    rowBits: r.rowBits,
    body: r.body as Packet["body"],
    ...(typeof r.byteOrder === "string" ? { byteOrder: r.byteOrder } : {}),
    ...(typeof r.description === "string" ? { description: r.description } : {}),
    ...(Array.isArray(r.constraints) ? { constraints: r.constraints as Packet["constraints"] } : {}),
  };
  const env = objectToEnv(r.env as Record<string, unknown> | undefined);
  return { packet, env };
}
