// PSDL ref collection — delegated to @packet-schema/core (PSDL 0.5).
//
// `collectPsdlRefs(packet)` gathers every `ref` field id used anywhere in a
// packet (field-length exprs, switch discriminators, repeat counts, optional
// `when`, constraints, …) so callers can pre-seed the env with 0 and guarantee
// a single-pass layout. Core's implementation walks the full 0.5 container and
// expression set; re-exported here to keep `@/lib/psdl/collect-refs` imports.

export { collectPsdlRefs } from "@packet-schema/core";
