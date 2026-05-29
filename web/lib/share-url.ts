import {
  compressToEncodedURIComponent,
  decompressFromEncodedURIComponent,
} from "lz-string";

import { fromJson, toJson } from "./formats/json";
import { validatePsdlPacket } from "./psdl/validate";
import { stableStringify } from "./stable-stringify";
import type { ControllerState } from "./psdl/renderer";
import type { Packet as PsdlPacket, PacketEnv } from "./psdl/types";

export const CONTROLLER_PARAM_PREFIX = "controllers.";
export const SHARE_URL_WARN_BYTES = 2048;
// Hard ceiling to guard against pathologically large payloads (DoS).
// Browsers and CDNs typically support up to ~64 KB in query strings, so
// 100 000 bytes gives room for complex PSDL packets while still bounding
// server-side work. The WARN threshold above is intentionally lower and
// is used only to surface a UI warning when copying a share URL.
export const SHARE_URL_MAX_LENGTH = 100_000;
export const SHARE_PARAM_KEYS = ["preset", "psdl"] as const;

export type ParsedShareParams =
  | { kind: "none"; controllers: ControllerState; error?: string }
  | { kind: "preset"; presetKey: string; controllers: ControllerState }
  | { kind: "psdl"; packet: PsdlPacket; controllers: ControllerState };

export type BuildShareUrlOptions = {
  baseUrl: string | URL;
  packetKey: string;
  packet: PsdlPacket;
  controllers: ControllerState;
  builtInKeys: Iterable<string>;
  defaultControllers?: ControllerState;
  forcePsdl?: boolean;
};

export function encodePsdlParam(
  packet: PsdlPacket,
  controllers: ControllerState = {},
): string {
  // stableStringify でキー順を正規化してから圧縮することで、
  // 同一内容のパケットは常に同じ psdl 文字列になる。
  const canonical = stableStringify(
    JSON.parse(toJson(packet, controllersToEnv(controllers))),
  );
  return compressToEncodedURIComponent(canonical);
}

export function decodePsdlParam(value: string): {
  packet: PsdlPacket;
  controllers: ControllerState;
} {
  const json = decompressFromEncodedURIComponent(value);
  if (!json) {
    // User-facing — surfaced verbatim by parseShareParams' error toast.
    // Avoid leaking internal terms ("PSDL") and tell the user what to do.
    throw new Error(
      "Invalid shared link — the packet data could not be read. Please verify the link is complete.",
    );
  }
  const { packet, env } = fromJson(json);
  validatePsdlPacket(packet);
  return { packet, controllers: envToControllers(env) };
}

export function parseShareParams(
  input: string | URLSearchParams,
  builtInKeys: Iterable<string>,
): ParsedShareParams {
  const params = typeof input === "string" ? new URLSearchParams(input) : input;
  const controllers = parseControllers(params);

  // 複数の psdl 値がある場合は最初の有効なものを使う。
  // すべて不正だった場合は preset へフォールバックし、
  // preset もなければ最初のエラーメッセージを返す。
  let psdlError: string | undefined;
  for (const psdl of params.getAll("psdl")) {
    try {
      return { kind: "psdl", ...decodePsdlParam(psdl) };
    } catch (err) {
      if (psdlError === undefined) {
        const raw = err instanceof Error ? err.message : String(err);
        psdlError = raw || "Invalid shared link.";
      }
    }
  }

  // 複数の preset 値がある場合は最初の有効なものを使う。
  const known = new Set(builtInKeys);
  const presets = params.getAll("preset");
  const validPreset = presets.find((p) => known.has(p));
  if (validPreset) {
    return { kind: "preset", presetKey: validPreset, controllers };
  }
  if (presets.length > 0) {
    return {
      kind: "none",
      controllers,
      error: `Unknown preset in share URL: ${presets[0]}`,
    };
  }

  // Backwards compatibility: URLs with only controller params (no preset/psdl)
  // are interpreted as ipv4 preset. This handles URLs generated before explicit
  // preset parameters were always included.
  if (Object.keys(controllers).length > 0) {
    return { kind: "preset", presetKey: "ipv4", controllers };
  }

  return { kind: "none", controllers, error: psdlError };
}

export function buildShareUrl({
  baseUrl,
  packetKey,
  packet,
  controllers,
  builtInKeys,
  defaultControllers,
  forcePsdl = false,
}: BuildShareUrlOptions): string {
  const url = new URL(baseUrl.toString());
  const params = new URLSearchParams();
  const known = new Set(builtInKeys);
  const usePreset = !forcePsdl && known.has(packetKey);

  if (usePreset) {
    // Always include preset parameter for explicit clarity, even for ipv4.
    // This ensures URLs are self-documenting about which preset is being used.
    params.set("preset", packetKey);
    for (const [key, value] of sortedControllerEntries(controllers)) {
      if (defaultControllers && value === defaultControllers[key]) continue;
      params.set(`${CONTROLLER_PARAM_PREFIX}${key}`, String(value));
    }
  } else {
    params.set("psdl", encodePsdlParam(packet, controllers));
  }

  url.search = params.toString();
  return url.toString();
}

export function shareUrlByteLength(url: string): number {
  return new TextEncoder().encode(url).length;
}

export function buildShareQueryFromParams(
  params: Record<string, string | string[] | undefined> | URLSearchParams,
): string {
  const out = new URLSearchParams();

  if (params instanceof URLSearchParams) {
    for (const key of SHARE_PARAM_KEYS) {
      const values = params.getAll(key);
      for (const value of values) {
        out.append(key, value);
      }
    }
    for (const [key, value] of params.entries()) {
      if (!key.startsWith(CONTROLLER_PARAM_PREFIX)) continue;
      out.append(key, value);
    }
  } else {
    for (const key of SHARE_PARAM_KEYS) {
      const value = params[key];
      if (typeof value === "string") {
        out.set(key, value);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          out.append(key, item);
        }
      }
    }
    for (const [key, value] of Object.entries(params)) {
      if (!key.startsWith(CONTROLLER_PARAM_PREFIX)) continue;
      if (typeof value === "string") {
        out.append(key, value);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          out.append(key, item);
        }
      }
    }
  }

  return out.toString();
}

export function isShareQueryLengthValid(shareQuery: string): boolean {
  return (
    new URLSearchParams(shareQuery).toString().length <= SHARE_URL_MAX_LENGTH
  );
}

/**
 * Normalize a raw URL search string:
 *   1. Strip params that are not `preset`, `psdl`, or `controllers.*`
 *   2. If `psdl` is present but fails to decode, drop it (invalid payload)
 *   3. If both `preset` and a valid `psdl` are present, drop `preset` (psdl wins)
 *   4. Deduplicate repeated keys — keep only the first occurrence
 *
 * Returns a URLSearchParams-style string (no leading `?`).
 */
export function normalizeShareQuery(
  search: string,
  builtInKeys: Iterable<string> = [],
): string {
  const params = new URLSearchParams(search);
  const out = new URLSearchParams();
  const seen = new Set<string>();
  const known = new Set(builtInKeys);

  // 有効な psdl が1つでもあれば preset は不要。複数ある場合は全値を確認する。
  const psdlValid = params.getAll("psdl").some(isPsdlValueValid);

  // preset の重複排除: 最初の有効値を採用する。
  // 先頭が無効な preset の場合に有効な後続 preset を失わないよう、
  // seen に入れる前に有効性を確認する。
  const firstValidPreset =
    known.size > 0
      ? params.getAll("preset").find((p) => known.has(p))
      : undefined;

  // controller の正規化: parseControllers と同じく後勝ちで有効値を採用。
  // 重複キーの先頭が無効値でも後続の有効値を失わないようにする。
  for (const [key, raw] of params) {
    if (!key.startsWith(CONTROLLER_PARAM_PREFIX)) continue;
    const controllerKey = key.slice(CONTROLLER_PARAM_PREFIX.length);
    if (
      !controllerKey ||
      controllerKey === "__proto__" ||
      controllerKey === "constructor" ||
      controllerKey === "prototype"
    )
      continue;
    const num = Number(raw);
    if (
      Number.isFinite(num) &&
      Number.isInteger(num) &&
      Math.abs(num) <= Number.MAX_SAFE_INTEGER
    ) {
      out.set(key, raw);
    }
  }

  for (const [key, value] of params) {
    const isPreset = key === "preset";
    const isPsdl = key === "psdl";
    if (!isPreset && !isPsdl) continue;
    // Drop invalid psdl values entirely.
    if (isPsdl && !isPsdlValueValid(value)) continue;
    // Canonicalize psdl: decode→re-encode でキー順を正規化した値に置き換える。
    if (isPsdl) {
      if (seen.has(key)) continue;
      const canonical = canonicalizePsdlValue(value);
      out.set(key, canonical);
      seen.add(key);
      continue;
    }
    // When a valid psdl is present, preset is redundant — drop it.
    if (isPreset && psdlValid) continue;
    // For preset: skip invalid values when a valid one exists elsewhere,
    // and keep only the first valid occurrence.
    if (isPreset && firstValidPreset !== undefined) {
      if (value !== firstValidPreset) continue;
      if (seen.has(key)) continue;
    } else {
      if (seen.has(key)) continue;
    }
    seen.add(key);
    out.set(key, value);
  }

  return out.toString();
}

/**
 * Returns the preset key whose packet matches the given packet, or null if none matches.
 * Uses key-order-independent structural comparison so packets decoded from external
 * JSON (where property insertion order may differ) still match built-in presets.
 */
export function findPresetKeyForPacket(
  packet: PsdlPacket,
  presets: Record<string, PsdlPacket>,
): string | null {
  const target = stableStringify(packet);
  for (const [key, presetPacket] of Object.entries(presets)) {
    if (stableStringify(presetPacket) === target) return key;
  }
  return null;
}

/** decode→re-encode で psdl 値のキー順を正規化する。無効な値は呼び出し前に除去済み前提。 */
function canonicalizePsdlValue(value: string): string {
  try {
    const { packet, controllers } = decodePsdlParam(value);
    return encodePsdlParam(packet, controllers);
  } catch {
    return value;
  }
}

function isPsdlValueValid(value: string): boolean {
  try {
    decodePsdlParam(value);
    return true;
  } catch {
    return false;
  }
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
