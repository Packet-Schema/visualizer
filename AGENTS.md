# AGENTS.md

## 目的

- このリポジトリでは、主なアプリケーションコードは `web` 配下にある。
- ユーザーへの回答は日本語で行う。

## 文字コード

- 文字コードは `utf-8` を使う。
- 改行コードは `\n` を使う。

## Node.js

- Node.js 20 系を想定する。
- `web` 配下の依存管理とスクリプト実行は必ず `npm` を使う。
- 新規に Node.js 関連のコマンドや手順を書く場合も `npm` を前提にする。

## コードスタイル

- TypeScript では strict mode を前提にし、型安全性を下げる変更は避ける。
- 文字列クォートはダブルクォートを使い、既存の整形設定がある場合はそれに従う。

## 作業ディレクトリ

- フロントエンド関連のコマンドは `web` ディレクトリで実行する。
- ルートでコマンドを実行する前に、対象が `web` 直下かどうかを確認する。

## Git 運用

- Git 操作が必要な場合は、まず `git status` `git diff` などで既存差分を確認してから進める。
- ブランチを新しく切る場合の目安は `feat/<short-slug>` `fix/<short-slug>` `docs/<short-slug>` とし、`refactor/` `test/` `chore/` なども必要に応じて使ってよい。
- コミットメッセージに厳密な規約はないため、変更内容が読みやすく伝わる要約を優先する。
- PR を作る前提の変更では、関連 issue、変更点、テスト方法を説明できる状態にまとめる。
- PR を作成するときは `.github/PULL_REQUEST_TEMPLATE.md` を参照し、記載項目に沿って内容を整理する。

## 利用可能なスキル

- 依存関係のインストール・開発サーバー・フォーマット・Lint・テスト・型チェックの具体的な実行手順は、それぞれ対応するスキルの `SKILL.md` を参照する。

- `run-build`: 本番ビルドを実行するときに使う。
- `run-build-presets`: preset 生成を実行するときに使う。
- `run-install`: 依存関係をインストールするときに使う。
- `run-dev`: 開発サーバーを起動するときに使う。
- `run-format`: Prettier を実行するときに使う。
- `run-lint`: ESLint を実行するときに使う。
- `run-test`: Vitest を実行するときに使う。
- `run-typecheck`: TypeScript の型チェックを実行するときに使う。

## 検証の進め方

- 整形は `run-format`、Lint は `run-lint`、テストは `run-test`、型チェックは `run-typecheck`、preset 生成は `run-build-presets` を使う。
- UI や TypeScript を変更した場合は、基本として `run-format` `run-lint` `run-test` `run-typecheck` の順で必要なものを実行する。どこまで回したかを最後に明記する。
- `data/presets/*.psml.yaml` `schemas/psml.schema.json` `web/scripts/build-presets.ts` を変更した場合は、まず `run-build-presets` を使って生成物を更新し、その後に少なくとも `run-test` で整合性を確認する。必要に応じて `run-lint` も追加する。具体的なコマンドや自動実行の前提は各スキルの `SKILL.md` を参照する。
- preset を追加・更新する場合は、preset 定義の編集、生成物更新、差分確認までを `run-build-presets` の手順に沿って進める。詳細は `docs/adding-a-preset.md` を参照する。
- `web/lib/formats/` を変更する場合は、import/export を含む既存 contract を壊さないことを前提に、関連テストの維持または追加を意識して `run-test` を優先する。
- 変更が軽微でも、少なくとも何を検証して何を未実施にしたかは明示する。未実施項目がある場合は理由も添える。

## 参照ドキュメント

- PSML の概要や詳細は `docs/psml-cheatsheet.md` と `docs/psml-0.4.md` を参照する。
- リポジトリ構成や実装場所の把握には `docs/architecture.md` を参照する。
- テストの書き方や方針は `docs/testing.md` を参照する。
