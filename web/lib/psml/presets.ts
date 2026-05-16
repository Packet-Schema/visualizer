// PSML 0.4 — preset registry re-export.
//
// All built-in presets now live as YAML in `data/presets/*.psml.yaml`. They
// are validated against `schemas/psml.schema.json` and compiled to
// `presets.generated.ts` by `web/scripts/build-presets.ts` at build time
// (wired through the `prebuild` and `pretest` npm hooks).
//
// To add or edit a preset: drop a new `.psml.yaml` into `data/presets/`,
// then run `npm run build:presets`. No TS changes required.

export { PRESETS, PRESET_KEYS } from "./presets.generated";
