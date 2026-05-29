# PSDL 0.4 cheatsheet

PSDL (Packet Schema Definition Language) の **1 ページ要約**。
詳しくは [`psdl-0.4.md`](./psdl-0.4.md) の該当節へ。

## Type — フィールドの型

固定 / 可変長のビット列。`bits` には数値リテラルか式が入ります。

```yaml
- { id: ver,  type: { kind: int, bits: 4 } }
- { id: dst,  type: { kind: bytes, bits: 48 } }      # 6 octets
- { id: data, type: { kind: bytes, bits: { ref: len, scale: 8 } } }
- { id: vlen, type: { kind: varint } }               # 0.3 QUIC/protobuf
- { id: tag,  type: { kind: int, bits: 8, byteOrder: LE } }  # 0.4 per-field
```

詳細: [`psdl-0.4.md` §Types](./psdl-0.4.md#types) /
[Varint](./psdl-0.4.md#varint-03) / [BER/DER](./psdl-0.4.md#berder-length-04)

## Expr — 純粋式 (JS 不要)

長さや条件をデータ駆動で表現します。

```yaml
# リテラル / 参照
{ lit: 32 }
{ ref: ihl, scale: 32 }

# 演算 (add / sub / mul / div / eq / ne / lt / gt / and / or)
{ op: mul, args: [ { ref: ihl }, { lit: 32 } ] }

# 三項
{ cond: { eq: [ { ref: typ }, { lit: 0x800 } ] }, then: { lit: 1 }, else: { lit: 0 } }

# 0.4: 先読み (まだ消費していないバイトを覗く)
{ peek: { offsetBits: 0, bits: 8 } }
```

詳細: [`psdl-0.4.md` §Expressions](./psdl-0.4.md#expressions) /
[Peek](./psdl-0.4.md#peek-expression-04)

## Container — 構造の組み立て

```yaml
# Group: フィールド列をインライン展開
- { kind: group, body: [ ... ] }

# Repeat: 同じ struct を N 個
- { kind: repeat, count: { ref: nopts }, body: [ ... ] }

# Switch: discriminator で分岐
- kind: switch
  on: { ref: typ }
  cases:
    - { when: 1, body: [ ... ] }
    - { when: 6, body: [ ... ] }
  default: { body: [ ... ] }

# Optional (0.4): 条件付きで現れる
- { kind: optional, when: { eq: [ { ref: ext }, { lit: 1 } ] }, body: [ ... ] }

# Encrypted (0.3): 暗号化境界の宣言。viewMode で wire ⇔ semantic
- { kind: encrypted, bits: { ref: cipherLen }, payload: [ ... ] }
```

詳細: [`psdl-0.4.md` §Containers](./psdl-0.4.md#containers) /
[Optional](./psdl-0.4.md#optional-04) /
[Encrypted](./psdl-0.4.md#encrypted-03)

## Constraint — 双方向制約

ユーザ編集を両方向に伝播 (例: `IHL × 4 == headerBytes`)。

```yaml
constraints:
  - { eq: [ { op: mul, args: [ { ref: ihl }, { lit: 4 } ] }, { ref: headerBytes } ] }
```

詳細: [`psdl-0.4.md` §Constraints](./psdl-0.4.md#constraints)

## Packet — トップレベル

```yaml
name: My Header
rowBits: 32           # 1 行の bit 幅
byteOrder: BE         # デフォルト byte order
description: ...
body: [ ... ]         # フィールド列
constraints: [ ... ]  # (省略可)
```

詳細: [`psdl-0.4.md` §Packet](./psdl-0.4.md#packet) /
[JSON serialization](./psdl-0.4.md#json-serialization)

---

## すぐ書き始めたい人向けテンプレ

`data/presets/<key>.psdl.yaml` にコピペしてからフィールドを書き換えてください。

```yaml
# yaml-language-server: $schema=../../schemas/psdl.schema.json
name: TODO Header
rowBits: 32
byteOrder: BE
description: TODO — 1 行で何のヘッダかを書く。
body:
  - { id: field1, name: Field 1, type: { kind: int, bits: 8 } }
  - { id: len,    name: Length,  type: { kind: int, bits: 16 }, category: length }
  - id: payload
    name: Payload
    type: { kind: bytes, bits: { ref: len, scale: 8 } }
    category: payload
```
