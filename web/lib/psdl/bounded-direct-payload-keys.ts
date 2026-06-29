// Dual-role boundedRepeat length keys.
//
// A boundedRepeat's `lengthKey` is normally EXEMPT from PacketViewer's direct
// length-controller cap (`directLengthControllerIds`): its value drives a
// budget-DERIVED record count that is already capped to MAX_DERIVED_RECORDS in
// the bounded loop, and clamping the budget there would wrongly shrink that
// scope's visible record count.
//
// But the SAME length field often ALSO directly sizes a `bytes(ref X)` payload
// in a DIFFERENT switch arm — the generic / raw / data arm. http3Frame's
// `http3PayloadLength` budgets a `bounded` in the SETTINGS / PUSH_PROMISE arms
// yet directly sizes `data = bytes(ref http3PayloadLength)` in the DATA arm;
// dnssecRecords' `rrRdLength`, ospf's `packetLength`, tlsClientHello's
// `extensionsLen`, ocspRequest's `reqListLength`, bgpUpdateFull's
// `bgpTotalPathAttributeLength` are the same shape. resolveLayout emits ~1 SVG
// cell per payload byte for that direct arm, and because the key escapes the
// cap, dragging its 16-bit slider toward 65535 generates tens of thousands of
// un-virtualized cells and FREEZES the page — the very freeze the cap exists to
// prevent.
//
// This pass walks the PSDL body and returns the set of length keys that have a
// `bytes(ref X)` payload OUTSIDE the `bounded` scope that X budgets — the
// "direct-payload-bearing" (dual-role) keys. PacketViewer clamps env[X] for
// these to MAX_LENGTH_CONTROLLER_BYTES, applied BEFORE deriving the bounded
// count so the budget and the derived count stay consistent (clamping AFTER
// would leave a 1024-record count against a 1024-byte budget and core's
// normalize throws `bounded scope over-consumed`). A PURE bounded length (no
// direct payload arm) is NOT returned, so its slider keeps its full range and
// the record-display UX is unaffected.

import { isField } from "./utils";
import { exprRefs } from "./expr";
import type { Container, NamedStruct, Packet as PsdlPacket } from "./types";

type Ctx = {
  defs: Record<string, NamedStruct>;
  seen: Set<string>;
  /** Length keys whose `bounded` scope we are currently INSIDE. A `bytes(ref X)`
   *  found while X is in this set is the budgeted scope's own payload, NOT a
   *  separate direct arm, so it does not mark X. */
  insideBoundedFor: Set<string>;
  /** Keys that size a `bytes(ref X)` payload OUTSIDE their bounded scope. */
  direct: Set<string>;
};

/** A `bytes` size `n` that is a plain `ref` → the referenced field id, else null. */
function bytesRefField(n: unknown): string | null {
  if (
    n !== null &&
    typeof n === "object" &&
    (n as { kind?: unknown }).kind === "ref" &&
    typeof (n as { field?: unknown }).field === "string"
  ) {
    return (n as { field: string }).field;
  }
  return null;
}

function walk(c: Container, ctx: Ctx): void {
  if (isField(c)) {
    const t = c.type;
    if (t.kind === "bytes") {
      const ref = bytesRefField(t.n);
      if (ref !== null && !ctx.insideBoundedFor.has(ref)) {
        ctx.direct.add(ref);
      }
    }
    return;
  }
  if (c.kind === "group") {
    for (const ch of c.children) walk(ch, ctx);
    return;
  }
  if (c.kind === "repeat") {
    for (const f of c.element.fields) walk(f, ctx);
    return;
  }
  if (c.kind === "switch") {
    for (const v of Object.values(c.cases)) {
      for (const f of v.fields) walk(f, ctx);
    }
    return;
  }
  if (c.kind === "encrypted") {
    for (const f of c.plaintext.fields) walk(f, ctx);
    return;
  }
  if (c.kind === "optional") {
    walk(c.container, ctx);
    return;
  }
  if (c.kind === "bounded") {
    // Mark every ref the budget depends on as "inside" for the scope's subtree,
    // so a `bytes(ref X)` that IS this scope's budgeted payload doesn't count as
    // a separate direct arm. Restore on exit (a sibling arm outside the scope
    // must still be detectable).
    const budgetRefs = exprRefs(c.bytes).filter(
      (r) => !ctx.insideBoundedFor.has(r),
    );
    for (const r of budgetRefs) ctx.insideBoundedFor.add(r);
    for (const f of c.fields) walk(f, ctx);
    for (const r of budgetRefs) ctx.insideBoundedFor.delete(r);
    return;
  }
  if (c.kind === "ref") {
    const def = ctx.defs[c.ref];
    if (!def || ctx.seen.has(c.ref)) return;
    ctx.seen.add(c.ref);
    for (const f of def.fields) walk(f, ctx);
    ctx.seen.delete(c.ref);
    return;
  }
  // align carries no nested size.
}

/** Return the set of boundedRepeat `lengthKey`s that ALSO directly size a
 *  `bytes(ref X)` payload OUTSIDE the `bounded` scope they budget. Restricted to
 *  the supplied `boundedKeys` (the active mirror's `lengthKey`s) so a non-bounded
 *  direct length controller — already handled by the normal cap — is never
 *  returned. */
export function boundedKeysWithDirectPayload(
  psdl: PsdlPacket,
  boundedKeys: Iterable<string>,
): Set<string> {
  const ctx: Ctx = {
    defs: psdl.defs ?? {},
    seen: new Set(),
    insideBoundedFor: new Set(),
    direct: new Set(),
  };
  for (const c of psdl.body) walk(c, ctx);
  const keys = new Set(boundedKeys);
  const out = new Set<string>();
  for (const k of ctx.direct) if (keys.has(k)) out.add(k);
  return out;
}
