# Contributing — Packet View

ようこそ! このドキュメントは「最初に読む」前提で書かれています。長く読む必要はなく、
詰まった所だけ拾い読みしてください。深い仕様は [`docs/psml-0.4.md`](./docs/psml-0.4.md)
と [`docs/architecture.md`](./docs/architecture.md) にあります。

## 環境構築

Node.js 20 系を想定しています。

```sh
cd web
npm install
npm run dev          # http://localhost:3000
```

`npm run dev` は内部で `npm run build:presets` を先に走らせるので、
`data/presets/*.psml.yaml` を編集した直後でも追加コマンドは不要です。

## 主要コマンド (すべて `web/` で実行)

| コマンド | 用途 |
| --- | --- |
| `npm run dev` | 開発サーバ (Next.js) を起動 |
| `npm run build` | 本番ビルド (Cloudflare Workers 向け静的出力) |
| `npm run build:presets` | `data/presets/*.psml.yaml` → `web/lib/psml/presets.generated.ts` を再生成 |
| `npm test` | Vitest スイート (約 265 ケース) |
| `npm run test:watch` | Watch モード |
| `npm run test:coverage` | カバレッジレポート |
| `npm run test:format` | `tests/formats/` だけを実行 |
| `npm run lint` | ESLint (`build:presets` 込み) |

## preset の追加

ワンライナーで言うと「`data/presets/<key>.psml.yaml` を作って `npm run build:presets`」
だけです。step-by-step の手順は [`docs/adding-a-preset.md`](./docs/adding-a-preset.md)
にあります。

## バグ報告 / 機能提案

- バグ: New issue → "バグ報告" テンプレ
- 機能: New issue → "機能提案" テンプレ
- preset 追加リクエスト: New issue → "preset 追加" テンプレ

テンプレに従ってもらえると再現と優先度判断がスムーズです。

## PR の出し方

ブランチ命名の目安 (緩い規約、厳密ではない):

- `feat/<short-slug>` — 新機能
- `fix/<short-slug>` — バグ修正
- `docs/<short-slug>` — docs のみ
- `refactor/`、`test/`、`chore/` などはお好みで

コミットメッセージに規約はありません。読みやすければ何でも OK。

PR テンプレが自動で挿入されるので、関連 issue・変更点・テスト方法を埋めてください。

## レビュー観点

- 既存テストを壊さない (`npm test` 緑)
- `web/lib/formats/` のカバレッジ 100% を維持 (import / export はプロジェクトの contract)
- `npm run lint` clean
- UI 変更はスクリーンショットか短い GIF があると嬉しい

## 困ったら

- PSML の書き方 → [`docs/psml-cheatsheet.md`](./docs/psml-cheatsheet.md) (1 ページ要約) → 詳しくは [`docs/psml-0.4.md`](./docs/psml-0.4.md)
- どこに何があるか → [`docs/architecture.md`](./docs/architecture.md)
- テストの書き方 → [`docs/testing.md`](./docs/testing.md)

## リポジトリ管理者向け (手動作業)

PR では実現できない設定がいくつかあります。リポジトリの設定権限を持つ人が
GitHub / Cloudflare の dashboard 側で行ってください:

- **main の branch protection**: Settings → Branches → "CI green + 1 approval" を要求
- **Cloudflare Workers Builds**: dashboard でプレビュー deploy を有効化
