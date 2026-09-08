# Architecture

Packet Schema Visualizer は「PSDL を中央 hub にした N+M 設計」のパケット可視化アプリです。
本ドキュメントはハイレベルなフォルダ構成とデータフローを示します。

PSDL 言語そのものの正典は
[core の `spec/psdl-0.5.md`](https://github.com/Packet-Schema/core/blob/main/spec/psdl-0.5.md)
にあります。visualizer が PSDL をどう「描く」かは
[`renderer-contract.md`](./renderer-contract.md) を参照してください。

## リポジトリ構成

```
visualizer/
├── docs/                 ガイド (本ファイル含む)
│   ├── renderer-contract.md PSDL → 図・編集 UI の解釈規約
│   ├── adding-a-preset.md preset 追加 step-by-step
│   ├── testing.md         テスト戦略
│   └── architecture.md    本ファイル
└── web/                  Next.js アプリ本体
    ├── app/              ルーティング / page.tsx
    ├── components/       React コンポーネント (HybridDiagram など)
    ├── lib/
    │   ├── psdl/         PSDL 中核 (types / normalize / layout / renderer)
    │   ├── formats/      import / export (JSON / RFC ASCII / KSY / AAD)
    │   ├── constants.ts  PRESET_GROUPS / カテゴリ表示名など
    │   ├── render-tokens.ts category → CSS 変数のマップ
    │   └── ...
    ├── scripts/
    │   └── build-presets.ts  npm パッケージ → JSON / index の codegen
    └── tests/            Vitest (components / formats / lib / psdl)
```

## データフロー

PSDL の言語定義 (型・スキーマ・normalize / layout / 制約ソルバ) と 184 個の
組み込み preset は、それぞれ npm パッケージとして別リポジトリにあります —
[`@packet-schema/core`](https://github.com/Packet-Schema/core) と
[`@packet-schema/presets`](https://github.com/Packet-Schema/presets)。
visualizer はその **consumer** です。

```
@packet-schema/presets  (184 preset)
        │
        │  (1) build:presets が public/presets/<key>.json と索引を生成
        ▼
web/lib/psdl/preset-index.generated.ts  +  public/presets/*.json
        │
        │  (2) lib/psdl/normalize.ts が静的解析 (ID 解決 / 型整合)
        ▼
NormalizedPacket
        │
        │  (3) lib/psdl/layout.ts が値依存の長さを評価して bit-grid に展開
        ▼
LayoutResult  ──▶  Cell[]  ──▶  components/HybridDiagram (SVG 描画)
```

import / export は `lib/formats/` 経由で双方向に PSDL へ変換します。
**N+M ハブ**: 各フォーマット (JSON / RFC ASCII / KSY / AAD) は PSDL との
変換だけを実装し、フォーマット同士の直接変換は持ちません。これにより
新しいフォーマットを足すコストが線形に抑えられます。

```
   JSON ───┐                   ┌───  RFC ASCII (export)
           │                   │
   KSY  ───┼───▶  PSDL  ◀──────┤───  AAD (import)
           │   (canonical)     │
   ...  ───┘                   └───  ... (将来)
```

## 主要ファイル

| パス | 役割 |
| --- | --- |
| `web/lib/psdl/types.ts` | `PsdlPacket` ほか PSDL の TS 型定義 |
| `web/lib/psdl/normalize.ts` | YAML/JSON の loose 入力を厳格 in-memory 表現に正規化 |
| `web/lib/psdl/layout.ts` | bit grid への展開 (variable length / Switch / Repeat 解決) |
| `web/lib/psdl/expr.ts` | 純粋式 (`lit` / `ref` / `op` / `cond` / `peek`) の評価器 |
| `web/lib/psdl/constraint.ts` | 双方向制約 (例: `IHL × 4 == headerBytes`) |
| `web/lib/psdl/renderer.ts` | layout 結果から `Cell[]` を構築 |
| `web/lib/formats/json.ts` | PSDL JSON のシリアライズ / パース |
| `web/lib/formats/rfc-ascii.ts` | RFC ASCII art 出力 |
| `web/lib/formats/aug-ascii.ts` | AAD (Augmented ASCII Diagrams) 入力 |
| `web/lib/formats/ksy.ts` | Kaitai Struct (.ksy) 取り込み |
| `web/scripts/build-presets.ts` | preset パッケージ → JSON / 索引 + core のスキーマ取り込み |
| `web/components/HybridDiagram.tsx` | クリック / ホバー対応の SVG ビュー |

## 補足

- `preset-index.generated.ts` / `psdl.schema.generated.ts` / `public/presets/*.json` は **gitignore**。`prebuild` / `pretest` から自動再生成されます。
- カテゴリ (`addressing` / `length` / `checksum` 等) は意味タグであり、
  表示色は `render-tokens.ts` で CSS 変数にマップされます。
  preset 側に色情報は持たせません。
- すべてのロジックはブラウザ完結。サーバサイドコードもトラッキングもありません。
