// PSDL 0.4 — Kaitai Struct (.ksy) light import/export bridge (barrel).
//
// The historical single-file module was split into:
//   - ksy/types.ts     — minimal KSY YAML typings + registry helpers
//   - ksy/importer.ts  — fromKsy + private walkSeq / wrapInRepeat etc.
//   - ksy/exporter.ts  — toKsy + private containerToKsy / fieldToKsy etc.
//
// Public entry points stay on `@/lib/formats/ksy` so call sites do not
// have to care about the internal split.

export { fromKsy } from "./ksy/importer";
export { toKsy } from "./ksy/exporter";
