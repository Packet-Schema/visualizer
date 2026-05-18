import {
  compressToEncodedURIComponent,
  decompressFromEncodedURIComponent,
} from "lz-string";

import { fromJson, toJson } from "./formats/json";
import { validatePsmlPacket } from "./psml/validate";
import type { ControllerState } from "./psml/renderer";
import type { Packet as PsmlPacket, PacketEnv } from "./psml/types";

export const CONTROLLER_PARAM_PREFIX = "controllers.";
export const SHARE_URL_WARN_BYTES = 2048;

export type ParsedShareParams =
  | { kind: "none"; controllers: ControllerState; error?: string }
  | { kind: "preset"; presetKey: string; controllers: ControllerState }
  | { kind: "psml"; packet: PsmlPacket; controllers: ControllerState };

export type BuildShareUrlOptions = {
  baseUrl: string | URL;
  packetKey: string;
  packet: PsmlPacket;
  controllers: ControllerState;
  builtInKeys: Iterable<string>;
  defaultPacketKey: string;
  defaultControllers?: ControllerState;
  forcePsml?: boolean;
};

export function encodePsmlParam(
  packet: PsmlPacket,
  controllers: ControllerState = {},
): string {
  const json = toJson(packet, controllersToEnv(controllers));
  return compressToEncodedURIComponent(json);
}

export function decodePsmlParam(value: string): {
  packet: PsmlPacket;
  controllers: ControllerState;
} {
  const json = decompressFromEncodedURIComponent(value);
  if (!json) {
    throw new Error("Shared PSML payload could not be decompressed.");
  }
  const { packet, env } = fromJson(json);
  validatePsmlPacket(packet);
  return { packet, controllers: envToControllers(env) };
}

export function parseShareParams(
  input: string | URLSearchParams,
  builtInKeys: Iterable<string>,
): ParsedShareParams {
  const params =
    typeof input === "string" ? new URLSearchParams(input) : input;
  const controllers = parseControllers(params);
  const psml = params.get("psml");

  if (psml) {
    try {
      return { kind: "psml", ...decodePsmlParam(psml) };
    } catch (err) {
      return {
        kind: "none",
        controllers,
        error: `Invalid shared PSML payload: ${(err as Error).message}`,
      };
    }
  }

  const preset = params.get("preset");
  if (preset) {
    const known = new Set(builtInKeys);
    if (known.has(preset)) {
      return { kind: "preset", presetKey: preset, controllers };
    }
    return {
      kind: "none",
      controllers,
      error: `Unknown preset in share URL: ${preset}`,
    };
  }

  return { kind: "none", controllers };
}

export function buildShareUrl({
  baseUrl,
  packetKey,
  packet,
  controllers,
  builtInKeys,
  defaultPacketKey,
  defaultControllers,
  forcePsml = false,
}: BuildShareUrlOptions): string {
  const url = new URL(baseUrl.toString());
  const params = new URLSearchParams();
  const known = new Set(builtInKeys);
  const usePreset = !forcePsml && known.has(packetKey);

  if (usePreset) {
    if (packetKey !== defaultPacketKey) {
      params.set("preset", packetKey);
    }
    for (const [key, value] of sortedControllerEntries(controllers)) {
      if (defaultControllers && value === defaultControllers[key]) continue;
      params.set(`${CONTROLLER_PARAM_PREFIX}${key}`, String(value));
    }
  } else {
    params.set("psml", encodePsmlParam(packet, controllers));
  }

  url.search = params.toString();
  return url.toString();
}

export function shareUrlByteLength(url: string): number {
  return new TextEncoder().encode(url).length;
}

function parseControllers(params: URLSearchParams): ControllerState {
  const out: ControllerState = {};
  for (const [key, raw] of params.entries()) {
    if (!key.startsWith(CONTROLLER_PARAM_PREFIX)) continue;
    const controllerKey = key.slice(CONTROLLER_PARAM_PREFIX.length);
    if (!controllerKey) continue;
    const value = Number(raw);
    if (Number.isFinite(value)) out[controllerKey] = value;
  }
  return out;
}

function sortedControllerEntries(
  controllers: ControllerState,
): Array<[string, number]> {
  return Object.entries(controllers)
    .filter(([, value]) => Number.isFinite(value))
    .sort(([a], [b]) => a.localeCompare(b));
}

function controllersToEnv(controllers: ControllerState): PacketEnv {
  return new Map(sortedControllerEntries(controllers));
}

function envToControllers(env: PacketEnv): ControllerState {
  const out: ControllerState = {};
  for (const [key, value] of env) {
    if (Number.isFinite(value)) out[key] = value;
  }
  return out;
}
