// PSML source encoding — the "human writes PSML directly" path.
//
// PSML はそもそも YAML preset で運用されているので、 editor 側でも YAML を
// canonical な authoring 形式として扱う (= editor は YAML 専用)。 import /
// export drawer の wire JSON は別経路 (`lib/formats/json.ts`) を使うので、
// ここでは扱わない。
//
// 入力解析は `yaml` パッケージ一本。 JSON は YAML のサブセットなので
// 必要なら parseYaml で受けられるが、 UI 上は YAML として扱う前提。

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { validatePsmlPacket } from "./validate";
import type { PsmlPacket } from "./types";

/**
 * PsmlPacket → YAML テキスト。
 *
 * `data/presets/*.psml.yaml` と同じ shape にして、 preset 編集と直編集が
 * そのまま行き来できるようにする。 `format` / `version` などの wire JSON
 * 用マーカーは付けない。
 */
export function encodeSource(packet: PsmlPacket): string {
  return stringifyYaml(packet, {
    indent: 2,
    lineWidth: 100,
    defaultStringType: "QUOTE_DOUBLE",
    defaultKeyType: "PLAIN",
  });
}

/**
 * SourceParseError — `SourcePane` が banner に出す形にあらかじめ整形する。
 * `line` は 1-based。 `column` は YAML parser の生情報がある時のみ。
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
 * YAML テキスト → PsmlPacket。
 *
 * `validate.ts` の `validatePsmlPacket` で構造チェックまで通してから返す。
 * 失敗時は `SourceParseError` (line/col 情報付き) を throw する。
 */
export function decodeSource(text: string): PsmlPacket {
  let raw: unknown;
  try {
    raw = parseYaml(text, { prettyErrors: true });
  } catch (e) {
    throw toParseError(e);
  }
  if (raw === null || raw === undefined) {
    // 空テキスト / 空ドキュメントは YAML として `null` にパースされる。
    // generic な「object/mapping」 のエラー文より、 何が足りないかを直接
    // 伝える方が初見ユーザーに優しい。
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
  if (Object.keys(obj).length === 0) {
    // wire JSON を貼り付けた人が `format` / `version` だけ残して中身を
    // 空にした場合の救済 (普通は起きないが、 親切に reject)。
    throw new SourceParseError(
      "PSML source is empty. Add at least `name`, `rowBits`, and `body`.",
      null,
      null,
    );
  }
  validatePsmlPacket(obj as PsmlPacket);
  return obj as PsmlPacket;
}

/**
 * import/export 経由で wire JSON shape (`format` / `version` 付き) が
 * 流入する場合に備え、 そういうマーカーキーは parse 時に剥がす。
 * preset YAML はもともと持たないので、 通常はノーオペ。
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
