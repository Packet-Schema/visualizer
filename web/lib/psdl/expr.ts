// PSDL expressions — delegated to @packet-schema/core (PSDL 0.5).
//
// The expression constructors, evaluator, and walkers now live in core. This
// module re-exports them so existing `@/lib/psdl/expr` imports keep working
// while gaining the 0.5 expression set (lookup / wireSize / prevIter /
// remaining / enclosingBits / enclosingField) for free.

export {
  lit,
  ref,
  op,
  cond,
  peek,
  lookup,
  wireSize,
  prevIter,
  remaining,
  enclosingBits,
  enclosingField,
  peekEnvKey,
  remainingEnvKey,
  enclosingBitsEnvKey,
  wireSizeEnvKey,
  prevIterEnvKey,
  enclosingFieldEnvKey,
  evalExpr,
  evalExprOr,
  exprRefs,
  walkExpr,
  exprContains,
  MissingRefError,
} from "@packet-schema/core";
