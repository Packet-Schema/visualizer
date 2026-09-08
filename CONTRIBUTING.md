# Contributing — Packet Schema Visualizer

ようこそ! このドキュメントは「最初に読む」前提で書かれています。長く読む必要はなく、
詰まった所だけ拾い読みしてください。PSDL 言語そのものの仕様は
[core の `spec/psdl-0.5.md`](https://github.com/Packet-Schema/core/blob/main/spec/psdl-0.5.md)、
visualizer 側の構成と描画規約は [`docs/architecture.md`](./docs/architecture.md) と
[`docs/renderer-contract.md`](./docs/renderer-contract.md) にあります。

## 環境構築

Node.js 24 系を想定しています（`web/package.json` の `engines` と CI の `node-version` に一致）。

```sh
cd web
npm install
npm run dev          # http://localhost:3000
```

`npm run dev` は内部で `npm run build:presets` を先に走らせるので、
`@packet-schema/presets` を更新した直後でも追加コマンドは不要です。

## 主要コマンド (すべて `web/` で実行)

| コマンド | 用途 |
| --- | --- |
| `npm run dev` | 開発サーバ (Next.js) を起動 |
| `npm run build` | 本番ビルド (Cloudflare Workers 向け静的出力) |
| `npm run build:presets` | `@packet-schema/presets` → `public/presets/*.json` と索引を再生成 |
| `npm test` | Vitest スイート |
| `npm run test:watch` | Watch モード |
| `npm run test:coverage` | カバレッジレポート |
| `npm run test:format` | `tests/formats/` だけを実行 |
| `npm run lint` | ESLint (`build:presets` 込み) |

## preset の追加

preset の YAML 本体は別リポジトリ
([`Packet-Schema/presets`](https://github.com/Packet-Schema/presets)) にあります。
visualizer 側でやることは key の登録だけです。手順は
[`docs/adding-a-preset.md`](./docs/adding-a-preset.md) にあります。

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

- PSDL の書き方 → 正典は `@packet-schema/core` の `spec/psdl-0.5.md`。手を動かすなら `@packet-schema/presets` の `presets/udp.psdl.yaml` など実物が早い
- どこに何があるか → [`docs/architecture.md`](./docs/architecture.md)
- テストの書き方 → [`docs/testing.md`](./docs/testing.md)
