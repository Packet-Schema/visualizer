// PSDL source encoding — the "human writes PSDL directly" path.
//
// PSDL はそもそも YAML preset で運用されているので、 editor 側でも YAML を
// canonical な authoring 形式として扱う (= editor は YAML 専用)。 import /
// export drawer の wire JSON は別経路 (`lib/formats/json.ts`) を使うので、
// ここでは扱わない。
//
// 入力解析は `yaml` パッケージ一本。 JSON は YAML のサブセットなので
// 必要なら parseYaml で受けられるが、 UI 上は YAML として扱う前提。

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { validatePsdlWireShape } from "./schema-validator";
import { validatePsdlPacket } from "./validate";
import type { PsdlPacket } from "./types";

/**
 * PsdlPacket → YAML テキスト。
 *
 * `data/presets/*.psdl.yaml` と同じ shape にして、 preset 編集と直編集が
 * そのまま行き来できるようにする。 `format` / `version` などの wire JSON
 * 用マーカーは付けない。
 *
 * `env` (controller / freeRepeat / discriminator のピック状態) は authored
 * PSDL ではなく controller state なので **出力しない**。 "Save as preset" や
 * KSY/save-as は env を packet に焼き込むことがあるが、 これを YAML に出すと
 * PSDL の top-level schema (`unevaluatedProperties: false`、 `env` は未定義)
 * に弾かれ、 ユーザーが 1 文字編集した瞬間 re-parse が "must NOT have
 * unevaluated properties" で失敗して source pane が編集不能になる。 wire JSON
 * 経路 (`toJson`) も packet.env を spread せず別引数の env からのみ出力するので、
 * ここで env を落とすのが両経路で一貫する。
 */
export function encodeSource(packet: PsdlPacket): string {
  const { env: _env, ...authored } = packet;
  void _env;
  return stringifyYaml(authored, {
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
 * YAML テキスト → PsdlPacket。
 *
 * `validate.ts` の `validatePsdlPacket` で構造チェックまで通してから返す。
 * 失敗時は `SourceParseError` (line/col 情報付き) を throw する。
 */
export function decodeSource(text: string): PsdlPacket {
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
      "PSDL source is empty. Add at least `name`, `rowBits`, and `body`.",
      null,
      null,
    );
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new SourceParseError(
      "PSDL source must be a top-level object/mapping.",
      null,
      null,
    );
  }
  const obj = stripWireMarkers(raw as Record<string, unknown>);
  if (Object.keys(obj).length === 0) {
    // wire JSON を貼り付けた人が `format` / `version` だけ残して中身を
    // 空にした場合の救済 (普通は起きないが、 親切に reject)。
    throw new SourceParseError(
      "PSDL source is empty. Add at least `name`, `rowBits`, and `body`.",
      null,
      null,
    );
  }
  // Ajv で JSON Schema 検証 (= wire shape の正しさ)。 path 付きエラーを
  // 集めて 1 つの SourceParseError にまとめる。 lint 経路で個別 diagnostic
  // としても使えるよう、 issues は別 helper (`lintSource`) で取得できる。
  const issues = validatePsdlWireShape(obj);
  if (issues.length > 0) {
    const detail = issues
      .map((i) => `  ${i.path || "(root)"}: ${i.message}`)
      .join("\n");
    throw new SourceParseError(
      `PSDL schema validation failed:\n${detail}`,
      null,
      null,
    );
  }
  // 構造チェック (PSDL invariants — Repeat 内の field id 衝突など、 schema
  // で表現しきれない不変条件)。
  validatePsdlPacket(obj as PsdlPacket);
  return obj as PsdlPacket;
}

/**
 * リアルタイム lint 用の入口 — text → `Diagnostic[]` 風の構造化エラー列。
 * `decodeSource` と違って 1 つ目で投げずに、 schema / structural エラーを
 * すべて返す。 CodeMirror lint extension などの consumer 向け。
 */
export type SourceLintIssue = {
  /** 1-based line, parse 失敗時のみ非 null。 schema エラーは現状 null。 */
  line: number | null;
  message: string;
  /** Ajv が出した JSON Pointer 風 path (`/body/0/type/n`)。 空 = root。 */
  path?: string;
};

export function lintSource(text: string): SourceLintIssue[] {
  // 空 text は SourcePane 側で「empty hint」 を出すので lint は no-op。
  if (text.trim().length === 0) return [];
  let raw: unknown;
  try {
    raw = parseYaml(text, { prettyErrors: true });
  } catch (e) {
    const err = toParseError(e);
    return [{ line: err.line, message: err.message }];
  }
  if (raw === null || raw === undefined) {
    return [];
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return [
      {
        line: null,
        message: "PSDL source must be a top-level object/mapping.",
      },
    ];
  }
  const obj = stripWireMarkers(raw as Record<string, unknown>);
  if (Object.keys(obj).length === 0) return [];
  const schemaIssues = validatePsdlWireShape(obj);
  if (schemaIssues.length > 0) {
    return schemaIssues.map((i) => ({
      line: null,
      path: i.path,
      message: `${i.path || "(root)"}: ${i.message}`,
    }));
  }
  try {
    validatePsdlPacket(obj as PsdlPacket);
    return [];
  } catch (e) {
    return [
      { line: null, message: e instanceof Error ? e.message : String(e) },
    ];
  }
}

/**
 * import/export 経由で wire JSON shape (`format` / `version` 付き) が
 * 流入する場合に備え、 そういうマーカーキーは parse 時に剥がす。
 *
 * ただし PSDL 0.5 の packet は `version: "0.5"` を **packet metadata** として
 * 正規に持つ (preset も全部持つ)。 これは wire JSON envelope の `version`
 * (常に `format: psdl` と対で出てくる) とは別物なので、 envelope 判定には
 * `format` の有無を使う:
 *   - `format` がある → wire envelope なので `format` / `version` を剥がす。
 *   - `format` が無い → 素の PSDL source。 `version` は packet metadata
 *     として残す (round-trip で落とさない)。
 *
 * `env` (controller state) は PSDL の top-level schema に無いプロパティで、
 * `unevaluatedProperties: false` に弾かれる。 `encodeSource` は env を出さない
 * ので素の source pane には現れないが、 env を焼き込んだ packet を直接貼り付け
 * たり、 旧 source を読み込んだ場合に備えて parse 時に剥がす (envelope の有無に
 * 関係なく)。 こうすれば schema validation を通り source pane が編集不能に
 * ならない。
 */
function stripWireMarkers(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  // `env` は controller state であって authored PSDL ではない。 schema 検証
  // 前に必ず取り除く (wire envelope かどうかに依らない)。
  const { env: _env, ...withoutEnv } = obj;
  void _env;
  if (!("format" in withoutEnv)) {
    // 素の PSDL source — wire envelope ではない。 `version` は packet
    // metadata なので保持する。
    return withoutEnv;
  }
  const { format: _f, version: _v, ...rest } = withoutEnv;
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
