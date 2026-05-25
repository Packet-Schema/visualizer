// TLV cell-id shape & parsing — the canonical source for the synthetic
// id suffixes that `applyTlvInstances` mints. Lives in `lib/` so layout
// helpers can share the constants with the UI parser in
// `components/field-details/tlv-cell-id.ts` (which re-exports from here
// to keep component imports component-local).
//
// Synthetic id shapes emitted by `applyTlvInstances`:
//   * `<repeatId>__inst_<N>`              — instance Group parent cell
//   * `<repeatId>__inst_<N>__<leafId>`    — leaf field inside an instance
//   * `<repeatId>__remaining`             — trailing "Options remaining"
//
// Plain ids (top-level fields, sub-cell `parent:sub`, Repeat `id#N`) are
// returned as `{ kind: "plain" }` so callers can fall through.

export const TLV_INSTANCE_RE = /__inst_(\d+)$/;
const INSTANCE_LEAF_RE = /^(.+)__inst_(\d+)__(.+)$/;
const INSTANCE_RE = /^(.+)__inst_(\d+)$/;
const REMAINING_SUFFIX = "__remaining";

export type TlvCellRole =
  | { kind: "instance"; baseId: string; instanceIndex: number }
  | { kind: "remaining"; baseId: string }
  | { kind: "leaf"; baseId: string; instanceIndex: number; leafId: string }
  | { kind: "plain" };

export function parseTlvCellId(id: string): TlvCellRole {
  if (!id) return { kind: "plain" };
  // `parent:sub` subfield ids reach this parser too (HybridDiagram
  // dispatches sub-cell clicks with that shape). Without explicit
  // handling the greedy `INSTANCE_LEAF_RE` would treat
  // `options__inst_0:options__inst_0__type` as a TLV leaf and produce
  // a corrupt `baseId` that contains the colon (Codex P1). When the
  // parent half *is* an instance shape, decode to the leaf role with
  // a clean baseId / instanceIndex / leafId so callers can still route
  // the click. Otherwise fall through to "plain" — real packet-level
  // subfield clicks are handled by `selection-resolver` downstream.
  if (id.includes(":")) {
    // Split on the rightmost colon so a TLV synthetic id whose parent
    // half happens to contain a colon (degenerate / hand-authored
    // preset) still routes correctly. `validatePsmlPacket` also rejects
    // `:` in user-authored field ids, so this only ever fires on
    // renderer-minted shapes; defense in depth is cheap (Codex P2).
    const colonIdx = id.lastIndexOf(":");
    const parentPart = id.slice(0, colonIdx);
    const subPart = id.slice(colonIdx + 1);
    const instMatch = parentPart.match(INSTANCE_RE);
    if (instMatch) {
      // Layout writes SubField ids as `<parentInstanceId>__<leafId>`;
      // strip the parent prefix when present so `leafId` matches the
      // TLV catalog entry's field id.
      const prefix = `${parentPart}__`;
      const leafId = subPart.startsWith(prefix)
        ? subPart.slice(prefix.length)
        : subPart;
      return {
        kind: "leaf",
        baseId: instMatch[1],
        instanceIndex: Number(instMatch[2]),
        leafId,
      };
    }
    return { kind: "plain" };
  }
  const leaf = id.match(INSTANCE_LEAF_RE);
  if (leaf) {
    return {
      kind: "leaf",
      baseId: leaf[1],
      instanceIndex: Number(leaf[2]),
      leafId: leaf[3],
    };
  }
  const inst = id.match(INSTANCE_RE);
  if (inst) {
    return {
      kind: "instance",
      baseId: inst[1],
      instanceIndex: Number(inst[2]),
    };
  }
  if (id.endsWith(REMAINING_SUFFIX)) {
    return {
      kind: "remaining",
      baseId: id.slice(0, -REMAINING_SUFFIX.length),
    };
  }
  return { kind: "plain" };
}

/** Strip any TLV-rewrite suffix to recover the underlying TLV field id.
 *  Returns the input unchanged when the id is already plain.
 *
 *  Also strips a trailing `#<N>` repeat-index tag from plain ids so
 *  callers get the same canonical lookup key for `flagsBits` (top-level)
 *  and `flagsBits#0` (Group inside a Repeat). The previous asymmetry —
 *  HybridDiagram special-cased `#` while everyone else trusted
 *  `tlvBaseId` — was a foot-gun (Codex deep review). */
export function tlvBaseId(id: string): string {
  const role = parseTlvCellId(id);
  switch (role.kind) {
    case "instance":
    case "leaf":
    case "remaining":
      return role.baseId;
    case "plain":
      return id.replace(/#\d+(?:_\d+)*$/, "");
  }
}

/** True iff `groupId` was minted by `applyTlvInstances` (= ends with
 *  `__inst_<N>`). Used by `layout.ts` to decide single-child collapse
 *  policy. */
export function isTlvInstanceGroupId(groupId: string): boolean {
  return TLV_INSTANCE_RE.test(groupId);
}
