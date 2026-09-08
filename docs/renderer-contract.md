# レンダラ規約

PSDL は**意味だけを宣言する** — 構造と意図(`category`、Group / Repeat / Switch)を書き、どう描くかはレンダラが決める。スキーマに `ui:` のようなフィールドは無い。

このドキュメントは、その「決める側」の規約 — visualizer が PSDL のどの構造をどう解釈するか — を扱う。**言語そのものの正典は [core の PSDL 0.5 仕様](https://github.com/Packet-Schema/core/blob/main/spec/psdl-0.5.md)** で、型・式・コンテナ・制約の意味はすべてそちらにある。

---

## Group の畳み込み → 親セル + サブセル

子がすべて葉 `Field` の `Group` は、N 個の兄弟セルではなく**サブセルを持つ 1 個の親セル**として描く。

| PSDL                                                               | レンダラ                                              |
| ------------------------------------------------------------------ | ----------------------------------------------------- |
| `Group { children: [R, DF, MF] }`(IPv4 flags)                      | 1 個の `flagsBits` セル + 1 bit のサブセル 3 つ       |
| `Group { children: [Type, Length, Pointer, Addr…] }`(Record Route) | 1 個の `Record Route` セル + そのバリアントのサブセル |

実装は `lib/psdl/psdl-to-renderer/subfield.ts` の `groupToSubfieldField`。**compound な子(入れ子の Repeat / Switch / Group)を含む Group は `null` を返して畳み込まない** — 構造上フラットにするしかないため。

Repeat の中の Group は、畳み込んだセルの id に反復インデックスが入る(`flagsBits#0`、`flagsBits#1`、…)ので、各反復を独立に選択・アドレスできる。

畳み込みを解釈するのはレイアウトパスだけで、他の consumer(RFC ASCII / JSON / Kaitai)は平坦な読みのままになる。

---

## TLV のスロット方式

TLV の `Repeat<Switch>` は、ミラーの `tlv.instances` と呼び出し側が渡すスロットサイズ(= 上流の長さコントローラが確保したバイト数。IPv4 なら `(IHL − 5) × 4`)に応じて 3 つの形のいずれかに書き換わる。

1. **スロットのみ**(instance 無し・スロット > 0)— `bytes(slot)` のセルを 1 つ出す。クリックすると `TlvEditor` が開いて最初のレコードを追加できる。
2. **レコード有り** — instance ごとに `Group` を出す。各 instance は 1 セルとして描かれ、サブセルが Type / Length / Value の内訳を見せる。合計がスロットに満たなければ、末尾に `bytes(remaining)` のプレースホルダを置いてスロットの境界で図が閉じるようにする。
3. **どちらも無い**(instance もスロットも無い。IPv4 で IHL = 5 のケース)— 何も出さない。

実装は `lib/psdl/psdl-to-renderer/apply-tlv.ts`。**書き換えはレイアウト時にしか起きない** — 正規化済みフィールドとディスク上の PSDL は変わらないので、JSON / 共有 URL の往復は canonical なまま。

---

## Override サーフェス

編集の手段はスキーマに宣言されていない。**PSDL のプリミティブから導出される。**

| プリミティブ                                  | ミラー上のキー                   | ウィジェット                 |
| --------------------------------------------- | -------------------------------- | ---------------------------- |
| `Constraint` の `ref × lit = ref`(や `± lit`) | `controlsLength`                 | `OverrideSlider`             |
| `Switch on ref(X)`                            | `switchCases`                    | `SwitchDropdown`             |
| `Switch on peek(...)`                         | `peekSwitches`                   | パネル追加部のケースピッカー |
| `Optional when ref(X)`                        | `optionalGateFor`                | `OptionalToggle`             |
| varint / berLength                            | `varintEncoding`                 | `WidthPicker`                |
| enum 型                                       | `enumVariants`                   | `EnumDropdown`               |
| フィールドの `byteOrder`                      | `byteOrderOverrides`             | `ByteOrderToggle`            |
| `Repeat<Switch>`(TLV カタログ)                | `tlv`                            | `TlvEditor`                  |
| `Repeat<Switch>`(chain カタログ)              | `chain`                          | `ChainEditor`                |
| `Repeat { count: until / eos / ref(X) }`      | `freeRepeats` / `boundedRepeats` | `RepeatCountStepper`         |
| `defs` 経由の `ref` switch                    | `refSwitches`                    | 「Record variants」ピッカー  |

この表が `OverridePanel` のサーフェス面積そのものになる。フィールド未選択時の EmptyState は、パケット単位のコレクション(TLV エディタ / repeat / peek switch / record variants / 長さコントローラ)を一覧する。

### live / inert のゲート

サーフェスに出しただけでは足りない。**操作しても図が変わらないコントロールは、live に見せてはいけない** — それは see-but-cannot-edit そのものになる。二段で判定する:

1. **不在**: 対象フィールドが今の図に描かれていない(switch アームが未選択、レコードが未生成)。`fieldRendered(cells, key)` で判定する。
2. **inert**: 描かれてはいるが、値を動かしてもセル幅が 1 bit も変わらない。`collectInertLengthControllers`(`components/packet-viewer/inert-length-controllers.ts`)が実際にレイアウトを解き直して確かめる。**上下両方向にサンプルを取る**こと — 上方向だけだと、`bytes(len - K)` の affine payload(K を超えるまで幅 0)と、上限に張り付いた値(そこから上げても何も起きないが、下げれば動く)を取り違える。

どちらの場合も、disabled にしたうえで**次に何をすればよいかを名指しするヒント**を出す。ヒントが到達不能な操作を指していたら、それは行き止まりになる。

---

## 対象外

- **実際の復号** — PSDL は暗号化ペイロードの*形*をモデル化するが、鍵・AEAD・SSLKEYLOGFILE 的な流れは扱わない。レンダラが描くのは構造であってバイト列ではない。
- **パーサコードの生成** — それは Kaitai の仕事で、`ksc` を置き換えるつもりは無い。
