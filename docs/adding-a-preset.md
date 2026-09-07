# preset を追加する

組み込み preset は `data/presets/*.psdl.yaml` に YAML として置くだけで、
TypeScript の編集なしに登録されます。本書は最短手順 + 注意点をまとめたものです。

関連: 機能要望は [issue #91](https://github.com/Packet-Schema/visualizer/issues/91)
に preset 追加リクエストがまとまっています。

## 手順

### 1. YAML ファイルを作る

`data/presets/<key>.psdl.yaml` を作成し、先頭に schema 関連付けコメントを入れます。
`<key>` は camelCase の英数字 (例: `tcp`, `quicShort`, `http2FrameHeader`)。

```yaml
# yaml-language-server: $schema=../../schemas/psdl.schema.json
name: My Protocol Header
rowBits: 32
byteOrder: BE
description: 例: 32-bit/行で書くシンプルなヘッダ。
body:
  - { id: kind, name: Kind, type: { kind: int, bits: 8 } }
  # ... フィールド定義 ...
```

### 2. PSDL 仕様に従って `body` を書く

- 1 ページ要約: [`psdl-cheatsheet.md`](./psdl-cheatsheet.md)
- 完全仕様: [`psdl-0.4.md`](./psdl-0.4.md)

困ったら既存 preset (`data/presets/udp.psdl.yaml` が最小、`tcp.psdl.yaml` /
`ipv4.psdl.yaml` が options 付きの代表例) を参考にしてください。

### 3. `PRESET_GROUPS` に追加

`web/lib/constants.ts` の `PRESET_GROUPS` に key を加えて、UI のプロトコルピッカに
出るようにします。OSI レイヤーごとにグループ化されています。

### 4. 期待 totalBits を fixtures に書く

`web/tests/fixtures/preset-bit-sizes.ts` に key と (最小条件での) `totalBits`
を足します。これが preset 追加時の安全網になります。

### 5. layout-parity の網羅確認

`web/tests/psdl/layout-parity.test.ts` を一読し、key が
`PRESET_KEYS` 経由で網羅されているか確認してください。
通常はテスト側の編集は不要です。

### 6. ローカル検証

```sh
cd web
npm run build:presets   # schema 検証 + codegen
npm test                # 全テスト
npm run lint            # ESLint
```

YAML が schema 違反だと build:presets が
`Schema validation failed for data/presets/<file>: ...`
の形で具体的なエラー位置を返します。

### 7. PR を出す

ブランチ命名は `feat/preset-<key>` 推奨。PR テンプレに沿って関連 issue
(あれば #91 を Closes ではなく Refs で参照) を書いてください。

## YAML サンプル (架空のミニプロトコル)

```yaml
# yaml-language-server: $schema=../../schemas/psdl.schema.json
name: Mini Frame
rowBits: 32
byteOrder: BE
description: 学習用のごく小さなフレーム例。
body:
  - { id: ver, name: Version, type: { kind: int, bits: 4 } }
  - { id: typ, name: Type,    type: { kind: int, bits: 4 }, category: identifier }
  - { id: len, name: Length,  type: { kind: int, bits: 8 }, category: length }
  - { id: seq, name: Seq,     type: { kind: int, bits: 16 }, category: identifier }
  - id: payload
    name: Payload
    type: { kind: bytes, bits: { ref: len, scale: 8 } }
    category: payload
```

## ヒント

- variable-length には `cond` / `ref` / `peek` を使う。詳細は cheatsheet 参照。
- TLV 系 (TCP Options 等) は `Repeat` + `Switch` の組合せで書ける。
- 編集後は `npm run dev` で即座に UI に反映されます (`build:presets` が前段で走るため)。
