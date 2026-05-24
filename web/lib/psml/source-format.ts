// PSML source encoding — the "human writes PSML directly" path.
//
// PSML はそもそも YAML preset で運用されているので、editor 側でも YAML を
// canonical な authoring 形式として扱う。 JSON は import/export hub と
// 同じ on-wire shape (`format`/`version` 付き) を round-trip させる方を
// canonical とする。 両者の差分はこのモジュールに閉じ込めて、上位 UI は
// `SourceFormat` を渡すだけで切り替えられるようにする。
//
// 解析時は YAML が JSON の superset であることを利用して入り口を一本化:
// `yaml` パッケージで両方を受ける。出力時は format ごとに分岐する。

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { validatePsmlPacket } from "./validate";
import type { PsmlPacket } from "./types";

export type SourceFormat = "yaml" | "json";

const JSON_FORMAT_TAG = "psml";
const JSON_FORMAT_VERSION = "0.4";

/**
 * PsmlPacket → text。
 *
 * - YAML はバラの PsmlPacket をそのまま書き出す (`format`/`version` なし)。
 *   `data/presets/*.psml.yaml` と同じ shape にして、preset 編集と直編集が
 *   そのまま行き来できるようにする。
 * - JSON は `lib/formats/json.ts` と同じ on-wire shape (`format`/`version`)
 *   を付ける。import/export drawer と互換にして、tab に貼って共有しても
 *   そのまま読めるようにする。
 */
export function encodeSource(packet: PsmlPacket, format: SourceFormat): string {
  if (format === "yaml") {
    return stringifyYaml(packet, {
      indent: 2,
      lineWidth: 100,
      defaultStringType: "QUOTE_DOUBLE",
      defaultKeyType: "PLAIN",
    });
  }
  // JSON: 既存 toJson の最小複製 (env は editor では持たない)。
  const wire: Record<string, unknown> = {
    format: JSON_FORMAT_TAG,
    version: JSON_FORMAT_VERSION,
    name: packet.name,
    rowBits: packet.rowBits,
    ...(packet.byteOrder ? { byteOrder: packet.byteOrder } : {}),
    ...(packet.description ? { description: packet.description } : {}),
    body: packet.body,
    ...(packet.constraints && packet.constraints.length > 0
      ? { constraints: packet.constraints }
      : {}),
  };
  return JSON.stringify(wire, null, 2);
}

/**
 * SourceParseError — `SourceEditor` が banner に出す形にあらかじめ整形する。
 * `line` は 1-based。 `column` は YAML/JSON parser の生情報がある時のみ。
 */
export class SourceParseError extends Error {
  readonly line: number | null;
  readonly column: number | null;
  constructor(message: string, line: number | null, column: number | null) {
    super(message);
    this.name = "SourceParseError";
    this.line = line;
    this.column = column;
  }
}

/**
 * text → PsmlPacket。
 *
 * format が指定されていない時は YAML として parse する (JSON は YAML の
 * subset なので両方読める)。validate.ts の `validatePsmlPacket` で
 * 構造チェックまで通してから返す。
 */
export function decodeSource(
  text: string,
  format: SourceFormat = "yaml",
): PsmlPacket {
  let raw: unknown;
  try {
    raw =
      format === "json"
        ? JSON.parse(text)
        : parseYaml(text, { prettyErrors: true });
  } catch (e) {
    throw toParseError(e);
  }
  if (raw === null || raw === undefined) {
    // 空テキスト / 空ドキュメントは YAML として `null` にパースされる。
    // generic な「object/mapping」 のエラー文より、 何が足りないかを直接
    // 伝える方が初見ユーザーに優しい (Round 1 P2 #8)。
    throw new SourceParseError(
      "PSML source is empty. Add at least `name`, `rowBits`, and `body`.",
      null,
      null,
    );
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new SourceParseError(
      "PSML source must be a top-level object/mapping.",
      null,
      null,
    );
  }
  const obj = stripWireMarkers(raw as Record<string, unknown>);
  // JSON で `{}` (空オブジェクト) が来た時、 後段の validatePsmlPacket は
  // "missing a name" などの低レベル文言で reject する。 ユーザーには
  // 「最低限これだけ書け」 の方が早いので、 空オブジェクトは empty と同じ
  // メッセージで返す (Round 2 P1, 一貫性)。
  if (Object.keys(obj).length === 0) {
    throw new SourceParseError(
      "PSML source is empty. Add at least `name`, `rowBits`, and `body`.",
      null,
      null,
    );
  }
  // 構造チェック (PsmlPacket としての invariants)。throw されたらそのまま
  // 上に投げる — banner で表示される。
  validatePsmlPacket(obj as PsmlPacket);
  return obj as PsmlPacket;
}

/**
 * on-wire JSON shape に付く `format` / `version` を剥がす。YAML preset で
 * authors が `# yaml-language-server: $schema=...` の頭注釈と共に
 * `format: psml` を書くこともあるので、両方に対応する。
 */
function stripWireMarkers(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const { format: _f, version: _v, ...rest } = obj;
  void _f;
  void _v;
  return rest;
}

function toParseError(e: unknown): SourceParseError {
  // `yaml` の YAMLParseError は `.linePos: [{line,col},{line,col}]` を持つ。
  // 通常の SyntaxError (JSON.parse 経由) には行情報が無いので null にする。
  if (
    typeof e === "object" &&
    e !== null &&
    "linePos" in e &&
    Array.isArray((e as { linePos?: unknown }).linePos)
  ) {
    const linePos = (e as { linePos: { line: number; col: number }[] }).linePos;
    const head = linePos[0];
    const message =
      e instanceof Error
        ? e.message
        : String((e as { message?: unknown }).message ?? e);
    return new SourceParseError(message, head?.line ?? null, head?.col ?? null);
  }
  return new SourceParseError(
    e instanceof Error ? e.message : String(e),
    null,
    null,
  );
}
