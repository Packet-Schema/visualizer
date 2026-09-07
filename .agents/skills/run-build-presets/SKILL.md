---
name: run-build-presets
description: Packet Schema Visualizer リポジトリで preset 生成を実行したいときに使う。data/presets や関連スクリプト変更後に web ディレクトリで npm run build:presets を実行し、生成物差分を確認したい場合にこのスキルを使う。
---

# preset 生成実行

`data/presets/*.psdl.yaml` や `web/scripts/build-presets.ts` に変更がある場合は、`web` ディレクトリで preset 生成を実行します。生成対象は `web/lib/psdl/presets.generated.ts` です。

## 実行手順

1. `web` ディレクトリへ移動する。
2. `npm run build:presets` を実行する。
3. 生成後はコマンド成功、生成物の更新時刻やファイル内容、必要に応じた比較結果を確認し、要点を共有する。

## コマンド

```bash
cd web
npm run build:presets
```

## 補足

- `web/package-lock.json` があるため、パッケージマネージャーは `npm` を使う。
- `data/presets/*.psdl.yaml` `schemas/psdl.schema.json` `web/scripts/build-presets.ts` を変更した場合は、このスキルを優先して使う。
- `web/lib/psdl/presets.generated.ts` は gitignore 対象なので、通常の `git diff` では確認できない前提で扱う。
- `web` ディレクトリに移動した後の生成確認には `ls -l lib/psdl/presets.generated.ts` や `sed -n '1,40p' lib/psdl/presets.generated.ts` などで内容と生成結果を確認する。
- 生成前後の比較が必要なら、旧ファイルを一時退避して `diff --no-index` で比較する。
