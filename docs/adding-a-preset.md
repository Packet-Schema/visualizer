# preset を追加する

preset の YAML 本体は **[`Packet-Schema/presets`](https://github.com/Packet-Schema/presets) にあります** — visualizer には置きません。ここは npm 経由で `@packet-schema/presets` を取り込むだけの consumer です。

なので作業は 2 つのリポジトリに分かれます。

関連: 機能要望は [issue #91](https://github.com/Packet-Schema/visualizer/issues/91) に preset 追加リクエストがまとまっています。

---

## 1. presets リポジトリ側 — YAML を書く

`presets/<key>.psdl.yaml` を作って 4 段ゲート(`npm run check`)を通す。`<key>` は camelCase の英数字(`tcp`、`quicShort`、`http2FrameHeader` など)で、そのまま `PRESETS` のキーになります。

手順は [presets の README](https://github.com/Packet-Schema/presets#プリセットを追加する) にあります。`meta.family` / `meta.tags` の語彙登録が要ることだけ注意。

書き方の正典は [core の `spec/psdl-0.5.md`](https://github.com/Packet-Schema/core/blob/main/spec/psdl-0.5.md) ですが、手を動かすなら既存の実ファイルを読むのが早いです。

publish されたら、visualizer 側で `npm update @packet-schema/presets` します。

---

## 2. visualizer 側 — key を登録する

YAML は自動で取り込まれますが、**UI に出すには key の登録が要ります。**

### 2-1. プロトコルピッカに出す

`web/lib/constants.ts` の `PRESET_GROUPS` に key を加えます。OSI レイヤーごとにグループ化されています。

### 2-2. 期待 totalBits を fixtures に書く

`web/tests/fixtures/preset-bit-sizes.ts` に key と(最小条件での)`totalBits` を足します。これが preset 追加時の安全網になります。

### 2-3. layout-parity の網羅確認

`web/tests/psdl/layout-parity.test.ts` を一読し、key が `PRESET_KEYS` 経由で網羅されているか確認してください。通常はテスト側の編集は不要です。

### 2-4. ローカル検証

```sh
cd web
npm run build:presets   # JSON / 索引の再生成
npm test
npm run lint
npm run test:diag       # override invariants (184 preset 全件のスイープ)
```

`test:diag` は新しい preset が override サブシステムのどの不変条件も破らないことを確認します — レンダリングが通るか、図が固まらないか、往復で情報が落ちないか。

### 2-5. PR を出す

ブランチ命名は `feat/preset-<key>` 推奨。PR テンプレに沿って関連 issue(あれば #91 を Closes ではなく Refs で参照)を書いてください。

---

## 関連

- [レンダラ規約](./renderer-contract.md) — 書いた PSDL が図と編集 UI にどう解釈されるか
- [Architecture](./architecture.md) — リポジトリ構成とデータフロー
