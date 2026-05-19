---
name: verify-change
description: packet-view リポジトリで変更後の検証方針を決めたいときに使う。UI、TypeScript、preset、format 実装などの変更内容に応じて run-format、run-lint、run-test、run-typecheck、run-build-presets の実行順と報告内容を判断する。
---

# 変更検証

変更内容に応じて必要な検証を選び、実施した項目と未実施の項目を最後に明記します。

## 基本方針

1. UI、TypeScript、スクリプト、設定、生成物など、`web` 配下やその周辺の整形対象を変更した場合は、原則として最初に `run-format` の手順で整形状態を確認し、その後 `run-lint`、`run-test`、`run-typecheck` の順で必要なものを実行する。
2. Next.js の画面、コンポーネント、`app/`、`components/`、`lib/`、`next.config.*`、`package.json` など、本番ビルドに影響しうる変更では、上記に加えて `run-build` の手順で `npm run build` まで確認する。GitHub Actions の `test.yml` はビルドも必須にしているため、ローカル検証でも可能な限り揃える。
3. `npm run format:check` が失敗した状態では、原則として Lint、テスト、型チェック、ビルド、コミット準備へ進まず、先に `npm run format` で整形を確定させる。
4. 軽微な変更でも、何を検証して何を未実施にしたかを共有する。未実施項目がある場合は理由も添える。
5. 既存差分を広く書き換えるなどの理由で `npm run format` を実行しない判断をした場合は、その理由を明記したうえで必要な Lint、テスト、型チェック、ビルドを実行してよい。
6. 書き換え系コマンドは既存差分への影響を見てから実行するが、検証フロー上は整形確認を必須ステップとして扱う。
7. 検証コマンドの具体的な実行手順は、各スキルの `SKILL.md` に従う。

## preset 関連

`data/presets/*.psml.yaml`、`schemas/psml.schema.json`、`web/scripts/build-presets.ts` を変更した場合は、`web` 側の整形対象について `run-format` の手順で整形状態を確認します。必要な整形を確定してから `run-build-presets` を使って生成物を更新します。

`data/presets/*.psml.yaml` や `schemas/psml.schema.json` は `web` ディレクトリで実行する `npm run format:check` の対象外なので、内容確認や schema 検証、preset 生成結果で妥当性を確認します。

生成後は少なくとも `run-test` で整合性を確認し、必要に応じて `run-lint` や `run-typecheck` も実行します。
生成物更新後に追加の書き換えが発生した場合は、改めて整形状態を確認してから後続の検証に進みます。

preset を追加・更新する場合は、preset 定義の編集、生成物更新、差分確認までを `run-build-presets` の手順に沿って進めます。詳細が必要なら `docs/adding-a-preset.md` を参照します。

## format 実装関連

`web/lib/formats/` を変更する場合は、import/export を含む既存 contract を壊さないことを優先します。

関連テストの維持または追加を意識し、検証では `run-test` を優先します。対象を絞る必要がある場合は、`run-test` の補足にある format 向けコマンドを確認します。

`web/lib/formats/` は 100% カバレッジ必須のため、同ディレクトリを変更した場合は `npm run test:coverage` を実行します。実行できない場合は、未実施理由と代替で確認した内容を明記します。

## Git 準備との関係

コミット、PR 準備、差分共有の前にも `run-format` の手順で整形状態を確認します。

検証途中で整形差分が出た場合は、その差分を取り込んだ状態で Lint、テスト、型チェック、必要ならビルドの結果を見直します。
