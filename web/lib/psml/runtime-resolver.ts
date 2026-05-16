// PSML 0.2 — runtime layout resolver.
//
// Bit-by-bit cell-layout algorithm that produces row-segmented cells with
// subfields positioned in the lower half of their parent. Used by every
// renderer component. Also handles TLV expansion (TCP/IPv4 options, TLS
// extensions) and IPv6 extension-header chain expansion.

import type {
  Cell,
  ChainBlock,
  ControllerState,
  Field,
  Packet,
  ResolvedLayout,
  ResolvedTlv,
  SubCell,
  SubField,
  TlvBlock,
  TlvCatalogEntry,
  TlvCatalogField,
  TlvInstance,
} from "./runtime-types";
import type { ViewMode } from "./types";

/**
 * Options bag for {@link resolvePacket}. Currently only `viewMode` is read,
 * and it is forward-plumbing for Phase 2C — the runtime path doesn't yet
 * synthesise encrypted-blob virtual fields, so the option is accepted but
 * ignored. The signature exists so the UI layer can wire its toggle without
 * a second refactor when 2C lands.
 */
export type ResolvePacketOptions = {
  viewMode?: ViewMode;
};

/**
 * Registry of variable-length `toBits` functions, keyed by a `formula` token
 * that the Typst preset declares. Keeping these in code (rather than trying
 * to evaluate inline expressions in the Typst source) keeps the data file
 * declarative and the implementations testable.
 */
export const TO_BITS_REGISTRY: Record<string, (controlValue: number) => number> = {
  // (IHL - 5) 32-bit words = (IHL - 5) * 32 bits
  ihl_options: (ihl: number) => Math.max(0, (ihl - 5) * 32),
  // (Data Offset - 5) * 32 bits
  tcp_options: (off: number) => Math.max(0, (off - 5) * 32),
  // TLS extensions: byte-valued controller -> bits.
  tls_extensions: (n: number) => Math.max(0, n * 8),
};

/**
 * Registry of catalog entry field-list builders for TLV entries whose layout
 * depends on a count extra (e.g. Record Route address slots). Keyed by a
 * `fieldsFormula` token declared in the Typst catalog entry.
 */
export const TLV_FIELDS_REGISTRY: Record<
  string,
  (extras: Record<string, number>) => TlvCatalogField[]
> = {
  ipv4_record_route: ({ count }) => [
    { id: "type", name: "Type=7", bits: 8 },
    { id: "length", name: `Len=${3 + count * 4}`, bits: 8 },
    { id: "pointer", name: "Ptr", bits: 8 },
    ...Array.from({ length: count }, (_, i) => ({
      id: `addr${i}`,
      name: `Addr ${i + 1}`,
      bits: 32,
    })),
  ],
  ipv4_loose_source_route: ({ count }) => [
    { id: "type", name: "Type=131", bits: 8 },
    { id: "length", name: `Len=${3 + count * 4}`, bits: 8 },
    { id: "pointer", name: "Ptr", bits: 8 },
    ...Array.from({ length: count }, (_, i) => ({
      id: `addr${i}`,
      name: `Addr ${i + 1}`,
      bits: 32,
    })),
  ],
  ipv4_strict_source_route: ({ count }) => [
    { id: "type", name: "Type=137", bits: 8 },
    { id: "length", name: `Len=${3 + count * 4}`, bits: 8 },
    { id: "pointer", name: "Ptr", bits: 8 },
    ...Array.from({ length: count }, (_, i) => ({
      id: `addr${i}`,
      name: `Addr ${i + 1}`,
      bits: 32,
    })),
  ],
  ipv4_timestamp: ({ count }) => [
    { id: "type", name: "Type=68", bits: 8 },
    { id: "length", name: `Len=${4 + count * 4}`, bits: 8 },
    { id: "pointer", name: "Ptr", bits: 8 },
    { id: "oflwflg", name: "Oflw/Flg", bits: 8 },
    ...Array.from({ length: count }, (_, i) => ({
      id: `ts${i}`,
      name: `TS ${i + 1}`,
      bits: 32,
    })),
  ],
};

/**
 * Re-attach the `toBits` function for each variable-length field by looking
 * up the `formula` key (set in the Typst source) in TO_BITS_REGISTRY. Called
 * by the build-time generator and also exposed at runtime if needed.
 */
export function attachToBits(packet: Packet): Packet {
  for (const field of packet.fields) {
    if (!field.variable) continue;
    const formula = field.formula;
    if (!formula) {
      throw new Error(
        `packet-resolver: field "${field.id}" of "${packet.name}" is variable but has no formula.`,
      );
    }
    const fn = TO_BITS_REGISTRY[formula];
    if (!fn) {
      throw new Error(
        `packet-resolver: unknown variable-length formula "${formula}" on field "${field.id}".`,
      );
    }
    field.toBits = fn;
  }
  return packet;
}

/**
 * Validate packet structural invariants:
 *   - subfield bit sums must match parent's bit width;
 *   - subfields cannot appear on variable-length fields;
 *   - subfields cannot coexist with TLV containers;
 *   - TLV containers must have a non-empty catalog.
 */
export function validatePacket(packet: Packet): void {
  for (const field of packet.fields) {
    if (field.subfields) {
      if (field.variable) {
        throw new Error(
          `Packet "${packet.name}": field "${field.id}" is variable-length and cannot have subfields.`,
        );
      }
      if (field.tlv) {
        throw new Error(
          `Packet "${packet.name}": field "${field.id}" cannot have both subfields and a TLV container.`,
        );
      }
      const sum = field.subfields.reduce((acc, sf) => acc + sf.bits, 0);
      if (typeof field.bits !== "number" || sum !== field.bits) {
        throw new Error(
          `Packet "${packet.name}": subfields of "${field.id}" sum to ${sum} bits ` +
            `but parent declares ${field.bits ?? "?"} bits.`,
        );
      }
      for (const sf of field.subfields) {
        if (!Number.isInteger(sf.bits) || sf.bits <= 0) {
          throw new Error(
            `Packet "${packet.name}": subfield "${field.id}.${sf.id}" must have positive integer bits.`,
          );
        }
      }
    }
    if (field.tlv) {
      if (!Array.isArray(field.tlv.catalog) || field.tlv.catalog.length === 0) {
        throw new Error(
          `Packet "${packet.name}": field "${field.id}" has tlv but empty catalog.`,
        );
      }
    }
  }
}

function catalogFieldsFor(
  entry: TlvCatalogEntry,
  extras: Record<string, number>,
): TlvCatalogField[] {
  if (entry.fieldsFormula) {
    const fn = TLV_FIELDS_REGISTRY[entry.fieldsFormula];
    if (!fn) {
      throw new Error(
        `packet-resolver: unknown TLV fieldsFormula "${entry.fieldsFormula}".`,
      );
    }
    return fn(extras);
  }
  return entry.fields ?? [];
}

/**
 * Resolve the bit layout of a TLV field given its current instances. Mirrors
 * the legacy resolveTlv: produces { totalBits, blocks } with optional zero-
 * pad block trailing the last instance to reach `padToBoundary`.
 */
export function resolveTlv(
  field: Field,
  instances: TlvInstance[] | undefined,
): ResolvedTlv {
  if (!field || !field.tlv) return { totalBits: 0, blocks: [] };
  const blocks: TlvBlock[] = [];
  let totalBits = 0;
  const catalogByKind = new Map<number, TlvCatalogEntry>(
    field.tlv.catalog.map((c) => [c.kind, c]),
  );

  for (const inst of instances ?? []) {
    const entry = catalogByKind.get(inst.kind);
    if (!entry) continue;
    const extras: Record<string, number> = {
      ...(entry.defaultExtras ?? {}),
      ...(inst.extras ?? {}),
    };
    const blockFields = catalogFieldsFor(entry, extras);
    if (!blockFields || blockFields.length === 0) continue;
    const bits = blockFields.reduce((acc, f) => acc + f.bits, 0);
    blocks.push({
      kind: entry.kind,
      name: entry.name,
      bits,
      fields: blockFields,
      extras,
      description: entry.description ?? "",
      variableCount: entry.variableCount ?? null,
    });
    totalBits += bits;
  }

  const pad = field.tlv.padToBoundary ?? 0;
  if (pad > 0 && totalBits % pad !== 0) {
    const padBits = pad - (totalBits % pad);
    blocks.push({
      kind: null,
      name: "Padding",
      bits: padBits,
      fields: [{ id: "padding", name: "Padding", bits: padBits }],
      extras: {},
      description:
        "Zero-bit padding inserted to round the TLV block up to the required boundary.",
      isPadding: true,
    });
    totalBits += padBits;
  }
  return { totalBits, blocks };
}

/**
 * Compute the controller value driven by a TLV field's current instances.
 * e.g. for TCP options: ((20 + N) bytes header / 4) + base. Mirrors legacy
 * tlvControllerValue.
 */
export function tlvControllerValue(
  field: Field,
  instances: TlvInstance[] | undefined,
): number | null {
  if (!field || !field.tlv || !field.tlv.drivesController) return null;
  const { totalBits } = resolveTlv(field, instances);
  const bytes = Math.ceil(totalBits / 8);
  const unit = field.tlv.bytesPerUnit ?? 1;
  const base = field.tlv.baseControllerValue ?? 0;
  return base + Math.ceil(bytes / unit);
}

/**
 * Resolve a chain (IPv6 extension headers) into a sequence of additional
 * "virtual" fields to be laid out after the parent packet.
 */
export function resolveChain(packet: Packet): ChainBlock[] {
  const out: ChainBlock[] = [];
  for (const field of packet.fields) {
    if (!field.chainCatalog || !field.chainInstances) continue;
    const catalogByProto = new Map<number, NonNullable<Field["chainCatalog"]>[number]>(
      field.chainCatalog.map((c) => [c.proto, c]),
    );
    for (let i = 0; i < field.chainInstances.length; i++) {
      const inst = field.chainInstances[i];
      const entry = catalogByProto.get(inst.proto);
      if (!entry) continue;
      const bits = entry.fields.reduce((acc, f) => acc + f.bits, 0);
      out.push({
        chainOwnerFieldId: field.id,
        chainIndex: i,
        proto: entry.proto,
        name: entry.name,
        bits,
        fields: entry.fields,
        description: entry.description ?? "",
      });
    }
  }
  return out;
}

/** Compute initial controller state from each controller field's defaultValue,
 * then reconcile any TLV-driven controllers against the current instances so
 * the initial state is internally consistent.
 */
export function initialState(packet: Packet): ControllerState {
  const state: ControllerState = {};
  for (const field of packet.fields) {
    if (field.controlsLength) {
      state[field.controlsLength] = field.defaultValue ?? 0;
    }
  }
  syncTlvControllers(packet, state);
  return state;
}

/**
 * Recompute every TLV-driven controller. Mutates the given state and returns
 * it. Call after the user adds/removes/edits a TLV or chain instance so the
 * controller fields stay in sync with the new layout.
 */
export function syncTlvControllers(
  packet: Packet,
  state: ControllerState,
): ControllerState {
  for (const field of packet.fields) {
    if (field.tlv && field.tlv.drivesController) {
      const v = tlvControllerValue(field, field.tlv.instances ?? []);
      if (v != null) state[field.tlv.drivesController] = v;
    }
  }
  return state;
}

/**
 * Resolve a packet definition + controller state into a list of laid-out
 * cells. Subfield positions are computed relative to each parent segment.
 * TLV-bearing fields expand into virtual sub-fields with kind/length/value
 * cells per instance. Chain blocks are appended after the fixed header.
 */
export function resolvePacket(
  packet: Packet,
  state: ControllerState,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _options: ResolvePacketOptions = {},
): ResolvedLayout {
  validatePacket(packet);

  const cells: Cell[] = [];
  let bitPos = 0;

  for (const field of packet.fields) {
    // TLV expansion path.
    if (
      field.tlv &&
      Array.isArray(field.tlv.instances) &&
      field.tlv.instances.length > 0
    ) {
      const resolved = resolveTlv(field, field.tlv.instances);
      for (let bi = 0; bi < resolved.blocks.length; bi++) {
        const block = resolved.blocks[bi];
        const virtualField: Field = {
          id: `${field.id}#${bi}`,
          name: block.name,
          color: field.color,
          category: field.category,
          bits: block.bits,
          description: block.description,
          subfields: block.fields.map((sf) => ({
            id: sf.id,
            name: sf.name,
            bits: sf.bits,
            description: sf.description ?? "",
          })),
        };
        bitPos = emitField(packet, cells, virtualField, block.bits, bitPos);
      }
      continue;
    }

    let bits: number;
    if (field.variable) {
      if (!field.toBits || !field.lengthFrom) {
        throw new Error(
          `Packet "${packet.name}": variable field "${field.id}" is missing toBits/lengthFrom.`,
        );
      }
      const controlValue = state[field.lengthFrom] ?? 0;
      bits = field.toBits(controlValue);
    } else {
      if (typeof field.bits !== "number") {
        throw new Error(
          `Packet "${packet.name}": fixed field "${field.id}" has no bits.`,
        );
      }
      bits = field.bits;
    }
    if (bits === 0) continue;
    bitPos = emitField(packet, cells, field, bits, bitPos);
  }

  // Chain blocks (e.g. IPv6 extension headers) appended after the fixed header.
  const chainBlocks = resolveChain(packet);
  for (const block of chainBlocks) {
    const rem = bitPos % packet.rowBits;
    if (rem !== 0) bitPos += packet.rowBits - rem;
    const virtualField: Field = {
      id: `${block.chainOwnerFieldId}@chain#${block.chainIndex}`,
      name: block.name,
      color: "amber",
      category: "type",
      bits: block.bits,
      description: block.description,
      subfields: block.fields.map((sf) => ({
        id: sf.id,
        name: sf.name,
        bits: sf.bits,
      })),
    };
    bitPos = emitField(packet, cells, virtualField, block.bits, bitPos);
  }

  return { cells, totalBits: bitPos };
}

function emitField(
  packet: Packet,
  cells: Cell[],
  field: Field,
  bits: number,
  bitPos: number,
): number {
  let remaining = bits;
  let segmentIndex = 0;
  const totalSegments = computeSegmentCount(bitPos, bits, packet.rowBits);
  const parentSegments: Cell[] = [];

  while (remaining > 0) {
    const row = Math.floor(bitPos / packet.rowBits);
    const colInRow = bitPos % packet.rowBits;
    const take = Math.min(remaining, packet.rowBits - colInRow);
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
    cells.push(cell);
    parentSegments.push(cell);
    remaining -= take;
    bitPos += take;
    segmentIndex++;
  }

  if (field.subfields && field.subfields.length > 0) {
    let sfOffset = 0;
    for (const sf of field.subfields) {
      const sfStart = sfOffset;
      const sfEnd = sfOffset + sf.bits - 1;
      for (const seg of parentSegments) {
        const lo = Math.max(sfStart, seg.fieldStartOffset);
        const hi = Math.min(sfEnd, seg.fieldEndOffset);
        if (lo > hi) continue;
        const colStart = seg.startBit + (lo - seg.fieldStartOffset);
        const colEnd = seg.startBit + (hi - seg.fieldStartOffset);
        if (!seg.subCells) seg.subCells = [];
        const sub: SubCell = {
          parentField: field,
          subfield: sf as SubField,
          id: `${field.id}:${sf.id}`,
          startBit: colStart,
          endBit: colEnd,
          isFirst: lo === sfStart,
          isLast: hi === sfEnd,
          bitsTotal: sf.bits,
        };
        seg.subCells.push(sub);
      }
      sfOffset += sf.bits;
    }
  }
  return bitPos;
}

function computeSegmentCount(startPos: number, bits: number, rowBits: number): number {
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

/**
 * Resolve a TLV catalog entry's effective field list for a given instance.
 * Mirrors the legacy `fieldsFor(extras) ?? entry.fields` pattern.
 */
export function resolveTlvFields(
  entry: TlvCatalogEntry,
  inst: TlvInstance,
): TlvCatalogField[] {
  const extras = { ...(entry.defaultExtras || {}), ...(inst.extras || {}) };
  if (typeof entry.fieldsFor === "function") {
    return entry.fieldsFor(extras) || [];
  }
  return entry.fields || [];
}

/** Total bit width of one TLV record. */
export function tlvRecordBits(
  entry: TlvCatalogEntry,
  inst: TlvInstance,
): number {
  return resolveTlvFields(entry, inst).reduce((acc, f) => acc + f.bits, 0);
}

/** Total bit width of all instances + optional padding. */
export function tlvTotalBits(
  field: Field,
): { totalBits: number; paddedBits: number } {
  if (!field.tlv) return { totalBits: 0, paddedBits: 0 };
  const { catalog, instances, padToBoundary } = field.tlv;
  const byKind = new Map(catalog.map((c) => [c.kind, c]));
  let total = 0;
  for (const inst of instances) {
    const entry = byKind.get(inst.kind);
    if (!entry) continue;
    total += tlvRecordBits(entry, inst);
  }
  const padded =
    padToBoundary && padToBoundary > 0 && total % padToBoundary !== 0
      ? total + (padToBoundary - (total % padToBoundary))
      : total;
  return { totalBits: total, paddedBits: padded };
}

/** Categories present in the packet, in first-appearance order. */
export function packetCategories(packet: Packet): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const field of packet.fields) {
    if (field.category && !seen.has(field.category)) {
      seen.add(field.category);
      out.push(field.category);
    }
  }
  return out;
}
