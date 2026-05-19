---
name: run-install
description: packet-view リポジトリで依存関係をインストールしたいときに使う。web ディレクトリで npm install を実行し、必要に応じて結果や差分を確認したい場合にこのスキルを使う。
---

# 依存関係インストール

このリポジトリのフロントエンド依存関係は `web` ディレクトリで管理されています。依存関係をインストールするときは、必ず `web` に移動してから `npm` を使います。

## 実行手順

1. `web/package-lock.json` があるため、パッケージマネージャーは `npm` を使う。
2. `web` ディレクトリで `npm install` を実行する。
3. インストール後にロックファイルや依存関係の差分が出た場合は、更新内容を確認して簡潔に共有する。

## コマンド

```bash
cd /workspaces/packet-view/web
npm install
```

## 補足

- 依存関係追加や更新の影響確認が必要なら `git status --short` や `git diff --stat` を使う。
- インストール失敗時は、主要なエラー内容と原因候補を要約して共有する。
