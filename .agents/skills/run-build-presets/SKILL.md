---
name: run-build-presets
description: packet-view リポジトリで preset 生成を実行したいときに使う。data/presets や関連スクリプト変更後に web ディレクトリで npm run build:presets を実行し、生成物差分を確認したい場合にこのスキルを使う。
---

# preset 生成実行

`data/presets/*.psml.yaml` や `web/scripts/build-presets.ts` に変更がある場合は、`web` ディレクトリで preset 生成を実行します。生成対象は `web/lib/psml/presets.generated.ts` です。

## 実行手順

1. `web` ディレクトリへ移動する。
2. `npm run build:presets` を実行する。
3. 生成後は `web/lib/psml/presets.generated.ts` を含む差分を確認し、必要なら要約して共有する。

## コマンド

```bash
cd /workspaces/packet-view/web
npm run build:presets
```

## 補足

- `web/package-lock.json` があるため、パッケージマネージャーは `npm` を使う。
- `data/presets/*.psml.yaml` `schemas/psml.schema.json` `web/scripts/build-presets.ts` を変更した場合は、このスキルを優先して使う。
- 生成後の確認には `git status --short` `git diff -- web/lib/psml/presets.generated.ts` などを使う。
