---
name: run-lint
description: packet-view リポジトリで Lint を実行したいときに使う。web ディレクトリの ESLint を実行し、失敗時は主なエラー箇所を要約して共有したい場合にこのスキルを使う。
---

# Lint 実行

このリポジトリの Lint は `web` ディレクトリで管理されています。実行時は `web` に移動してから `npm` スクリプトを使います。

## 実行手順

1. `web` ディレクトリへ移動する。
2. Lint の前に `npm run format:check` で整形状態を確認する。
3. `format:check` が失敗した場合は、先に `npm run format` で整形してから `npm run lint` を実行する。
4. 失敗した場合は、主なファイル名とエラー内容を要約して共有する。

## コマンド

```bash
cd web
npm run format:check
npm run format
npm run lint
```

## 補足

- `web/package-lock.json` があるため、パッケージマネージャーは `npm` を使う。
- `npm run lint` 実行時は `build:presets` が先に走る前提でよい。
- 差分確認が必要なら `git status --short` や `git diff --stat` を使う。
- `npm run format` は `format:check` が失敗した場合に実行する想定で、整形が不要なら省略してよい。
