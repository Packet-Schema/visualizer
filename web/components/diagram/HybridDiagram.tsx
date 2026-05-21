import { memo, useMemo, type CSSProperties } from "react";

import type {
  Cell,
  Field,
  Packet,
  ResolvedLayout,
  SubCell,
  SubField,
} from "@/lib/psml/renderer";
import { categoryColor } from "@/lib/render-tokens";

type Props = {
  packet: Packet;
  layout: ResolvedLayout;
  selectedFieldId: string | null;
  onFieldClick: (field: Field, element: HTMLElement) => void;
  onSubfieldClick: (
    parentField: Field,
    subfield: SubField,
    element: HTMLElement,
  ) => void;
  /** Optional hover sink (used by HexStrip for bidirectional highlight). */
  onFieldHover?: (fieldId: string | null) => void;
};

function formatBitsLabel(bits: number, field: Field): string {
  if (field.variable) return `${bits} bits (var)`;
  const bytes = bits / 8;
  return Number.isInteger(bytes) ? `${bits} bits / ${bytes}B` : `${bits} bits`;
}

/**
 * HybridDiagram replaces the SVG renderer with an HTML CSS Grid that produces
 * one row per layout row. Each row owns its own `<div role="row">` with the
 * grid template `repeat(rowBits, 1fr)`. Cells use `grid-column: span K` which
 * makes width transitions (IHL slider drag etc.) animate cleanly without
 * re-render churn.
 *
 * Subfield cells nest inside their parent cell using a child grid whose
 * column count matches the parent's bit span.
 */
export default function HybridDiagram({
  packet,
  layout,
  selectedFieldId,
  onFieldClick,
  onSubfieldClick,
  onFieldHover,
}: Props) {
  const rowBits = packet.rowBits;
  const rowsTotal = layout.cells.length
    ? Math.max(...layout.cells.map((c) => c.row)) + 1
    : 0;

  // Override-capable field ids, sourced from the renderer mirror (`packet`).
  // Layout cells carry a synthetic `field` built from NormalizedField, which
  // does NOT include `controlsLength` / `tlv` / `chainCatalog` — those flags
  // live on the original renderer mirror only. We look them up by base id
  // (stripping the `#repeatIndex` suffix Repeat expansion adds).
  // Build the set of base field ids whose cells should carry the override
  // marker. Two sources:
  //   1. Top-level Field / SubField with one of the override-metadata flags.
  //   2. Leaf ids that appear inside any TLV catalog entry — clicking those
  //      virtual cells opens the TLV-inner variant dropdown in OverridePanel.
  const overridableIds = useMemo(() => {
    const s = new Set<string>();
    for (const f of packet.fields) {
      if (
        f.controlsLength ||
        f.tlv ||
        f.chainCatalog ||
        f.switchCases ||
        f.varintEncoding ||
        f.isBerLength ||
        f.optionalGateFor ||
        f.enumVariants ||
        f.byteOrder
      ) {
        s.add(f.id);
      }
      for (const sf of f.subfields ?? []) {
        if (
          sf.switchCases ||
          sf.varintEncoding ||
          sf.isBerLength ||
          sf.optionalGateFor ||
          sf.enumVariants
        ) {
          s.add(sf.id);
        }
      }
      if (f.tlv) {
        for (const entry of f.tlv.catalog) {
          for (const lf of entry.fields ?? []) s.add(lf.id);
        }
      }
    }
    return s;
  }, [packet]);

  // Group cells by row for clean grid wrapping.
  const rows: Cell[][] = Array.from({ length: rowsTotal }, () => []);
  for (const cell of layout.cells) rows[cell.row].push(cell);

  const rowStyle: CSSProperties = {
    gridTemplateColumns: `repeat(${rowBits}, minmax(0, 1fr))`,
  };

  // Roving tabindex bookkeeping: only the first cell gets tabindex=0 at
  // mount. PacketViewer's keyboard handler rotates it as focus moves.
  let cellGlobalIndex = 0;

  return (
    <div
      role="grid"
      aria-label={`${packet.name} diagram`}
      aria-rowcount={rowsTotal}
      aria-colcount={rowBits}
      className="hybrid-diagram"
    >
      {rows.map((rowCells, rowIdx) => (
        <div
          key={`row-${rowIdx}`}
          role="row"
          aria-rowindex={rowIdx + 1}
          className={`hybrid-row${rowIdx % 2 === 0 ? " hybrid-row-even" : " hybrid-row-odd"}`}
          style={rowStyle}
        >
          {rowCells.map((cell) => {
            const tabIndex = cellGlobalIndex === 0 ? 0 : -1;
            cellGlobalIndex += 1;
            // Strip both the `#repeatIndex` suffix (legacy flat-Repeat
            // cells) and the `__inst_N` suffix (Group-collapsed TLV
            // instance cells) so the lookup against `overridableIds` lands
            // on the original TLV field's id.
            const idForLookup = cell.field.id;
            const baseId = idForLookup.includes("#")
              ? idForLookup.split("#")[0]
              : idForLookup
                  .replace(/__inst_\d+$/, "")
                  .replace(/__remaining$/, "");
            return (
              <FieldCell
                key={`cell-${cell.field.id}-${cell.segmentIndex}`}
                cell={cell}
                selectedFieldId={selectedFieldId}
                onFieldClick={onFieldClick}
                onSubfieldClick={onSubfieldClick}
                onFieldHover={onFieldHover}
                tabIndex={tabIndex}
                isOverridable={overridableIds.has(baseId)}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
HybridDiagram.displayName = "HybridDiagram";

type FieldCellProps = {
  cell: Cell;
  selectedFieldId: string | null;
  onFieldClick: (field: Field, element: HTMLElement) => void;
  onSubfieldClick: (
    parentField: Field,
    subfield: SubField,
    element: HTMLElement,
  ) => void;
  onFieldHover?: (fieldId: string | null) => void;
  tabIndex: number;
  /** True when the cell's logical parent exposes a runtime override
   *  (length controller, TLV catalog, or chain catalog). Drives the
   *  `data-overridable` marker dot. */
  isOverridable: boolean;
};

// Treat a selectedFieldId as "owned by this cell" when it matches the cell's
// field id exactly *or* it points at a subfield rendered inside this cell.
// Subfield ids look like `${parentField.id}:${subfield.name}` (see
// SubfieldRow.onClick below), so a prefix match against the same parent is
// enough to know we should re-render the cell.
function cellOwnsSelection(
  cellFieldId: string,
  selectedFieldId: string | null,
): boolean {
  if (selectedFieldId === null) return false;
  if (selectedFieldId === cellFieldId) return true;
  return selectedFieldId.startsWith(`${cellFieldId}:`);
}

const FieldCell = memo(FieldCellImpl, (prev, next) => {
  // Identity check is enough because `cell` comes from a useMemo (layout)
  // and the parent rebuilds it only when `controllers` / `packet` change.
  // We compare `selectedFieldId` separately because it changes on every
  // click but should only invalidate cells that go in/out of the selection.
  if (prev.cell !== next.cell) return false;
  if (prev.tabIndex !== next.tabIndex) return false;
  if (prev.onFieldClick !== next.onFieldClick) return false;
  if (prev.onSubfieldClick !== next.onSubfieldClick) return false;
  if (prev.onFieldHover !== next.onFieldHover) return false;
  if (prev.isOverridable !== next.isOverridable) return false;
  // Re-render only the cell that *was* selected (directly or via one of its
  // subfields) and the cell that *is now* selected — everything else can
  // skip. The subfield prefix match below is what fixes the bug where
  // clicking a `parent:sub` subfield didn't repaint the `.selected` class
  // on the SubfieldRow underneath an already-mounted parent FieldCell.
  const wasSelected = cellOwnsSelection(
    prev.cell.field.id,
    prev.selectedFieldId,
  );
  const isSelected = cellOwnsSelection(
    next.cell.field.id,
    next.selectedFieldId,
  );
  if (wasSelected !== isSelected) return false;
  // Both ends "own" the selection — re-render iff the selected subfield
  // within this cell actually changed (e.g. clicking from `parent:a` to
  // `parent:b`). When neither end owns it, the equality above already
  // returned `true` for "skip".
  return prev.selectedFieldId === next.selectedFieldId || !isSelected;
});

function FieldCellImpl({
  cell,
  selectedFieldId,
  onFieldClick,
  onSubfieldClick,
  onFieldHover,
  tabIndex,
  isOverridable,
}: FieldCellProps) {
  const isSelected = cell.field.id === selectedFieldId;
  const span = cell.endBit - cell.startBit + 1;
  const hasSubfields = !!cell.subCells && cell.subCells.length > 0;
  const variableNote = cell.field.variable ? ", variable-length" : "";
  const fill = categoryColor(cell.field);
  // Encryption-decoration props are written to the rendered cell on PSML 0.3
  // packets. Wire mode collapses to one `encrypted` block; semantic mode emits
  // child fields tagged with `encryptedParentId`. `headerProtected` is a
  // semantic-mode-only flag for QUIC's XOR'd packet-number bits.
  const isEncryptedBlock = cell.encrypted === true;
  const isEncryptedChild = !!cell.encryptedParentId;
  const isHeaderProtected = cell.headerProtected === true;
  const encryptionTitle = cell.encryptedContextNote ?? undefined;

  // CSS custom properties drive the cell's column span (animatable) and
  // category fill color. The span class also hands `--cell-span` to CSS in
  // case a downstream rule needs it.
  const style: CSSProperties = {
    gridColumn: `span ${span}`,
    ["--cell-fill" as string]: fill,
    ["--cell-span" as string]: String(span),
  };

  const className = [
    "cell field-cell",
    isSelected ? "selected" : "",
    cell.field.variable ? "variable" : "",
    cell.isFirst ? "" : "continuation",
    hasSubfields ? "has-subfields" : "",
    isEncryptedBlock ? "encrypted-block" : "",
    isEncryptedChild ? "encrypted-child" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const displayName = cell.field.variable
    ? `~${cell.field.name}`
    : cell.field.name;

  // We use a `<div role="button">` rather than a native `<button>` because
  // interactive nested content (subfield clickable spans) is invalid inside
  // <button>. Full keyboard semantics are preserved manually.
  return (
    <div
      role="gridcell"
      className={className}
      tabIndex={tabIndex}
      aria-label={`${cell.field.name}, ${cell.bitsTotal} bits${variableNote}${isSelected ? ", selected" : ""}${isEncryptedBlock || isEncryptedChild ? ", encrypted" : ""}${isHeaderProtected ? ", header-protected" : ""}`}
      aria-selected={isSelected}
      data-field-id={cell.field.id}
      data-row={cell.row}
      data-start-bit={cell.startBit}
      data-end-bit={cell.endBit}
      data-segment-index={cell.segmentIndex}
      data-category={cell.field.category ?? ""}
      {...(isEncryptedBlock ? { "data-encrypted": "true" } : {})}
      {...(isEncryptedChild ? { "data-encrypted-child": "true" } : {})}
      {...(isHeaderProtected ? { "data-header-protected": "true" } : {})}
      {...(isOverridable ? { "data-overridable": "true" } : {})}
      title={encryptionTitle}
      style={style}
      onClick={(e) => onFieldClick(cell.field, e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onFieldClick(cell.field, e.currentTarget);
        }
      }}
      onMouseOver={onFieldHover ? () => onFieldHover(cell.field.id) : undefined}
      onMouseOut={onFieldHover ? () => onFieldHover(null) : undefined}
      onFocus={onFieldHover ? () => onFieldHover(cell.field.id) : undefined}
      onBlur={onFieldHover ? () => onFieldHover(null) : undefined}
    >
      <span className="cell-body">
        {cell.isFirst ? (
          <>
            <span className="cell-name" title={displayName}>
              {displayName}
            </span>
            <span className="cell-sublabel">
              {formatBitsLabel(cell.bitsTotal, cell.field)}
            </span>
          </>
        ) : (
          <span className="cell-continuation" title={cell.field.name}>
            {`… ${displayName} (cont.)`}
          </span>
        )}
      </span>

      {isEncryptedBlock && cell.isFirst ? (
        <LockIcon
          size={14}
          className="field-lock-icon field-lock-icon--block"
          ariaHidden
        />
      ) : null}
      {isEncryptedChild && cell.isFirst ? (
        <LockIcon
          size={10}
          className="field-lock-icon field-lock-icon--child"
          ariaHidden
        />
      ) : null}
      {isHeaderProtected && cell.isFirst ? (
        <span
          className="field-hp-badge"
          aria-label="header-protected"
          title="Header-protected (XOR-masked under the encryption key)"
        >
          HP
        </span>
      ) : null}

      {hasSubfields ? (
        <SubfieldRow
          parent={cell.field}
          parentStartBit={cell.startBit}
          parentSpan={span}
          subCells={cell.subCells!}
          selectedFieldId={selectedFieldId}
          onSubfieldClick={onSubfieldClick}
          onFieldHover={onFieldHover}
        />
      ) : null}
    </div>
  );
}

/**
 * Inline lock SVG used to decorate encrypted cells. Two sizes:
 *   * 14px — wire-mode opaque block (visible against the stripe pattern)
 *   * 10px — semantic-mode child field (subtle corner badge)
 * Decorative-only; the parent cell already carries an accessible label.
 */
function LockIcon({
  size,
  className,
  ariaHidden,
}: {
  size: number;
  className?: string;
  ariaHidden?: boolean;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={ariaHidden ? "true" : undefined}
      focusable="false"
    >
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

type SubfieldRowProps = {
  parent: Field;
  parentStartBit: number;
  parentSpan: number;
  subCells: SubCell[];
  selectedFieldId: string | null;
  onSubfieldClick: (
    parentField: Field,
    subfield: SubField,
    element: HTMLElement,
  ) => void;
  onFieldHover?: (fieldId: string | null) => void;
};

function SubfieldRow({
  parent,
  parentStartBit,
  parentSpan,
  subCells,
  selectedFieldId,
  onSubfieldClick,
  onFieldHover,
}: SubfieldRowProps) {
  // Nested grid: parentSpan columns wide so subfield positions track the
  // parent geometry exactly.
  const style: CSSProperties = {
    gridTemplateColumns: `repeat(${parentSpan}, minmax(0, 1fr))`,
  };
  return (
    <span className="cell-subgrid" style={style} aria-hidden="false">
      {subCells.map((sub) => {
        const subSpan = sub.endBit - sub.startBit + 1;
        const startCol = sub.startBit - parentStartBit + 1;
        const isSubSelected = selectedFieldId === sub.id;
        const subStyle: CSSProperties = {
          gridColumn: `${startCol} / span ${subSpan}`,
        };
        return (
          <span
            key={`sub-${sub.id}`}
            role="button"
            tabIndex={-1}
            // .subfield-cell class kept so PacketViewer's roving keydown
            // handler can target it via querySelectorAll.
            className={`subfield-cell${isSubSelected ? " selected" : ""}${sub.isFirst ? "" : " continuation"}`}
            aria-label={`${sub.subfield.name} (subfield of ${parent.name}), ${sub.bitsTotal} bit${sub.bitsTotal === 1 ? "" : "s"}${isSubSelected ? ", selected" : ""}`}
            data-field-id={`${parent.id}:${sub.subfield.id}`}
            data-parent-field-id={parent.id}
            data-row={String(sub.startBit)}
            data-start-bit={sub.startBit}
            data-end-bit={sub.endBit}
            style={subStyle}
            onClick={(e) => {
              e.stopPropagation();
              onSubfieldClick(parent, sub.subfield, e.currentTarget);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onSubfieldClick(
                  parent,
                  sub.subfield,
                  e.currentTarget as HTMLElement,
                );
              }
            }}
            onMouseOver={
              onFieldHover
                ? (e) => {
                    e.stopPropagation();
                    onFieldHover(`${parent.id}:${sub.subfield.id}`);
                  }
                : undefined
            }
            onMouseOut={
              onFieldHover
                ? (e) => {
                    e.stopPropagation();
                    onFieldHover(null);
                  }
                : undefined
            }
          >
            {sub.isFirst ? (
              <span className="subfield-name" title={sub.subfield.name}>
                {sub.subfield.name}
              </span>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}
