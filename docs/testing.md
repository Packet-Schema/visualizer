# テスト戦略

Vitest を使った単一スイートです。すべてのコマンドは `web/` 配下で実行します。

## 大方針

- **`lib/formats/` は 100% カバレッジ必須**。import / export は外部とつながる
  contract なので、回帰を絶対に避けたいゾーンです。CI が
  `npm run test:coverage` で強制します。
- **その他は自由**。層によって観点が違うため一律ルールにはしません。
  「変更した振る舞いを言語化するテストを 1 本足す」程度の温度感で OK。
- **layout-parity**: `tests/psdl/layout-parity.test.ts` が各 preset の
  期待 `totalBits` を fixtures (`tests/fixtures/preset-bit-sizes.ts`) と
  突き合わせます。preset 追加時の最重要安全網。

## 主要コマンド

```sh
cd web
npm test                # 全テスト (約 265 件)
npm run test:watch      # watch モード
npm run test:coverage   # カバレッジレポート (lib/formats/ 100% を確認)
npm run test:format     # tests/formats/ のみ (formats イテレーション時)
```

`pretest` で `build:presets` が走るため、YAML 変更直後でも追加コマンドは不要です。

## ファイル配置

| ディレクトリ | 内容 |
| --- | --- |
| `web/tests/formats/` | JSON / RFC ASCII / KSY / AAD の round-trip / 既知ケース |
| `web/tests/psdl/`    | normalize / layout / expr / constraint / parity |
| `web/tests/components/` | React コンポーネント (jsdom) |
| `web/tests/lib/`     | その他 lib のユニットテスト |
| `web/tests/fixtures/` | テスト用の固定データ (期待 totalBits 等) |

## jsdom 環境の使い方

component や `localStorage` を触るテストは、ファイルの先頭に環境指示を入れます:

```ts
// @vitest-environment jsdom
import { render } from "...";
```

これで該当ファイルだけが jsdom 上で実行され、デフォルトの node 環境テストは
そのまま高速に保てます。

## 新規テストの指針

- フォーマット変換を足した / 直したら **必ず** round-trip テスト
  (PSDL → format → PSDL が等価) を入れる
- preset を足したら fixtures の totalBits を埋める (parity テスト側は自動網羅)
- バグ修正には先に失敗テストを書くと PR で意図が伝わりやすい
- UI 変更は最低限のスナップショットや「クリックで属性が変わる」程度の
  振る舞いテストで十分。ピクセル完全は狙わない
