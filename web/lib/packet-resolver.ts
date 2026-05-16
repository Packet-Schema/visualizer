// Port of resolvePacket / initialState / validatePacket from the legacy
// packets.js to TypeScript. Algorithm is unchanged: deterministic bit-by-bit
// layout that produces row-segmented cells with subfields positioned in the
// lower half of their parent.
//
// TLV expansion + IPv6 chain support are deliberately deferred to Wave 2.

import type {
  Cell,
  ControllerState,
  Field,
  Packet,
  ResolvedLayout,
  SubCell,
  SubField,
} from "./types";

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
};

/**
 * Re-attach the `toBits` function for each variable-length field by looking
 * up the `formula` key (set in the Typst source) in TO_BITS_REGISTRY. Called
 * by the build-time generator and also exposed at runtime if needed.
 */
export function attachToBits(packet: Packet): Packet {
  for (const field of packet.fields) {
    if (!field.variable) continue;
    const formula = (field as Field & { formula?: string }).formula;
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
 * Validate packet structural invariants. Currently:
 *   - subfield bit sums must match parent's bit width;
 *   - subfields cannot appear on variable-length fields.
 */
export function validatePacket(packet: Packet): void {
  for (const field of packet.fields) {
    if (field.subfields) {
      if (field.variable) {
        throw new Error(
          `Packet "${packet.name}": field "${field.id}" is variable-length and cannot have subfields.`,
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
  }
}

/** Compute initial controller state from each controller field's defaultValue. */
export function initialState(packet: Packet): ControllerState {
  const state: ControllerState = {};
  for (const field of packet.fields) {
    if (field.controlsLength) {
      state[field.controlsLength] = field.defaultValue ?? 0;
    }
  }
  return state;
}

/**
 * Resolve a packet definition + controller state into a list of laid-out
 * cells. Subfield positions are computed relative to each parent segment.
 */
export function resolvePacket(packet: Packet, state: ControllerState): ResolvedLayout {
  validatePacket(packet);

  const cells: Cell[] = [];
  let bitPos = 0;

  for (const field of packet.fields) {
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
