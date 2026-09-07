---
name: run-build
description: Packet Schema Visualizer リポジトリで本番ビルドを実行したいときに使う。web ディレクトリで npm run build を実行し、ビルド成功確認や失敗内容の要約を行いたい場合にこのスキルを使う。
---

# 本番ビルド実行

このリポジトリの本番ビルドは `web` ディレクトリで実行します。ビルド確認が必要なときは、`web` に移動してから `npm` スクリプトを使います。

## 実行手順

1. `web` ディレクトリへ移動する。
2. `npm run build` を実行する。
3. 成功時はビルド完了を共有し、失敗時は主要なエラー箇所を要約して共有する。

## コマンド

```bash
cd web
npm run build
```

## 補足

- `web/package-lock.json` があるため、パッケージマネージャーは `npm` を使う。
- `npm run build` 実行前には `prebuild` により `npm run build:presets` が自動実行される前提でよい。
- 差分確認が必要なら `git status --short` や `git diff --stat` を使う。
