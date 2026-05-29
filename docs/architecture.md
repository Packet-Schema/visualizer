# Architecture

Packet Schema Visualizer は「PSDL を中央 hub にした N+M 設計」のパケット可視化アプリです。
本ドキュメントはハイレベルなフォルダ構成とデータフローを示します。詳しい
仕様は [`psdl-0.4.md`](./psdl-0.4.md) を参照してください。

## リポジトリ構成

```
packet-view/
├── docs/                 仕様・ガイド (本ファイル含む)
│   ├── psdl-0.4.md       PSDL 仕様 (canonical)
│   ├── psdl-cheatsheet.md PSDL 1 ページ要約
│   ├── adding-a-preset.md preset 追加 step-by-step
│   ├── testing.md         テスト戦略
│   └── architecture.md    本ファイル
├── schemas/              JSON Schema (PSDL 0.4)
│   └── psdl.schema.json
├── data/presets/         組み込み preset (*.psdl.yaml)
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
    │   └── build-presets.ts  YAML → presets.generated.ts の codegen
    └── tests/            Vitest (components / formats / lib / psdl)
```

## データフロー

```
data/presets/*.psdl.yaml
        │
        │  (1) build:presets が Ajv で schema 検証 + コード生成
        ▼
web/lib/psdl/presets.generated.ts   (PRESETS: Record<string, PsdlPacket>)
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
| `web/scripts/build-presets.ts` | YAML preset の codegen + schema 検証 |
| `web/components/HybridDiagram.tsx` | クリック / ホバー対応の SVG ビュー |

## 補足

- `presets.generated.ts` は **gitignore**。`prebuild` / `pretest` から自動再生成されます。
- カテゴリ (`addressing` / `length` / `checksum` 等) は意味タグであり、
  表示色は `render-tokens.ts` で CSS 変数にマップされます。
  preset 側に色情報は持たせません。
- すべてのロジックはブラウザ完結。サーバサイドコードもトラッキングもありません。
