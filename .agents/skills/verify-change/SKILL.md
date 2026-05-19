---
name: verify-change
description: packet-view リポジトリで変更後の検証方針を決めたいときに使う。UI、TypeScript、preset、format 実装などの変更内容に応じて run-format、run-lint、run-test、run-typecheck、run-build-presets の実行順と報告内容を判断する。
---

# 変更検証

変更内容に応じて必要な検証を選び、実施した項目と未実施の項目を最後に明記します。

## 基本方針

1. UI、TypeScript、スクリプト、設定、生成物など、`web` 配下やその周辺の整形対象を変更した場合は、原則として最初に `run-format` を実行し、その後 `run-lint`、`run-test`、`run-typecheck` の順で必要なものを実行する。
2. `npm run format:check` が失敗した状態では、Lint、テスト、型チェック、コミット準備へ進まず、先に `npm run format` で整形を確定させる。
3. 軽微な変更でも、何を検証して何を未実施にしたかを共有する。未実施項目がある場合は理由も添える。
4. 書き換え系コマンドは既存差分への影響を見てから実行するが、検証フロー上は整形を必須ステップとして扱う。
5. 検証コマンドの具体的な実行手順は、各スキルの `SKILL.md` に従う。

## preset 関連

`data/presets/*.psml.yaml`、`schemas/psml.schema.json`、`web/scripts/build-presets.ts` を変更した場合は、まず `run-build-presets` を使って生成物を更新します。

生成後は少なくとも `run-test` で整合性を確認し、必要に応じて `run-lint` や `run-typecheck` も実行します。
生成物更新後も、検証の先頭では `run-format` を行う前提を崩しません。

preset を追加・更新する場合は、preset 定義の編集、生成物更新、差分確認までを `run-build-presets` の手順に沿って進めます。詳細が必要なら `docs/adding-a-preset.md` を参照します。

## format 実装関連

`web/lib/formats/` を変更する場合は、import/export を含む既存 contract を壊さないことを優先します。

関連テストの維持または追加を意識し、検証では `run-test` を優先します。対象を絞る必要がある場合は、`run-test` の補足にある format 向けコマンドを確認します。

## Git 準備との関係

コミット、PR 準備、差分共有の前にも `run-format` を必須ステップとして扱います。

検証途中で整形差分が出た場合は、その差分を取り込んだ状態で Lint、テスト、型チェックの結果を見直します。
