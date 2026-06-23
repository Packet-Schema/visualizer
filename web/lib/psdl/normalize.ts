// PSDL normalize — delegated to @packet-schema/core (PSDL 0.5).
//
// `normalize()` expands the recursive container tree (Repeat / Switch / Group /
// Optional / Encrypted / Bounded / Virtual / Align / ref) into the flat
// `NormalizedField[]` the renderer's cell-layout consumes. The engine now lives
// in core; this module re-exports it (plus the env helpers) so existing
// `@/lib/psdl/normalize` imports keep working with the full 0.5 semantics.

export {
  normalize,
  initialEnv,
  typeBits,
  berLenEnvKey,
  varintBitsEnvKey,
  bytesDelimLenEnvKey,
  isBytesDelimited,
  selectArm,
} from "@packet-schema/core";
export type { NormalizeOptions } from "@packet-schema/core";
