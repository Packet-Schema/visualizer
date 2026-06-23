// PSDL 0.2 — layout adapter.
//
// `resolveLayout(psdlPacket, env)` is the entry point used by the format
// hub to compute a renderer-shaped layout from a PSDL Packet. It runs
// PSDL's `normalize()` to expand Repeat/Switch/Group, then walks the flat
// NormalizedField[] to produce a `ResolvedLayout` with row-segmented cells
// matching the v1 cell-layout output (so existing format renderers stay
// surface-level — they only need to know how to read cells).

import type {
  Container,
  Normalized,
  NormalizedField,
  PacketEnv,
  Packet as PsdlPacket,
  ViewMode,
} from "./types";
import {
  berLenEnvKey,
  bytesDelimLenEnvKey,
  initialEnv,
  isBytesDelimited,
  normalize,
  varintBitsEnvKey,
} from "./normalize";
import { isField } from "./utils";
import type {
  Cell,
  Field as RendererField,
  ResolvedLayout,
  SubCell,
} from "./renderer";
import { isTlvInstanceGroupId } from "./psdl-to-renderer/tlv-cell-id";

export type LayoutOptions = {
  /** Environment overlay merged on top of preset defaults. */
  env?: PacketEnv;
  /**
   * Wire vs. semantic view of any Encrypted containers in the schema.
   * Defaults to `'wire'`. See `web/lib/psdl/normalize.ts` for the full
   * contract.
   */
  viewMode?: ViewMode;
  /**
   * Total packet wire size (bits) to budget the top-level scope with. Required
   * by core's normalize when the packet uses top-level `remaining` /
   * `enclosingBits` (§4/§11.2). When omitted, `resolveLayout` measures the
   * fixed prefix and budgets a default variable region so the diagram still
   * renders a representative cell (see `normalizeWithBudget`).
   */
  totalBits?: number;
};

/**
 * Default bit budget given to a top-level variable region (`remaining`) at
 * design time when the caller did not pin a concrete packet size — one full
 * row, so the variable tail renders as a visible, representative cell.
 */
const DEFAULT_VARIABLE_REGION_BITS_FALLBACK = 32;

/** Compute a renderer-shaped layout for a PSDL packet. */
export function resolveLayout(
  packet: PsdlPacket,
  options: LayoutOptions = {},
): ResolvedLayout {
  // `validate.ts` already requires rowBits > 0 on the import path, but
  // callers that hand-build a PsdlPacket in tests / fuzz harness can
  // reach `resolveLayout` without going through validation. Guarding
  // here keeps the `bitPos % rowBits` / `Math.floor(bitPos / rowBits)`
  // arithmetic below from collapsing into NaN.
  if (!Number.isInteger(packet.rowBits) || packet.rowBits <= 0) {
    throw new Error(
      `resolveLayout: rowBits must be a positive integer; got ${String(packet.rowBits)}.`,
    );
  }
  const env: PacketEnv = new Map(options.env ?? initialEnv(packet));
  // Bridge the visualizer's field-id-keyed dynamic-width overrides to the
  // synthetic env keys core's `typeBits` reads (PSDL 0.5 separates a field's
  // value from its wire width). Controllers / share-URLs stay keyed by field
  // id; this is the single boundary where they become core's env contract.
  bridgeDynamicWidthKeys(packet, env);
  const viewMode: ViewMode = options.viewMode ?? "wire";
  const norm = normalizeWithBudget(packet, env, viewMode, options.totalBits);
  const cells: Cell[] = [];
  let bitPos = 0;
  // Renderer interpretation pass (see PSDL design principles —
  // "semantic, not presentational"): runs of consecutive NormalizedFields
  // that share the same non-empty `originalContainerPath` come from the
  // same Group / Switch case / Repeat iteration; collapse them into one
  // synthetic cell whose `subfields[]` lists the children. Top-level
  // fields (path === "") stay flat. The visual interpretation is purely
  // additive — `NormalizedField[]` itself is unchanged, so RFC ASCII /
  // JSON / other consumers keep the flat structure.
  const groups = groupConsecutiveByContainer(norm.fields);
  for (const g of groups) {
    if (g.kind === "flat") {
      const nf = g.field;
      const synthetic: RendererField = {
        id: nf.id,
        name: nf.name,
        bits: nf.bits,
        ...(nf.category ? { category: nf.category } : {}),
        ...(nf.doc ? { description: nf.doc } : {}),
      };
      bitPos = emitField(synthetic, nf, bitPos, packet.rowBits, cells);
      continue;
    }
    // Collapsed group: synthesise one parent cell with subfields. Per-child
    // encryption / byteOrder decoration flows through to the SubCells via
    // `childNFs`; the parent cell's own flags stay neutral unless every
    // child agrees (so a mixed-encrypted-and-cleartext Group doesn't
    // mistakenly claim its whole row is encrypted).
    const first = g.children[0];
    const totalBits = g.children.reduce((a, f) => a + f.bits, 0);
    if (totalBits === 0) continue;
    const synthetic: RendererField = {
      id: g.parentId,
      name: g.parentName,
      bits: totalBits,
      subfields: g.children.map((c) => ({
        id: c.id.replace(/#\d+$/, ""), // strip repeatIndex for stable subfield id
        name: c.name,
        bits: c.bits,
        ...(c.doc ? { description: c.doc } : {}),
      })),
      ...(g.children.find((c) => c.category)?.category
        ? { category: g.children.find((c) => c.category)!.category! }
        : {}),
    };
    const allEncrypted = g.children.every((c) => c.encrypted);
    const sharedEncryptedParentId =
      g.children[0].encryptedParentId &&
      g.children.every(
        (c) => c.encryptedParentId === g.children[0].encryptedParentId,
      )
        ? g.children[0].encryptedParentId
        : undefined;
    const allHeaderProtected = g.children.every((c) => c.headerProtected);
    const allSameByteOrder =
      g.children[0].byteOrder &&
      g.children.every((c) => c.byteOrder === g.children[0].byteOrder)
        ? g.children[0].byteOrder
        : undefined;
    const proxy: typeof first = {
      ...first,
      id: g.parentId,
      name: g.parentName,
      bits: totalBits,
      encrypted: allEncrypted ? true : undefined,
      encryptedParentId: sharedEncryptedParentId,
      encryptedContextNote: sharedEncryptedParentId
        ? g.children[0].encryptedContextNote
        : undefined,
      headerProtected: allHeaderProtected ? true : undefined,
      byteOrder: allSameByteOrder,
    };
    bitPos = emitField(
      synthetic,
      proxy,
      bitPos,
      packet.rowBits,
      cells,
      g.children,
    );
  }
  return { cells, totalBits: norm.totalBits };
}

/**
 * Run core's `normalize`, supplying a top-level wire-size budget when the
 * packet needs one. Most packets normalize in a single pass. Packets that use
 * top-level `remaining` / `enclosingBits` (PSDL 0.5, §4/§11.2) require a
 * `totalBits` budget — at design time we don't know the real packet size, so:
 *   1. measure the fixed prefix by normalizing with a zero budget (`remaining`
 *      clamps to 0), then
 *   2. re-normalize budgeting the fixed prefix plus one default row for the
 *      variable region, so it renders as a representative cell.
 * An explicit `totalBits` (e.g. a future "packet size" control) short-circuits
 * the estimation.
 */
function normalizeWithBudget(
  packet: PsdlPacket,
  env: PacketEnv,
  viewMode: ViewMode,
  totalBits?: number,
): Normalized {
  if (totalBits !== undefined) {
    return normalize(packet, env, { viewMode, totalBits });
  }
  try {
    return normalize(packet, env, { viewMode });
  } catch (e) {
    if (
      !(e instanceof Error) ||
      !e.message.includes("did not inject the total packet size")
    ) {
      throw e;
    }
    const fixed = normalize(packet, new Map(env), { viewMode, totalBits: 0 });
    const budget =
      fixed.totalBits +
      Math.max(packet.rowBits, DEFAULT_VARIABLE_REGION_BITS_FALLBACK);
    return normalize(packet, env, { viewMode, totalBits: budget });
  }
}

/**
 * Copy field-id-keyed dynamic-width overrides into the synthetic env keys
 * core's `typeBits` reads. In PSDL 0.4 the visualizer overloaded a field's id
 * env key to carry both its value and (for varint / berLength / delimited
 * bytes) its wire bit-width. PSDL 0.5 keeps those namespaces distinct
 * (`__varintBits__<id>` etc.), so we bridge the value the controllers wrote
 * under the field id over to the width key the engine expects. Existing
 * (synthetic) keys win, so an explicit width key is never clobbered.
 */
function bridgeDynamicWidthKeys(packet: PsdlPacket, env: PacketEnv): void {
  const visit = (containers: Container[]): void => {
    for (const c of containers) {
      if (isField(c)) {
        const v = env.get(c.id);
        if (v !== undefined) {
          let key: string | null = null;
          if (c.type.kind === "varint") key = varintBitsEnvKey(c.id);
          else if (c.type.kind === "berLength") key = berLenEnvKey(c.id);
          else if (c.type.kind === "bytes" && isBytesDelimited(c.type.n))
            key = bytesDelimLenEnvKey(c.id);
          if (key && !env.has(key)) env.set(key, v);
        }
        continue;
      }
      switch (c.kind) {
        case "group":
          visit(c.children);
          break;
        case "repeat":
          visit(c.element.fields);
          break;
        case "switch":
          for (const s of Object.values(c.cases)) visit(s.fields);
          break;
        case "encrypted":
          visit(c.plaintext.fields);
          break;
        case "optional":
          visit([c.container]);
          break;
        case "bounded":
          visit(c.fields);
          break;
        // virtual / align / ref expose no dynamic-width leaf to bridge.
      }
    }
  };
  visit(packet.body);
}

type GroupedRun =
  | { kind: "flat"; field: NormalizedField }
  | {
      kind: "collapsed";
      parentId: string;
      parentName: string;
      children: NormalizedField[];
    };

/**
 * Walk the flat NormalizedField list and combine consecutive entries that
 * share the same `groupId` (i.e. they were emitted as siblings inside
 * the same `Group` container). The combined run becomes a single cell
 * whose `subfields[]` lists each child — canonical uses:
 *   * IPv4/TCP flags (3 1-bit children of a Group → one cell with three
 *     sub-cells).
 *   * TLV instance Groups (per-instance leaf list → one cell named after
 *     the variant; NOP / EOL single-field variants also collapse so the
 *     cell label is the variant name, not the leaf field's name).
 * Fields outside any Group stay flat.
 */
function groupConsecutiveByContainer(fields: NormalizedField[]): GroupedRun[] {
  const out: GroupedRun[] = [];
  let i = 0;
  while (i < fields.length) {
    const f = fields[i];
    if (!f.groupId) {
      out.push({ kind: "flat", field: f });
      i++;
      continue;
    }
    const groupId = f.groupId;
    // Boundary key: groupId alone collides across Repeat iterations
    // (`Repeat(Group([F1, F2]))` emits the SAME `groupId` per iteration,
    // so consecutive iterations would erroneously fuse). The container
    // path always carries `[i]` for the surrounding Repeat, so it
    // distinguishes iterations while still matching siblings within one
    // iteration. (Codex P1)
    const groupPath = f.originalContainerPath;
    const run: NormalizedField[] = [f];
    let j = i + 1;
    while (
      j < fields.length &&
      fields[j].groupId === groupId &&
      fields[j].originalContainerPath === groupPath
    ) {
      run.push(fields[j]);
      j++;
    }
    // Single-child collapse policy:
    //   * Groups synthesised by `applyTlvInstances` always collapse — even
    //     a 1-field variant (NOP / EOL) reads as "NOP" rather than its
    //     leaf's `Type=1`. These groups carry the `__inst_N` id suffix.
    //   * Hand-authored Groups (TCP / IPv4 flags etc.) only collapse when
    //     they have 2+ children. A 1-child Group whose author intended the
    //     leaf to be the visible label (e.g. a wrapper used for grouping
    //     metadata) stays flat so we don't silently rename it.
    if (run.length === 1 && !isTlvInstanceGroupId(groupId)) {
      out.push({ kind: "flat", field: f });
      i = j;
      continue;
    }
    out.push({
      kind: "collapsed",
      parentId: groupId,
      parentName: f.groupName ?? groupId,
      children: run,
    });
    i = j;
  }
  return out;
}

function emitField(
  field: RendererField,
  nf: NormalizedField,
  bitPos: number,
  rowBits: number,
  cells: Cell[],
  childNFs?: NormalizedField[],
): number {
  const bits = nf.bits;
  if (bits === 0) return bitPos;
  let remaining = bits;
  let segmentIndex = 0;
  const totalSegments = computeSegmentCount(bitPos, bits, rowBits);
  while (remaining > 0) {
    const row = Math.floor(bitPos / rowBits);
    const colInRow = bitPos % rowBits;
    const take = Math.min(remaining, rowBits - colInRow);
    const cell: Cell = {
      field,
      bitsTotal: bits,
      row,
      startBit: colInRow,
      endBit: colInRow + take - 1,
      segmentIndex,
      totalSegments,
      isFirst: segmentIndex === 0,
      isLast: remaining === take,
      fieldStartOffset: bits - remaining,
      fieldEndOffset: bits - remaining + take - 1,
    };
    if (nf.encrypted) cell.encrypted = true;
    if (nf.encryptedParentId !== undefined) {
      cell.encryptedParentId = nf.encryptedParentId;
    }
    if (nf.encryptedContextNote !== undefined) {
      cell.encryptedContextNote = nf.encryptedContextNote;
    }
    if (nf.headerProtected) cell.headerProtected = true;
    if (nf.byteOrder) cell.byteOrder = nf.byteOrder;
    if (field.subfields && field.subfields.length > 0) {
      cell.subCells = buildSubCells(
        field,
        field.subfields,
        cell.fieldStartOffset,
        cell.fieldEndOffset,
        colInRow,
        rowBits,
        childNFs,
      );
    }
    cells.push(cell);
    remaining -= take;
    bitPos += take;
    segmentIndex++;
  }
  return bitPos;
}

/**
 * Build the per-segment SubCell list for a parent cell that owns
 * `subfields`. The parent cell's segment covers the parent-field offset
 * range [`fieldStartOffset`, `fieldEndOffset`]; we walk every subfield's
 * own offset range and emit a SubCell for the slice that intersects this
 * segment. A 3-bit `flagsBits` Group fully on one row produces three 1-bit
 * SubCells; a longer subfield that straddles rows emits two SubCells
 * (one per row segment) with `isFirst`/`isLast` markers matching how
 * parent cells segment.
 */
function buildSubCells(
  parentField: RendererField,
  subfields: NonNullable<RendererField["subfields"]>,
  fieldStartOffset: number,
  fieldEndOffset: number,
  segmentColInRow: number,
  _rowBits: number,
  childNFs?: NormalizedField[],
): SubCell[] {
  const out: SubCell[] = [];
  let cursor = 0;
  for (let i = 0; i < subfields.length; i++) {
    const sf = subfields[i];
    const subStart = cursor;
    const subEnd = cursor + sf.bits;
    cursor = subEnd;
    const lo = Math.max(subStart, fieldStartOffset);
    const hi = Math.min(subEnd, fieldEndOffset + 1);
    if (lo >= hi) continue;
    const startBit = segmentColInRow + (lo - fieldStartOffset);
    const endBit = startBit + (hi - lo) - 1;
    const childNF = childNFs?.[i];
    const sub: SubCell = {
      parentField,
      subfield: sf,
      id: `${parentField.id}:${sf.id}`,
      startBit,
      endBit,
      isFirst: lo === subStart,
      isLast: hi === subEnd,
      bitsTotal: sf.bits,
    };
    if (childNF?.encrypted) sub.encrypted = true;
    if (childNF?.encryptedParentId !== undefined) {
      sub.encryptedParentId = childNF.encryptedParentId;
    }
    if (childNF?.encryptedContextNote !== undefined) {
      sub.encryptedContextNote = childNF.encryptedContextNote;
    }
    if (childNF?.headerProtected) sub.headerProtected = true;
    if (childNF?.byteOrder) sub.byteOrder = childNF.byteOrder;
    out.push(sub);
  }
  return out;
}

function computeSegmentCount(
  startPos: number,
  bits: number,
  rowBits: number,
): number {
  let remaining = bits;
  let pos = startPos;
  let count = 0;
  while (remaining > 0) {
    const colInRow = pos % rowBits;
    const take = Math.min(remaining, rowBits - colInRow);
    remaining -= take;
    pos += take;
    count++;
  }
  return count;
}
