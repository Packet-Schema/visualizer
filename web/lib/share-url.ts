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
    // User-facing — surfaced verbatim by parseShareParams' error toast.
    // Avoid leaking internal terms ("PSML") and tell the user what to do.
    throw new Error(
      "Invalid shared link — the packet data could not be read. Please verify the link is complete.",
    );
  }
  const { packet, env } = fromJson(json);
  validatePsmlPacket(packet);
  return { packet, controllers: envToControllers(env) };
}

export function parseShareParams(
  input: string | URLSearchParams,
  builtInKeys: Iterable<string>,
): ParsedShareParams {
  const params = typeof input === "string" ? new URLSearchParams(input) : input;
  const controllers = parseControllers(params);
  const psml = params.get("psml");

  if (psml) {
    try {
      return { kind: "psml", ...decodePsmlParam(psml) };
    } catch (err) {
      // `decodePsmlParam` already throws a curated user-facing message
      // ("Invalid shared link — …"); wrapping it again here produced
      // the duplicated phrasing "Invalid shared link: Invalid shared
      // link — …" the user saw in the toast (Copilot review).
      // Pass the inner message through verbatim. Errors from downstream
      // codecs (`fromJson` / `validatePsmlPacket`) are short enough to
      // be informative on their own — surfacing them as-is is the
      // closest we can get to actionable feedback without inventing
      // ad-hoc copy on every adapter failure.
      //
      // Normalise non-`Error` throws (a third-party codec could `throw
      // "string"` and we'd otherwise surface `undefined` as the toast
      // body), and provide a generic fallback when the stringified
      // value is empty (Copilot review).
      const raw = err instanceof Error ? err.message : String(err);
      return {
        kind: "none",
        controllers,
        error: raw || "Invalid shared link.",
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  defaultPacketKey,
  defaultControllers,
  forcePsml = false,
}: BuildShareUrlOptions): string {
  const url = new URL(baseUrl.toString());
  const params = new URLSearchParams();
  const known = new Set(builtInKeys);
  const usePreset = !forcePsml && known.has(packetKey);

  if (usePreset) {
    params.set("preset", packetKey);
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
  // `Object.create(null)` so an attacker-controlled URL containing
  // `controllers.__proto__=N` can't mutate the map's prototype and
  // leak into any iteration / merge downstream (Copilot security
  // review). The dangerous-key skip below is belt-and-braces: even
  // with the null prototype, surfacing a controller literally named
  // `__proto__` in the UI would be confusing.
  const out = Object.create(null) as ControllerState;
  for (const [key, raw] of params.entries()) {
    if (!key.startsWith(CONTROLLER_PARAM_PREFIX)) continue;
    const controllerKey = key.slice(CONTROLLER_PARAM_PREFIX.length);
    if (!controllerKey) continue;
    if (
      controllerKey === "__proto__" ||
      controllerKey === "constructor" ||
      controllerKey === "prototype"
    ) {
      continue;
    }
    const value = Number(raw);
    // Reject anything that's not a representable, finite *integer*.
    //  - `Number.isFinite` filters NaN / ±Infinity.
    //  - `Math.abs(value) <= MAX_SAFE_INTEGER` keeps slider / layout
    //    math precise (otherwise `1.8e308` survives, then downstream
    //    multiplication rounds it to Infinity).
    //  - `Number.isInteger` is the key: controllers feed `Repeat.count`
    //    via `normalize.resolveRepeatCount`, which does not truncate
    //    `env.get(...)` for `count: "eos"` / `until` shapes. A
    //    fractional value would expand the Repeat the wrong number
    //    of times (Copilot review).
    if (
      Number.isFinite(value) &&
      Number.isInteger(value) &&
      Math.abs(value) <= Number.MAX_SAFE_INTEGER
    ) {
      out[controllerKey] = value;
    }
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
