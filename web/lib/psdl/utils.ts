// PSDL structural utilities — delegated to @packet-schema/core.
//
// `isField` is the Container type guard reused across normalize / validate /
// psdl-to-renderer. It now lives in core; re-exported here so existing
// `@/lib/psdl/utils` imports keep working.

export { isField } from "@packet-schema/core";
