// Ajv-backed JSON Schema validator for PSML (editor lint 用)。
//
// `schemas/psml.schema.json` は wire JSON (= `format: "psml"`, `version:
// "0.4"`, name, rowBits, body, ...) の構造を canonical に定義しているので、
// editor (SourcePane) の入力もこれに合わせて検証すると、
//   - field 名 typo
//   - 必須キー欠落
//   - enum 不一致 (`type.kind` が `bytes` でないなど)
//   - 型不一致 (`rowBits` が文字列など)
// をパス付きで全部拾える。
//
// validate.ts (TS で書かれた structural check) は層が違うので残す: schema
// では表現しきれない不変条件 (Repeat の field id 衝突、 expr の評価可能性
// など) はあちらで拾う。

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { PSML_JSON_SCHEMA } from "./psml.schema.generated";

const FORMAT_TAG = "psml";
const FORMAT_VERSION = "0.4";

export type SchemaIssue = {
  /** JSON Pointer 風のパス (`/body/0/type/n` など)。 空ならルート。 */
  path: string;
  /** Ajv の人間向け message (`should be number` など)。 */
  message: string;
};

// Ajv の compile は同期だが、 ajv 本体は ~200KB あるので app の初回 render
// に絡めない。 初めて呼ばれた時に compile してキャッシュする。
let cachedValidate: ((data: unknown) => boolean) & {
  errors?: AjvErrorLike[] | null;
};
type AjvErrorLike = {
  instancePath?: string;
  message?: string;
  params?: unknown;
};

function getValidator() {
  if (cachedValidate) return cachedValidate;
  // ajv-formats / Ajv2020 は ESM / CJS で default export 形が違うので、
  // build-presets.ts と同じ防御コードで両対応する。
  const AjvCtor =
    (Ajv2020 as unknown as { default?: typeof Ajv2020 }).default ?? Ajv2020;
  const addFormatsFn =
    (addFormats as unknown as { default?: typeof addFormats }).default ??
    addFormats;
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  addFormatsFn(ajv);
  cachedValidate = ajv.compile(
    PSML_JSON_SCHEMA as object,
  ) as typeof cachedValidate;
  return cachedValidate;
}

/**
 * PSML wire shape を Ajv で検証する。 失敗時は `SchemaIssue[]` を返す。
 * 成功時は空配列。 schema は `format` / `version` を必須としているので、
 * editor 側で剥がした後の packet には呼び出し側で再注入してから渡す。
 */
export function validatePsmlWireShape(
  packet: Record<string, unknown>,
): SchemaIssue[] {
  const validate = getValidator();
  const ok = validate({
    format: FORMAT_TAG,
    version: FORMAT_VERSION,
    ...packet,
  });
  if (ok) return [];
  return (validate.errors ?? []).map((e) => ({
    path: e.instancePath ?? "",
    message: e.message ?? "schema validation failed",
  }));
}
