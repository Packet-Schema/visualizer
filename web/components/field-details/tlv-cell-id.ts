// Parse a cell `data-field-id` into its TLV-rewrite role.
//
// `applyTlvInstances` rewrites PSML body to attach decoration suffixes to
// synthetic cell ids:
//   * `<repeatId>__inst_<N>`              — collapsed instance parent cell
//   * `<repeatId>__inst_<N>__<leafId>`    — leaf field inside an instance Group
//   * `<repeatId>__remaining`             — trailing "Options remaining (N B)"
//   * `<repeatId>` exactly                — empty slot placeholder (no records yet)
// Anything else is a regular field id (or a subfield `parent:sub`).
//
// HybridDiagram needs the base TLV id (for the overridable marker lookup);
// OverridePanel needs both the base and the role (to choose between
// TlvEditor / TlvInnerVariantDropdown / fallthrough). Sharing one parser
// keeps the suffix convention in a single place — any future tweak to the
// id shape only has to touch this file.

export type TlvCellRole =
  | { kind: "instance"; baseId: string; instanceIndex: number }
  | { kind: "remaining"; baseId: string }
  | { kind: "leaf"; baseId: string; instanceIndex: number; leafId: string }
  | { kind: "plain" };

const INSTANCE_LEAF = /^(.+)__inst_(\d+)__(.+)$/;
const INSTANCE = /^(.+)__inst_(\d+)$/;
const REMAINING_SUFFIX = "__remaining";

export function parseTlvCellId(id: string): TlvCellRole {
  if (!id) return { kind: "plain" };
  const leaf = id.match(INSTANCE_LEAF);
  if (leaf) {
    return {
      kind: "leaf",
      baseId: leaf[1],
      instanceIndex: Number(leaf[2]),
      leafId: leaf[3],
    };
  }
  const inst = id.match(INSTANCE);
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
