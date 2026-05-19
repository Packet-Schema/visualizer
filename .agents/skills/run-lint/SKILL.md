---
name: run-lint
description: packet-view リポジトリで Lint を実行したいときに使う。web ディレクトリの ESLint を実行し、失敗時は主なエラー箇所を要約して共有したい場合にこのスキルを使う。
---

# Lint 実行

このリポジトリの Lint は `web` ディレクトリで管理されています。実行時は `web` に移動してから `npm` スクリプトを使います。

## 実行手順

1. `web` ディレクトリへ移動する。
2. 標準の Lint 実行として `npm run lint` を使う。
3. 失敗した場合は、主なファイル名とエラー内容を要約して共有する。

## コマンド

```bash
cd /workspaces/packet-view/web
npm run lint
```

## 補足

- `web/package-lock.json` があるため、パッケージマネージャーは `npm` を使う。
- `npm run lint` 実行時は `build:presets` が先に走る前提でよい。
- 差分確認が必要なら `git status --short` や `git diff --stat` を使う。
