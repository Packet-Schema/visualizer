---
name: run-typecheck
description: packet-view リポジトリで TypeScript の型チェックを実行したいときに使う。専用 npm スクリプトがない前提で web ディレクトリから TypeScript コンパイラを noEmit で実行し、型エラーを確認したい場合にこのスキルを使う。
---

# 型チェック実行

このリポジトリには現時点で型チェック専用の `npm` スクリプトがありません。そのため `web` ディレクトリで preset 生成を先に行い、その後 `npm exec` 経由で TypeScript コンパイラを `--noEmit` 付きで実行します。

## 実行手順

1. `web` ディレクトリへ移動する。
2. `npm run build:presets` を実行し、型チェックに必要な生成物を最新化する。
3. `npm exec tsc -- --noEmit` を実行して型エラーの有無を確認する。
4. エラーが出た場合は、主なファイル名とエラー内容を要約して共有する。

## コマンド

```bash
cd /workspaces/packet-view/web
npm run build:presets
npm exec tsc -- --noEmit
```

## 補足

- 依存関係は `web/package-lock.json` に従い、Node.js 関連の実行は `npm` 前提で統一する。
- `web/lib/psml/presets.generated.ts` は gitignore 対象の生成物なので、クリーン環境では型チェック前に生成が必要になる。
- TypeScript は strict mode 前提で扱い、型エラー回避のために型安全性を下げる変更は避ける。
- 将来的に型チェック専用スクリプトが追加されたら、そのスクリプトを優先して使う。
