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
 *  Returns the input unchanged when the id is already plain. */
export function tlvBaseId(id: string): string {
  const role = parseTlvCellId(id);
  switch (role.kind) {
    case "instance":
    case "leaf":
    case "remaining":
      return role.baseId;
    case "plain":
      return id;
  }
}

/** True iff `groupId` was minted by `applyTlvInstances` (= ends with
 *  `__inst_<N>`). Used by `layout.ts` to decide single-child collapse
 *  policy. */
export function isTlvInstanceGroupId(groupId: string): boolean {
  return TLV_INSTANCE_RE.test(groupId);
}
