"use client";

import { useMemo, type CSSProperties } from "react";

import type { Field, ResolvedLayout } from "@/lib/psml/renderer";
import { CATEGORY_TO_TOKEN, tokenToCssVar } from "@/lib/constants";

type Props = {
  layout: ResolvedLayout;
  rowBits: number;
  selectedFieldId: string | null;
  onByteHover: (fieldId: string | null) => void;
};

/** A single field owning some bits inside one byte. */
type ByteOwner = {
  /** The id used to match `data-field-id` on diagram cells. For subfields,
   *  this is `parentField.id:subfield.id`; for plain fields, just field.id. */
  fieldId: string;
  /** Display name used in the aria-label. */
  name: string;
  /** Color CSS value (var(--field-...)). */
  color: string;
  /** Bits this owner contributes within this byte (1..8). */
  bits: number;
};

/**
 * Resolve the color CSS value for a field, mirroring HybridDiagram's logic so
 * the strip and diagram stay visually in sync.
 */
function resolveFieldColor(field: Field): string {
  if (field.category && CATEGORY_TO_TOKEN[field.category]) {
    return tokenToCssVar(CATEGORY_TO_TOKEN[field.category]);
  }
  return tokenToCssVar(field.color);
}

/**
 * Walk the resolved layout and compute owners for every byte. Returns an
 * array of length `totalBytes` where each entry is the list of fields/subfields
 * that contribute bits to that byte (in MSB->LSB order within the byte).
 */
function computeByteOwners(
  layout: ResolvedLayout,
  rowBits: number,
): ByteOwner[][] {
  const totalBytes = Math.ceil(layout.totalBits / 8);
  const owners: ByteOwner[][] = Array.from({ length: totalBytes }, () => []);

  for (const cell of layout.cells) {
    const absStart = cell.row * rowBits + cell.startBit;
    const absEnd = cell.row * rowBits + cell.endBit;
    const color = resolveFieldColor(cell.field);

    // If a cell has subCells, prefer them for owner attribution so sub-byte
    // fields (Version 4 + IHL 4 in IPv4 byte 0) split the cell.
    if (cell.subCells && cell.subCells.length > 0) {
      for (const sub of cell.subCells) {
        const subAbsStart = cell.row * rowBits + sub.startBit;
        const subAbsEnd = cell.row * rowBits + sub.endBit;
        const subFieldId = `${cell.field.id}:${sub.subfield.id}`;
        const subName = `${cell.field.name} / ${sub.subfield.name}`;
        addRange(owners, subAbsStart, subAbsEnd, {
          fieldId: subFieldId,
          name: subName,
          color, // subfields inherit parent category color
        });
      }

      // Detect any bit gap within the parent cell that no subCell covers
      // (rare, but possible if subfield sums leave a hole). Fill with parent.
      const covered = new Set<number>();
      for (const sub of cell.subCells) {
        const subAbsStart = cell.row * rowBits + sub.startBit;
        const subAbsEnd = cell.row * rowBits + sub.endBit;
        for (let b = subAbsStart; b <= subAbsEnd; b++) covered.add(b);
      }
      for (let b = absStart; b <= absEnd; b++) {
        if (covered.has(b)) continue;
        addRange(owners, b, b, {
          fieldId: cell.field.id,
          name: cell.field.name,
          color,
        });
      }
    } else {
      addRange(owners, absStart, absEnd, {
        fieldId: cell.field.id,
        name: cell.field.name,
        color,
      });
    }
  }

  // Coalesce consecutive identical fieldIds within the same byte so the
  // gradient renders one slice per owner, not one per bit.
  return owners.map(coalesceByteOwners);
}

/**
 * Add an [absStart..absEnd] bit range as an owner, splitting across byte
 * boundaries. Each entry records the bit count contributed to that byte.
 */
function addRange(
  owners: ByteOwner[][],
  absStart: number,
  absEnd: number,
  base: Omit<ByteOwner, "bits">,
) {
  let pos = absStart;
  while (pos <= absEnd) {
    const byteIdx = Math.floor(pos / 8);
    const byteEnd = byteIdx * 8 + 7;
    const lastBit = Math.min(absEnd, byteEnd);
    const bits = lastBit - pos + 1;
    if (owners[byteIdx]) {
      owners[byteIdx].push({ ...base, bits });
    }
    pos = lastBit + 1;
  }
}

/** Merge adjacent owners with the same fieldId in a single byte. */
function coalesceByteOwners(byte: ByteOwner[]): ByteOwner[] {
  if (byte.length <= 1) return byte;
  const out: ByteOwner[] = [];
  for (const o of byte) {
    const prev = out[out.length - 1];
    if (prev && prev.fieldId === o.fieldId) {
      prev.bits += o.bits;
    } else {
      out.push({ ...o });
    }
  }
  return out;
}

/**
 * Build a `linear-gradient(...)` background for a multi-owner byte. The
 * gradient is horizontal; each segment width is `bits/8 * 100%`. We use
 * hard color stops (no blend) so each owner's slice reads as a flat color.
 */
function gradientFor(owners: ByteOwner[]): string {
  if (owners.length === 1) return owners[0].color;
  const stops: string[] = [];
  let pct = 0;
  for (const o of owners) {
    const next = pct + (o.bits / 8) * 100;
    stops.push(`${o.color} ${pct}%`, `${o.color} ${next}%`);
    pct = next;
  }
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

/**
 * HexStrip — a horizontal byte strip beneath the diagram. Each byte is a
 * monospace `00` cell, coloured to match the field that owns it (sub-byte
 * fields produce a split gradient). Hover synchronises with the diagram via
 * a `data-highlighted-field` attribute on the diagram root, set by
 * PacketViewer in response to onByteHover.
 *
 * Print mode hides the strip via `@media print` in globals.css.
 */
export default function HexStrip({
  layout,
  rowBits,
  selectedFieldId,
  onByteHover,
}: Props) {
  const byteOwners = useMemo(
    () => computeByteOwners(layout, rowBits),
    [layout, rowBits],
  );

  if (byteOwners.length === 0) return null;

  return (
    <div
      className="hex-strip mt-3"
      role="group"
      aria-label="Header bytes (placeholder values)"
    >
      <div
        className="hex-strip-label text-[11px] uppercase tracking-wider font-bold mb-1.5"
        style={{ color: "var(--fg-muted)" }}
      >
        Bytes ({byteOwners.length})
      </div>
      <div className="hex-strip-row flex flex-wrap gap-[3px]">
        {byteOwners.map((owners, byteIdx) => {
          if (owners.length === 0) return null;
          // Pick the dominant (largest bit-count) owner for hover-sync. If
          // multiple owners have the same width we use the first (highest bits
          // in big-endian, i.e. MSB-side).
          const dominant = owners.reduce((a, b) => (b.bits > a.bits ? b : a));
          const ariaName =
            owners.length === 1
              ? owners[0].name
              : owners.map((o) => o.name).join(" & ");
          const isSelected =
            selectedFieldId !== null &&
            owners.some((o) => o.fieldId === selectedFieldId);
          const style: CSSProperties = {
            background: gradientFor(owners),
          };
          return (
            <button
              key={`hex-${byteIdx}`}
              type="button"
              className={`hex-byte${isSelected ? " selected" : ""}`}
              data-byte-index={byteIdx}
              data-field-id={dominant.fieldId}
              aria-label={`Byte ${byteIdx}, ${ariaName}`}
              style={style}
              onMouseOver={() => onByteHover(dominant.fieldId)}
              onMouseOut={() => onByteHover(null)}
              onFocus={() => onByteHover(dominant.fieldId)}
              onBlur={() => onByteHover(null)}
              tabIndex={0}
            >
              <span className="hex-byte-text">00</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
