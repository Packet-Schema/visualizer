---
name: run-test
description: packet-view リポジトリでテストを実行したいときに使う。web ディレクトリの Vitest テストを実行し、失敗時は失敗箇所を特定したい場合にこのスキルを使う。
---

# テスト実行

このリポジトリのテストは `web` ディレクトリで管理されています。テスト実行時は `web` に移動してから `npm` スクリプトを使います。

## 実行手順

1. `web` ディレクトリへ移動する。
2. テストの前に `npm run format:check` で整形状態を確認する。
3. `format:check` が失敗した場合は、先に `npm run format` で整形してから標準のテスト実行として `npm run test` を使う。
4. 失敗した場合は、失敗したテスト名と主要なエラー内容を要約して共有する。

## コマンド

```bash
cd web
npm run format:check
npm run format
npm run test
```

## 補足

- テスト実行前に `pretest` で `build:presets` が自動実行される前提でよい。
- カバレッジが必要な場合は `npm run test:coverage`、監視実行が必要な場合は `npm run test:watch` を使える。
- `tests/formats/` だけを確認したい場合は `npm run test:format` を使う。
- `npm run format` は `format:check` が失敗した場合に実行する想定で、整形が不要なら省略してよい。
