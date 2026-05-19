---
name: run-format
description: web フロントエンドのコード整形を実行したいときに使う。packet-view リポジトリで Prettier によるフォーマットを走らせ、必要なら変更内容を確認したい場合にこのスキルを使う。
---

# フォーマット実行

このリポジトリではアプリ本体が `web` ディレクトリにあります。フォーマットを実行するときは、必ず `web` に移動してから作業します。

## 実行手順

1. `web/package-lock.json` があるため、パッケージマネージャーは `npm` を使う。
2. `web` ディレクトリで `npm run format` を実行する。
3. 変更が発生した場合は、どのファイルが更新されたかを確認して結果を簡潔に共有する。

## コマンド

```bash
cd /workspaces/packet-view/web
npm run format
```

## 補足

- 整形結果の確認だけでよい場合は `npm run format:check` も使える。
- コードスタイル上、文字列クォートはダブルクォートを前提にしつつ、実際の整形結果は既存の Prettier 設定を優先する。
- フォーマット後に差分確認が必要なら `git status --short` や `git diff --stat` を使う。
